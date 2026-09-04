/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { createRpcProxy, type TransferDiagnostic, type TransferElement } from '@hydranium/protocol';
import {
   DATA_CLIENT_PROTOCOL_METHODS,
   DATA_SERVER_WIRE_PREFIX,
   type DataClientProtocol,
   type DataServerProtocol
} from '@hydranium/protocol/data';
import { type ChildProcess, spawn } from 'node:child_process';
import { StreamMessageReader, StreamMessageWriter, createMessageConnection, type MessageConnection } from 'vscode-jsonrpc/node';

/**
 * Options for {@link spawnDataServer}. `command` is the binary or script
 * path; `args` are the command-line arguments passed to it. The adopter's
 * server is expected to bootstrap a `DataServer` against the supplied
 * MessageConnection and call `connection.listen()` so its stdin/stdout
 * carry the JSON-RPC stream.
 *
 * `shutdown()` disposes the JSON-RPC connection and waits for the child
 * to exit with a configurable timeout. Subcommands that take a SIGINT
 * (e.g. `watch`) call shutdown on the cleanup path so the child doesn't
 * stay orphaned.
 */
export interface SpawnDataServerOptions {
   readonly command: string;
   readonly args?: readonly string[];
   /**
    * Working directory for the spawned child. Default: current cwd.
    * Useful when the child resolves model files relative to a workspace
    * root that differs from where the CLI was invoked.
    */
   readonly cwd?: string;
   /**
    * Additional environment variables for the child. Merged on top of
    * `process.env`. Default: no overrides.
    */
   readonly env?: Readonly<Record<string, string | undefined>>;
   /**
    * Where to pipe the child's stderr. Default: inherited from the
    * parent (visible to the user). Set to `'ignore'` for quiet
    * scripted use; set to `'pipe'` to capture for assertion in tests.
    */
   readonly stderr?: 'inherit' | 'ignore' | 'pipe';
}

/**
 * Lifecycle handle for a spawned data-server. Owns the child process,
 * the JSON-RPC connection, and the typed protocol proxy. Always pair
 * {@link spawnDataServer} with {@link DataServerHandle.shutdown} (in a
 * `try`/`finally` or equivalent) so the child doesn't outlive the CLI
 * invocation.
 */
export interface DataServerHandle<TTransfer extends TransferElement, TDiagnostic extends TransferDiagnostic = TransferDiagnostic> {
   /** Typed server proxy — the consumer-facing surface for protocol calls. */
   readonly server: DataServerProtocol<TTransfer, TDiagnostic>;
   /** Raw child process — for stderr piping in tests; do not write to stdin/stdout directly. */
   readonly child: ChildProcess;
   /** vscode-jsonrpc connection — for callers wanting fine-grained lifecycle control. */
   readonly connection: MessageConnection;
   /**
    * Rejects when the child fails to start (e.g. `ENOENT` for a missing
    * command) or exits before {@link DataServerHandle.shutdown} is
    * requested — i.e. a premature death that would otherwise leave an
    * in-flight RPC hanging forever. Never resolves. Race a protocol call
    * against it (see {@link withDataServer}) to fail fast with a clear
    * message instead of hanging or crashing on an unhandled `'error'`
    * event. Always internally handled, so ignoring it never triggers an
    * unhandled-rejection crash.
    */
   readonly whenTerminated: Promise<never>;
   /**
    * Tear down the connection + wait for the child to exit. Resolves
    * once the child has terminated (gracefully or via SIGTERM). Safe
    * to call multiple times.
    */
   shutdown(timeoutMs?: number): Promise<void>;
}

/**
 * Spawn a data-server subprocess and wire a typed proxy over its
 * stdio JSON-RPC. The function returns once the connection is
 * listening; protocol calls are queued behind the underlying
 * MessageConnection's ordering guarantees.
 *
 * Supplying `localClient` registers its `DataClientProtocol` methods as
 * inbound-notification handlers on the connection — the data-server's
 * `data-server/onDocumentUpdated` notifications dispatch to
 * `localClient.onDocumentUpdated`. Subcommands like `watch` use this to
 * stream events; subcommands like `projects` / `query` / `save` pass
 * no localClient.
 */
export function spawnDataServer<TTransfer extends TransferElement, TDiagnostic extends TransferDiagnostic = TransferDiagnostic>(
   options: SpawnDataServerOptions,
   localClient?: DataClientProtocol<TTransfer, TDiagnostic>
): DataServerHandle<TTransfer, TDiagnostic> {
   const child = spawn(options.command, [...(options.args ?? [])], {
      cwd: options.cwd,
      env: options.env ? { ...process.env, ...options.env } : process.env,
      stdio: ['pipe', 'pipe', options.stderr ?? 'inherit']
   });

   if (!child.stdin || !child.stdout) {
      // Mirrors the synchronous failure-to-create-pipes case Node surfaces
      // when stdio isn't 'pipe' on either end. We always request 'pipe'
      // for stdin/stdout, so this is defensive only.
      //
      // Worded for whoever passed the command, not for whoever wrote this
      // function: the reachable way to arrive here is a `--server` value that
      // does not start, and naming the internal spawner told that reader
      // nothing they could act on.
      child.kill();
      throw new Error(
         `Could not start the data server: the command '${options.command}' provided no stdin/stdout pipe. ` +
            'Check that --server names a runnable command, and that its own entry path resolves from --cwd.'
      );
   }

   // Guard stdin against writes that flush after the child has died (spawn failure
   // or a premature exit). vscode-jsonrpc queues a message write on `setImmediate`;
   // if the child's stdin is destroyed by the time it flushes, Node's `write` errors
   // and vscode-jsonrpc orphans that write-queue rejection (it surfaces transport
   // errors only via `onError`, which we consume separately) — an unhandled
   // rejection. Reporting the destroyed write as a silent success drops the doomed
   // message; the child's death is already reported cleanly via `whenTerminated`.
   const stdin = child.stdin;
   const originalWrite = stdin.write.bind(stdin) as (...writeArgs: unknown[]) => boolean;
   stdin.write = ((...writeArgs: unknown[]): boolean => {
      if (!stdin.destroyed) {
         return originalWrite(...writeArgs);
      }
      const callback = writeArgs.find((arg): arg is (error?: Error | null) => void => typeof arg === 'function');
      callback?.(null);
      return true;
   }) as typeof stdin.write;

   const reader = new StreamMessageReader(child.stdout);
   const writer = new StreamMessageWriter(child.stdin);
   const connection = createMessageConnection(reader, writer);
   // Consume transport error / close so a child that dies mid-stream (its stdout
   // closing, a write landing on a torn-down stdin) is observed here rather than
   // escaping as an unhandled error — the death is reported via `whenTerminated`.
   connection.onError(() => undefined);
   connection.onClose(() => undefined);
   connection.listen();

   // One typed proxy over the data-server protocol; when a `localClient` is
   // supplied its `on*` notification handlers are bound inbound on the same
   // connection (skipped when absent — subcommands like `projects`/`query`).
   const server = createRpcProxy<DataServerProtocol<TTransfer, TDiagnostic>, DataClientProtocol<TTransfer, TDiagnostic>>(connection, {
      methodNamespace: DATA_SERVER_WIRE_PREFIX,
      localTarget: localClient,
      localMethods: DATA_CLIENT_PROTOCOL_METHODS
   });

   // A premature child death (spawn `ENOENT`, a crash, or an exit before we asked
   // for one) rejects `whenTerminated` so a racing RPC fails fast instead of
   // hanging on a request that can never be answered. `terminating` gates it so an
   // expected `shutdown()` exit does NOT reject. The `void .catch` guarantees the
   // promise is always handled — an ignored failure can never crash the process
   // with an unhandled 'error' event / rejection.
   let terminating = false;
   const whenTerminated = new Promise<never>((_, reject) => {
      child.once('error', error => {
         if (!terminating) {
            reject(new Error(`data-server process failed to start (command='${options.command}'): ${error.message}`));
         }
      });
      child.once('exit', (code, signal) => {
         if (!terminating) {
            reject(
               new Error(
                  `data-server process exited before the request completed ` +
                     `(command='${options.command}', code=${code ?? 'null'}, signal=${signal ?? 'null'}).`
               )
            );
         }
      });
   });
   void whenTerminated.catch(() => undefined);

   let shutdownPromise: Promise<void> | undefined;
   const shutdown = (timeoutMs = 5_000): Promise<void> => {
      if (shutdownPromise) {
         return shutdownPromise;
      }
      terminating = true;
      shutdownPromise = new Promise<void>(resolve => {
         const finalize = (): void => {
            connection.dispose();
            resolve();
         };
         if (child.exitCode !== null || child.signalCode !== null) {
            finalize();
            return;
         }
         const onExit = (): void => {
            clearTimeout(killTimer);
            finalize();
         };
         child.once('exit', onExit);
         // Polite exit first — most servers handle SIGTERM by closing
         // their JSON-RPC connection and returning from `connection.listen()`.
         child.kill('SIGTERM');
         const killTimer = setTimeout(() => {
            child.kill('SIGKILL');
         }, timeoutMs);
      });
      return shutdownPromise;
   };

   return { server, child, connection, whenTerminated, shutdown };
}

/**
 * Spawn a data-server, run `use` against its typed proxy, and always shut the
 * child down afterwards. The `use` call is raced against
 * {@link DataServerHandle.whenTerminated}, so a spawn failure or a premature child
 * exit rejects with a clear message instead of hanging on an RPC that can never be
 * answered. This is the one-shot counterpart the `projects` / `query` / `save`
 * subcommands compose; `watch` races its own long-running loop against
 * `whenTerminated` directly.
 */
export async function withDataServer<TTransfer extends TransferElement, TDiagnostic extends TransferDiagnostic, R>(
   options: SpawnDataServerOptions,
   use: (server: DataServerProtocol<TTransfer, TDiagnostic>, handle: DataServerHandle<TTransfer, TDiagnostic>) => Promise<R>,
   localClient?: DataClientProtocol<TTransfer, TDiagnostic>
): Promise<R> {
   const handle = spawnDataServer<TTransfer, TDiagnostic>(options, localClient);
   const usePromise = use(handle.server, handle);
   // Defensively handle `usePromise` so that if `whenTerminated` wins the race
   // (the child died), the losing in-flight RPC's later rejection — e.g. a write to
   // the now-destroyed stdin — does not surface as an unhandled rejection.
   void usePromise.catch(() => undefined);
   try {
      return await Promise.race([usePromise, handle.whenTerminated]);
   } finally {
      await handle.shutdown();
   }
}
