/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import type { LogThreshold, TransferElement } from '@hydranium/protocol';
import type { DataClientProtocol, DataServerProtocol, TransferDocumentUpdatedEvent } from '@hydranium/protocol/data';
import { logLevelEnv } from '../log-level.js';
import { spawnDataServer } from '../spawn-data-server.js';

/**
 * Options for the {@link runWatch} subcommand. Subscribes to document
 * updates at `uri` and writes each event as one JSON line. Long-running
 * — exits on SIGINT (Ctrl-C) or when `signal` aborts. Each event is
 * line-flushable for `jq` / `tee` pipelines.
 *
 * `clientId` defaults to `'hydranium-cli'`. `signal` is the test seam
 * — production CLI wires SIGINT directly. `__handleForTest` bypasses
 * the spawn step for unit tests.
 */
export interface WatchCommandOptions {
   readonly serverCommand: string;
   readonly serverArgs?: readonly string[];
   readonly cwd?: string;
   /** Log threshold for the spawned server, set on its `HYDRANIUM_LOG_LEVEL` env. */
   readonly logLevel?: LogThreshold;
   readonly uri: string;
   readonly clientId?: string;
   readonly write?: (line: string) => void;
   /**
    * AbortSignal that cancels the subscription loop. Production wires
    * SIGINT via {@link wireSigintAbort}; tests pass a controlled signal
    * to assert deterministic teardown.
    */
   readonly signal?: AbortSignal;
   /**
    * Test-only injection — supplies the typed server proxy along with a
    * "fire event" hook that runWatch calls during construction to wire
    * its local client. Production CLI never passes this; subcommand
    * unit tests do.
    */
   readonly __handleForTest?: WatchTestHandle;
}

/**
 * Test seam for {@link runWatch}. Wraps the bits of `DataServerHandle`
 * the watch loop actually uses — the typed server proxy plus a
 * `bindClient` hook the test fixture uses to capture the local
 * `DataClientProtocol` so it can fire events at it.
 */
export interface WatchTestHandle {
   readonly server: Pick<DataServerProtocol<TransferElement>, 'watchModelDocument' | 'unwatchModelDocument'>;
   /**
    * Called once during {@link runWatch} startup with the watch loop's
    * local {@link DataClientProtocol}. Test fixtures stash the reference
    * and invoke `client.onDocumentUpdated(event)` to simulate the
    * data-server's notification.
    */
   bindClient(client: DataClientProtocol<TransferElement>): void;
   /** Mirror of `DataServerHandle.shutdown` — tests can stub as a no-op. */
   shutdown(timeoutMs?: number): Promise<void>;
   /**
    * Mirror of `DataServerHandle.whenTerminated`. Omit it for a fixture with no
    * child to lose; supply it to drive the premature-death race, which is the
    * only way a test reaches {@link runWatch}'s shutdown filtering.
    */
   readonly whenTerminated?: Promise<never>;
}

/**
 * Wait for the handle's premature-death rejection, and swallow it once the watch
 * is being torn down.
 *
 * `watch` ends on SIGINT, which a shell delivers to the whole process group, so
 * the child dies of the same keystroke. Its `unwatchModelDocument` round trip can
 * then never be answered, leaving the loop pending and the child's exit the only
 * settled outcome — so unfiltered, every clean Ctrl-C is reported as
 * `exited before the request completed (… signal=SIGINT)`. Resolving instead
 * also settles the race the loop can no longer settle.
 *
 * The check waits a turn of the event loop rather than reading `aborted` in the
 * rejection's own turn: the child's death and this process's own SIGINT are
 * delivered together and their order is the kernel's to choose. A genuine
 * mid-watch crash pays that one turn before it is reported.
 */
async function resolveOnceShuttingDown(whenTerminated: Promise<never> | undefined, signal: AbortSignal | undefined): Promise<void> {
   if (!whenTerminated) {
      return new Promise<void>(() => undefined);
   }
   try {
      await whenTerminated;
   } catch (err: unknown) {
      await new Promise<void>(resolve => setTimeout(resolve, 0));
      if (signal?.aborted) {
         return;
      }
      throw err;
   }
}

/**
 * Wire SIGINT to abort the given controller. Returns a function that
 * un-wires the listener — call it once the subcommand exits so future
 * SIGINTs don't trigger an already-aborted controller.
 */
export function wireSigintAbort(controller: AbortController): () => void {
   const handler = (): void => controller.abort();
   process.once('SIGINT', handler);
   return () => process.removeListener('SIGINT', handler);
}

export async function runWatch(options: WatchCommandOptions): Promise<void> {
   const write = options.write ?? ((line: string) => process.stdout.write(line));
   const clientId = options.clientId ?? 'hydranium-cli';

   // Local client: filters by URI (so multiple watchers on the same wire
   // don't cross-pollinate) and writes each event as one JSON line.
   // `onProjectsChanged` and `onDocumentSaved` are no-ops here — `watch`
   // streams build-phase update events. Project lifecycle and persistence
   // events are out of band for the CLI's per-URI update view.
   const localClient: DataClientProtocol<TransferElement> = {
      onDocumentUpdated(event: TransferDocumentUpdatedEvent<TransferElement>): void {
         if (event.document.uri !== options.uri) {
            return;
         }
         write(`${JSON.stringify(event)}\n`);
      },
      onDocumentSaved(): void {
         // Persistence is out of band for the per-URI update view.
      },
      onProjectsChanged(): void {
         // Project lifecycle is out of band for the per-URI update view.
      }
   };

   // One body for both paths: a test handle that returned before the race would
   // leave the premature-death branch it stands in for uncoverable.
   const handle =
      options.__handleForTest ??
      spawnDataServer<TransferElement>(
         {
            command: options.serverCommand,
            args: options.serverArgs,
            cwd: options.cwd,
            env: options.logLevel ? logLevelEnv(options.logLevel) : undefined
         },
         localClient
      );
   options.__handleForTest?.bindClient(localClient);
   try {
      // Race the subscription loop against the child's premature death so a mid-watch
      // server crash exits with a clear message instead of hanging until Ctrl-C. Guard
      // the loop's late rejection (an unwatch write to a dead stream) so it does not
      // surface as an unhandled rejection when the death wins the race.
      const loop = runWatchOnce(handle.server, options.uri, clientId, options.signal);
      void loop.catch(() => undefined);
      await Promise.race([loop, resolveOnceShuttingDown(handle.whenTerminated, options.signal)]);
   } finally {
      await handle.shutdown();
   }
}

async function runWatchOnce(
   server: Pick<DataServerProtocol<TransferElement>, 'watchModelDocument' | 'unwatchModelDocument'>,
   uri: string,
   clientId: string,
   signal: AbortSignal | undefined
): Promise<void> {
   await server.watchModelDocument({ uri, clientId });
   try {
      await new Promise<void>(resolve => {
         if (signal?.aborted) {
            resolve();
            return;
         }
         signal?.addEventListener('abort', () => resolve(), { once: true });
      });
   } finally {
      await server.unwatchModelDocument({ uri, clientId });
   }
}
