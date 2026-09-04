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
 * `BrowserMessageReader` / `BrowserMessageWriter`: it accepts an `onmessage`
 * assignment (which starts it) and has `addEventListener`. Measured, not
 * assumed. The one thing Node's main thread lacks is a global `postMessage`,
 * which `WorkerServerLauncher.run` calls unconditionally — so the tests install
 * one, and that stub is also the observation point for the third test below.
 */

import { ServerModule, WORKER_START_UP_COMPLETE_MSG } from '@eclipse-glsp/server/browser.js';
import { JsonrpcGLSPClient } from '@eclipse-glsp/protocol';
import { MessageChannel, type MessagePort as NodeMessagePort } from 'node:worker_threads';
import { BrowserMessageReader, BrowserMessageWriter, createMessageConnection, type MessageConnection } from 'vscode-jsonrpc/browser';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { IntegratedServer } from '@hydranium/core';
import { startGlspServerInWorker, type TransferredMessagePort } from '../src/browser/index.js';
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

/**
 * A Node `MessagePort` in the slot the option types as a transferred browser
 * one.
 *
 * The declared type is deliberately structural (see
 * {@link TransferredMessagePort}) so that a `Worker` and the worker global are
 * rejected; Node's port satisfies the same three members at runtime, and the
 * cast records that this is a test substituting one platform's port for the
 * other's rather than working around the type.
 */
function asTransferredPort(port: NodeMessagePort): TransferredMessagePort {
   return port as unknown as TransferredMessagePort;
}

describe('startGlspServerInWorker', () => {
   let channel: MessageChannel;
   let globalPostMessage: GlobalPostMessageStub;
   let capturing: CapturingGlspLogger;
   let clientConnection: MessageConnection | undefined;
   let server: IntegratedServer | undefined;

   beforeEach(() => {
      channel = new MessageChannel();
      globalPostMessage = stubGlobalPostMessage();
      capturing = makeCapturingGlspLogger();
   });

   afterEach(() => {
      clientConnection?.dispose();
      clientConnection = undefined;
      server = undefined;
      globalPostMessage.restore();
      channel.port1.close();
      channel.port2.close();
   });

   /** Start a head on `port2` and return a client connection on `port1`. */
   function startHeadAndConnect(): MessageConnection {
      server = startGlspServerInWorker({
         context: asTransferredPort(channel.port2),
         createLogger: () => capturing.logger,
         serverModule: new ServerModule()
      });
      // Spelled as the reader's own parameter type rather than as `MessagePort`,
      // which this project cannot name as a type at all. It buys no CHECKING:
      // that parameter's declared union does not resolve here either, so
      // `skipLibCheck` degrades it and any value would satisfy the cast. It is
      // the honest spelling of the intent, not a guard.
      const clientPort = channel.port1 as unknown as ConstructorParameters<typeof BrowserMessageReader>[0];
      const connection = createMessageConnection(new BrowserMessageReader(clientPort), new BrowserMessageWriter(clientPort));
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
      // Alongside the reader rather than instead of it: `addEventListener` does
      // not start a port, and the reader's `onmessage` assignment already did,
      // so both handlers see every inbound message.
      channel.port1.addEventListener('message', event => fromPort.push((event as MessageEvent).data));

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
});
