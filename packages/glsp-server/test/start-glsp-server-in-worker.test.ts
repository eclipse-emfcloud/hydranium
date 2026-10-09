/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * Launch-surface coverage for `startGlspServerInWorker` — the browser analogue
 * of `examples/order-flow/server`'s `test/smoke/glsp-socket.test.ts`.
 *
 * **`makeGlspHarness` cannot cover this and is not meant to.** It binds
 * `GLSPClientProxy` to a capturing stub and composes one container, so no
 * transport exists: the launcher, the connection it builds on the given port and
 * `configureClientConnection`'s `listen()` are reachable only by starting a real
 * head and talking to it over a real port.
 *
 * **It runs headless, without a browser**, which is the point — the whole
 * browser-only surface would otherwise be covered by nothing inside
 * `npm run check`. Node's `worker_threads` `MessagePort` satisfies
 * `createMessagePortTransport`: it has `addEventListener` and `start`, and like
 * a browser's port it clones and keeps order. Neither end calls `close()` on
 * its port before a test's teardown: Node's port would report that, and a
 * browser's reports nothing. The one thing Node's main thread lacks is a
 * global `postMessage`, which `WorkerServerLauncher.run` calls unconditionally
 * — so the tests install one, and that stub is also the observation point for
 * the startup-string test below.
 */

import {
   JsonrpcGLSPClient,
   ServerModule,
   WORKER_START_UP_COMPLETE_MSG,
   WorkerServerLauncher,
   type WorkerLaunchOptions
} from '@eclipse-glsp/server/browser.js';
import { ContainerModule, injectable } from 'inversify';
import { createMessageConnection } from 'vscode-jsonrpc/browser';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { IntegratedServer } from '@hydranium/core';
import { createMessagePortTransport, sendByMethodName, type TransferredMessagePort } from '@hydranium/protocol';
import { waitFor } from '@hydranium/protocol/testing';
import { makeMessagePortPair, type MessagePortPair } from '@hydranium/protocol/testing/node';
import { HydraniumGlspWorkerServerLauncher, startGlspServerInWorker } from '../src/browser/index.js';
import { makeCapturingGlspLogger, makeNoopGlspLogger, type CapturingGlspLogger } from '../src/testing/index.js';

/**
 * The global `postMessage` the launcher calls, and what it was handed.
 *
 * Installed on `globalThis` rather than mocked at the module boundary because
 * that is exactly the seam under test: the launcher reaches the GLOBAL, not the
 * port, and the test's job is to prove the two streams stay separate.
 */
interface GlobalPostMessageStub {
   readonly posted: unknown[];
   restore(): void;
}

/**
 * The global as this stub needs to see it: `postMessage` OPTIONAL.
 *
 * `@types/node` declares it as required on `globalThis` (it exists in a worker
 * thread), and intersecting a required member with an optional one keeps it
 * required — which makes `delete` a type error. Naming the shape separately is
 * what lets the stub be removed again rather than left installed for the rest of
 * the run.
 */
type GlobalWithPostMessage = { postMessage?: (message: unknown) => void };

function stubGlobalPostMessage(): GlobalPostMessageStub {
   const target = globalThis as unknown as GlobalWithPostMessage;
   const original = target.postMessage;
   const posted: unknown[] = [];
   target.postMessage = (message: unknown) => {
      posted.push(message);
   };
   return {
      posted,
      restore: () => {
         if (original === undefined) {
            delete target.postMessage;
         } else {
            target.postMessage = original;
         }
      }
   };
}

/** A connection typed by GLSP's copy of `vscode-jsonrpc`, whose message types it sends. */
type GlspConnection = ReturnType<WorkerServerLauncher['createConnection']>;

@injectable()
class AdopterLauncher extends HydraniumGlspWorkerServerLauncher {}

/** The launcher's connection for one port, as GLSP's `start` builds it. */
class ConnectingLauncher extends HydraniumGlspWorkerServerLauncher {
   constructor() {
      super();
      this.logger = makeNoopGlspLogger();
   }

   connect(context: TransferredMessagePort): GlspConnection {
      return this.createConnection({ context } as unknown as WorkerLaunchOptions);
   }
}

/** A module recording the launcher a head resolves, under GLSP's token or bypassing it. */
function observeLauncher(resolved: WorkerServerLauncher[]): ContainerModule {
   return new ContainerModule((_bind, _unbind, _isBound, _rebind, _unbindAsync, onActivation) => {
      for (const id of [WorkerServerLauncher, HydraniumGlspWorkerServerLauncher]) {
         onActivation<WorkerServerLauncher>(id, (_context, launcher) => {
            resolved.push(launcher);
            return launcher;
         });
      }
   });
}

describe('startGlspServerInWorker', () => {
   let ports: MessagePortPair;
   let globalPostMessage: GlobalPostMessageStub;
   let capturing: CapturingGlspLogger;
   let clientConnection: GlspConnection | undefined;
   let server: IntegratedServer | undefined;

   beforeEach(() => {
      ports = makeMessagePortPair();
      globalPostMessage = stubGlobalPostMessage();
      capturing = makeCapturingGlspLogger();
   });

   afterEach(() => {
      clientConnection?.dispose();
      clientConnection = undefined;
      server = undefined;
      globalPostMessage.restore();
      ports.dispose();
   });

   /** Start a head on `port2` and return a client connection on `port1`. */
   function startHeadAndConnect(appModules: ContainerModule[] = []): GlspConnection {
      server = startGlspServerInWorker({
         context: ports.port2,
         createLogger: () => capturing.logger,
         serverModule: new ServerModule(),
         appModules
      });
      // The page's end speaks the same transport as the head's, so a dispose
      // here reaches the head as a close.
      const transport = createMessagePortTransport(ports.port1);
      // The page's end sends GLSP's typed messages, as GLSP's client does.
      const connection: GlspConnection = sendByMethodName(createMessageConnection(transport.reader, transport.writer));
      connection.listen();
      clientConnection = connection;
      return connection;
   }

   it('answers GLSP initialize over the transferred port', async () => {
      const connection = startHeadAndConnect();

      const result = await connection.sendRequest(JsonrpcGLSPClient.InitializeRequest, {
         applicationId: 'test-app',
         protocolVersion: '1.0.0'
      });

      // The response is the whole claim: it can only exist if the app container
      // composed, the launcher resolved and configured the `ServerModule`, and
      // `configureClientConnection` registered the handler AND called `listen()`
      // on a connection built over the port this test passed in.
      expect(result.protocolVersion).toBe('1.0.0');
   });

   it('resolves started once the launcher has built its connection', async () => {
      startHeadAndConnect();

      // `started` is not merely `Promise.resolve()` — the launcher's connection
      // is checked to exist first, so this also asserts that upstream still
      // builds it synchronously. If `run` ever awaits before constructing it,
      // this rejects with a message naming the assumption instead of leaving a
      // head that resolves ready and cannot answer.
      await expect(server?.started).resolves.toBeUndefined();
   });

   it('posts the launcher startup string on the global and nothing on the port', async () => {
      const connection = startHeadAndConnect();
      const fromPort: unknown[] = [];
      // Alongside the reader rather than instead of it: the transport already
      // started the port, and both listeners see every inbound message.
      ports.port1.addEventListener('message', event => fromPort.push((event as { readonly data: unknown }).data));

      await connection.sendRequest(JsonrpcGLSPClient.InitializeRequest, {
         applicationId: 'test-app',
         protocolVersion: '1.0.0'
      });

      // The reason no head may bind the worker global, asserted rather than
      // argued: the launcher's readiness signal is a bare string that no
      // JSON-RPC reader can parse, and it goes to the global unconditionally.
      expect(globalPostMessage.posted).toEqual([WORKER_START_UP_COMPLETE_MSG]);
      // And the port carries only JSON-RPC. A single non-object here would mean
      // the two streams had merged.
      expect(fromPort.length).toBeGreaterThan(0);
      expect(fromPort.every(message => typeof message === 'object' && message !== null)).toBe(true);
   });

   it('routes GLSP framework logs through the adopter logger', async () => {
      const connection = startHeadAndConnect();
      await connection.sendRequest(JsonrpcGLSPClient.InitializeRequest, {
         applicationId: 'test-app',
         protocolVersion: '1.0.0'
      });

      // Coverage for the framework-overrides module shared with the socket
      // launcher: GLSP resolved its `Logger` from the container and got the
      // adopter's, not the `NullLogger` its own app module bound. This is the
      // half of the extraction that the socket path proves separately (the
      // example's socket smoke test asserts stdout stayed clean because logs go
      // to the LSP connection instead).
      expect(capturing.lines.length).toBeGreaterThan(0);
      expect(capturing.lines.map(line => line.message).join('\n')).toContain('GLSP server worker connection established');
   });

   it("logs the connection's protocol faults through the adopter logger", async () => {
      startHeadAndConnect();

      ports.port1.postMessage({ jsonrpc: '2.0', id: null, result: null });

      const fault = 'Received response message without id. No further error information provided.';
      await waitFor(() => capturing.lines.some(line => line.message === fault));
      expect(capturing.lines).toContainEqual({ level: 'error', message: fault, params: [] });
   });

   it('stops when the client disposes its connection', async () => {
      const connection = startHeadAndConnect();
      await connection.sendRequest(JsonrpcGLSPClient.InitializeRequest, {
         applicationId: 'test-app',
         protocolVersion: '1.0.0'
      });

      connection.dispose();

      // `stopped` settles on the same connection close that makes upstream
      // dispose the server instance, and with it every client session.
      await expect(server?.stopped).resolves.toBeUndefined();
   });

   it("runs on HydraniumGlspWorkerServerLauncher, whose connection sends GLSP's typed message", async () => {
      const resolved: WorkerServerLauncher[] = [];
      const connection = startHeadAndConnect([observeLauncher(resolved)]);
      const method = JsonrpcGLSPClient.ActionMessageNotification.method;
      const received = new Promise<unknown>(resolve => connection.onNotification(method, resolve));
      const message = { clientId: 'client-1', action: { kind: 'test' } };

      const [launcher] = resolved;
      expect(launcher).toBeInstanceOf(HydraniumGlspWorkerServerLauncher);
      const headConnection = (launcher as unknown as { readonly connection: GlspConnection }).connection;
      await headConnection.sendNotification(JsonrpcGLSPClient.ActionMessageNotification, message);
      await expect(received).resolves.toEqual(message);
   });

   it("runs on the launcher an adopter's appModules rebind", async () => {
      const resolved: WorkerServerLauncher[] = [];
      const adopter = new ContainerModule((_bind, _unbind, _isBound, rebind) => {
         rebind(WorkerServerLauncher).to(AdopterLauncher);
      });
      const connection = startHeadAndConnect([adopter, observeLauncher(resolved)]);

      const result = await connection.sendRequest(JsonrpcGLSPClient.InitializeRequest, {
         applicationId: 'test-app',
         protocolVersion: '1.0.0'
      });

      expect(resolved[0]).toBeInstanceOf(AdopterLauncher);
      expect(result.protocolVersion).toBe('1.0.0');
   });

   it("refuses a launcher an adopter's appModules bind a second time", () => {
      const adopter = new ContainerModule(bind => {
         bind(WorkerServerLauncher).to(AdopterLauncher);
      });

      expect(() => startHeadAndConnect([adopter])).toThrow('Ambiguous match found for serviceIdentifier');
   });

   /** GLSP sends typed messages, built by the copy of `vscode-jsonrpc` its
    *  protocol resolves, over the connection this launcher builds from another. */
   it("sends a message typed by GLSP's copy of vscode-jsonrpc over the launcher's connection", async () => {
      const headConnection = new ConnectingLauncher().connect(ports.port2);
      const transport = createMessagePortTransport(ports.port1);
      const connection = createMessageConnection(transport.reader, transport.writer);
      const method = JsonrpcGLSPClient.ActionMessageNotification.method;
      const received = new Promise<unknown>(resolve => connection.onNotification(method, resolve));
      connection.listen();
      const message = { clientId: 'client-1', action: { kind: 'test' } };

      try {
         await headConnection.sendNotification(JsonrpcGLSPClient.ActionMessageNotification, message);
         await expect(received).resolves.toEqual(message);
      } finally {
         headConnection.dispose();
         connection.dispose();
      }
   });

   it('drops a notification sent once GLSP has disposed the connection', async () => {
      const headConnection = new ConnectingLauncher().connect(ports.port2);
      headConnection.dispose();

      await expect(
         headConnection.sendNotification(JsonrpcGLSPClient.ActionMessageNotification, { clientId: 'client-1', action: { kind: 'test' } })
      ).resolves.toBeUndefined();
   });
});
