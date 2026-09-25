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

import { ServerModule, WORKER_START_UP_COMPLETE_MSG } from '@eclipse-glsp/server/browser.js';
import { JsonrpcGLSPClient } from '@eclipse-glsp/protocol';
import { createMessageConnection, type MessageConnection } from 'vscode-jsonrpc/browser';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { IntegratedServer } from '@hydranium/core';
import { createMessagePortTransport } from '@hydranium/protocol';
import { makeMessagePortPair, type MessagePortPair } from '@hydranium/protocol/testing/node';
import { startGlspServerInWorker } from '../src/browser/index.js';
import { makeCapturingGlspLogger, type CapturingGlspLogger } from '../src/testing/index.js';

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

describe('startGlspServerInWorker', () => {
   let ports: MessagePortPair;
   let globalPostMessage: GlobalPostMessageStub;
   let capturing: CapturingGlspLogger;
   let clientConnection: MessageConnection | undefined;
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
   function startHeadAndConnect(): MessageConnection {
      server = startGlspServerInWorker({
         context: ports.port2,
         createLogger: () => capturing.logger,
         serverModule: new ServerModule()
      });
      // The page's end speaks the same transport as the head's, so a dispose
      // here reaches the head as a close.
      const transport = createMessagePortTransport(ports.port1);
      const connection = createMessageConnection(transport.reader, transport.writer);
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
});
