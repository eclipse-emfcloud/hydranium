/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * The data head across BOTH legs of a VS Code hop: a Content-Length-framed TCP
 * socket to the data-server, relayed onto a structured-clone-only pipe.
 *
 * This closes the gap the clone-hop suite names in its own fixture. That suite
 * puts a clone pipe on both sides and says so — "in production the extension
 * host reaches the server over a socket instead" — which leaves the leg a real
 * VS Code extension actually adds untested: the extension host holds the socket
 * (a webview has no `net`), so it has to move whole messages between framing and
 * structured clone. Everything about the far side is unchanged, and that is the
 * claim under test: `createRpcProxy`, `DataSession` and the properties model do
 * not know a relay is in the path.
 *
 * **A real socket, deliberately, not a duplex stream pair.** The framing is the
 * subject, and only a real socket delivers headers split across arbitrary chunk
 * boundaries. A stream pair would exercise the same reader class with friendlier
 * timing and could pass while a chunk-boundary bug remained.
 */

import { initializeWorkspaceProgrammatically } from '@hydranium/core';
import { NodeFileSystem } from '@hydranium/core/lib/node';
import { type ScratchWorkspace, makeScratchWorkspace } from '@hydranium/core/lib/testing/node';
import {
   DATA_SERVER_WIRE_PREFIX,
   DataEvents,
   DataSession,
   type DataPort,
   type MessageRelay,
   type RelayTransport,
   createPostMessageTransport,
   relayToPostMessageChannel
} from '@hydranium/protocol';
import { waitFor } from '@hydranium/protocol/lib/testing';
import { createOrderFlowServices } from '@hydranium/example-order-flow-server/lib/language-server/order-flow-module';
import type { ProcessModel } from '@hydranium/example-order-flow-server/lib/language-server/generated-transfer/transfer-model';
import * as net from 'node:net';
import * as path from 'node:path';
import { Emitter, Message, type Event, type MessageConnection, type PartialMessageInfo } from 'vscode-jsonrpc';
// `/node` because this suite runs in Node and holds a socket. The webview half
// of a real hop imports `/browser`; the package ROOT installs no runtime
// abstraction layer and throws on the first message.
import { createMessageConnection } from 'vscode-jsonrpc/node';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OrderFlowPropertiesModel } from '../src/data/order-flow-properties-model';
import { ClonePipeEnd } from './testing/clone-pipe';
import {
   type OrderFlowTransferRoot,
   type SocketDataServer,
   openSocketTransport,
   startSocketDataServer
} from './testing/socket-data-server';

const WORKSPACE_ROOT = path.resolve(__dirname, '../../workspace');
const FULFILLMENT_PROCESS = 'orders/fulfillment.process';
const THIRD_PARTY = 'some-other-editor';

// The real socket server and its client end live in `./testing`, shared with
// the panel's own hop suite — same server, different pipe in the middle.

/**
 * The port a VS Code webview would hold: its connection rides the clone pipe,
 * and the socket is on the far side of a relay it cannot see.
 */
class RelayedWebviewPort implements DataPort {
   readonly clientId = 'order-flow-webview';
   protected readonly disposeEmitter = new Emitter<void>();
   readonly onDispose: Event<void> = this.disposeEmitter.event;
   protected readonly toDispose: Array<{ dispose(): void }> = [];
   readonly errors: Array<{ error: unknown; context: string }> = [];
   relay?: MessageRelay;

   constructor(
      protected readonly serverPort: number,
      protected readonly crossed: Message[],
      /** Delay the framed side, to open the window the replay buffer closes. */
      protected readonly gate: () => Promise<void> = () => Promise.resolve()
   ) {}

   async connect(): Promise<MessageConnection> {
      const [extensionSide, webviewSide] = ClonePipeEnd.pair(this.crossed);
      this.toDispose.push(extensionSide, webviewSide);

      this.relay = relayToPostMessageChannel(
         extensionSide,
         async () => {
            await this.gate();
            return openSocketTransport(this.serverPort);
         },
         { reportError: (error, context) => this.errors.push({ error, context }) }
      );
      this.toDispose.push(this.relay);

      const clientTransport = createPostMessageTransport(webviewSide);
      this.toDispose.push(clientTransport);
      const connection = createMessageConnection(clientTransport.reader, clientTransport.writer);
      connection.listen();
      this.toDispose.push(connection);
      return connection;
   }

   reportError(error: unknown, context: string): void {
      this.errors.push({ error, context });
   }

   dispose(): void {
      this.disposeEmitter.dispose();
      for (const disposable of this.toDispose.reverse()) {
         disposable.dispose();
      }
      this.toDispose.length = 0;
   }
}

let workspace: ScratchWorkspace | undefined;
let dataServer: SocketDataServer | undefined;
let port: RelayedWebviewPort | undefined;
let events: DataEvents<OrderFlowTransferRoot> | undefined;
let session: DataSession<OrderFlowTransferRoot> | undefined;
let model: OrderFlowPropertiesModel<OrderFlowTransferRoot> | undefined;
let crossed: Message[] = [];

function uriOf(relativePath: string): string {
   if (!workspace) {
      throw new Error('scratch workspace not seeded');
   }
   return workspace.uri(relativePath);
}

/** Wire the client stack over `port`. Split out so the race test can gate it. */
function mountClient(clientPort: RelayedWebviewPort): void {
   port = clientPort;
   events = new DataEvents<OrderFlowTransferRoot>();
   session = new DataSession<OrderFlowTransferRoot>(clientPort, events);
   model = new OrderFlowPropertiesModel<OrderFlowTransferRoot>(session, events);
}

describe('order-flow data head over a socket relayed onto a clone hop', () => {
   beforeEach(async () => {
      workspace = makeScratchWorkspace({ seed: WORKSPACE_ROOT, prefix: 'order-flow-relay-' });
      const services = createOrderFlowServices({ ...NodeFileSystem });
      const sharedServices = services.shared;
      await initializeWorkspaceProgrammatically(sharedServices, workspace.root);
      dataServer = await startSocketDataServer(sharedServices);
      crossed = [];
   });

   afterEach(async () => {
      model?.dispose();
      model = undefined;
      session?.dispose();
      session = undefined;
      events?.dispose();
      events = undefined;
      port?.dispose();
      port = undefined;
      await dataServer?.dispose();
      dataServer = undefined;
      workspace?.dispose();
      workspace = undefined;
      crossed = [];
   });

   it('answers a request that crossed framing and structured clone', async () => {
      mountClient(new RelayedWebviewPort(dataServer!.port, crossed));
      const server = await session!.connected();

      // Asserting CONTENT, so this cannot pass against an empty registry: the
      // request framing, the socket decode, the clone hop and the response
      // framing all have to survive for these two ids to come back.
      const projects = await server.getProjects();
      expect(projects.map(project => project.id).sort()).toEqual(['commerce-core', 'orders']);

      // And traffic really went through the clone pipe rather than around it.
      expect(crossed.length).toBeGreaterThan(0);
      expect(port!.errors).toEqual([]);
   });

   it('opens, follows and writes a document through the relay', async () => {
      mountClient(new RelayedWebviewPort(dataServer!.port, crossed));
      const uri = uriOf(FULFILLMENT_PROCESS);
      await model!.open(uri);

      expect(model!.fields).toEqual([
         { name: 'name', value: 'Fulfillment' },
         { name: 'subject', value: 'Order' }
      ]);

      expect(await model!.setField('name', 'Fulfilment')).toEqual({ status: 'applied' });

      const server = await session!.connected();
      const reread = await server.getModelDocument({ uri });
      expect((reread.root as ProcessModel).name).toBe('Fulfilment');
   });

   it('delivers a server-initiated notification back through the relay', async () => {
      // The reverse direction: the server pushes unprompted, so this is the only
      // thing here that exercises socket-decode -> clone-post with no request
      // waiting for it.
      mountClient(new RelayedWebviewPort(dataServer!.port, crossed));
      const uri = uriOf(FULFILLMENT_PROCESS);
      await model!.open(uri);

      const server = await session!.connected();
      const foreign = (await server.getModelDocument({ uri })).root as ProcessModel;
      await server.updateModelDocument({ uri, clientId: THIRD_PARTY, model: { ...foreign, name: 'RenamedByOther' } });

      await waitFor(() => model!.fields.find(field => field.name === 'name')?.value === 'RenamedByOther', {
         message: 'no server-initiated update crossed the relay'
      });
   });

   it('answers a request sent before the framed side finished connecting', async () => {
      // The race the replay buffer exists for, sent raw so the window is
      // explicit and the assertion names a single request.
      //
      // It is NOT the only test that depends on the buffer, however much it
      // looks like it: `connect()` returns the far-side connection without
      // waiting for the relay's socket, so `DataSession`'s readiness handshake
      // is already in flight inside the same window. Deleting the buffer reddens
      // most of this suite, measured. What this test adds is a *named* early
      // request whose failure mode is unambiguous, rather than a timeout three
      // layers up.
      let release = (): void => undefined;
      const gateOpen = new Promise<void>(resolve => {
         release = resolve;
      });

      const gatedPort = new RelayedWebviewPort(dataServer!.port, crossed, () => gateOpen);
      port = gatedPort;
      const connection = await gatedPort.connect();

      // In flight while the relay is still awaiting its socket. Without the
      // synchronous pre-connect subscription this message is dropped by an
      // emitter with no replay, and the request never settles.
      //
      // Raw sends, because the point is to bypass the proxy — so they have to
      // apply the wire prefix the proxy would have applied, from the constant
      // rather than a literal that could drift away from the server's default.
      const pending = connection.sendRequest<Array<{ id: string }>>(`${DATA_SERVER_WIRE_PREFIX}getProjects`);
      await new Promise<void>(resolve => setTimeout(resolve, 25));
      expect(gatedPort.relay).toBeDefined();

      release();
      await expect(gatedPort.relay!.wired).resolves.toBe(true);

      const projects = await pending;
      expect(projects.map(project => project.id).sort()).toEqual(['commerce-core', 'orders']);
      expect(gatedPort.errors).toEqual([]);
   });

   it('replays messages buffered during the connect window in FIFO order', async () => {
      // Observed at the relay's own boundary rather than through the server, and
      // that choice is a measurement, not a preference. Buffering
      // `openModelDocument` then `getModelDocument` and asserting that both
      // answer passes with the replay loop deliberately reversed, because
      // `getModelDocument` reads the workspace and does not care whether the
      // document was opened first — that assertion is insensitive to the very
      // ordering it claims to pin. Recording the framed side makes the ordering
      // itself the observable, so reversing the loop reddens this test and only
      // this one.
      const written: Array<string | undefined> = [];
      const [extensionSide, webviewSide] = ClonePipeEnd.pair(crossed);
      let release = (): void => undefined;
      const gateOpen = new Promise<void>(resolve => {
         release = resolve;
      });

      const relay = relayToPostMessageChannel(extensionSide, async () => {
         await gateOpen;
         return recordingTransport(written);
      });

      // Straight onto the pipe while the framed side is still gated. `post`
      // delivers on a microtask, so drain between sends to fix the send order
      // independently of whatever the relay then does with it.
      for (const method of ['first', 'second', 'third']) {
         webviewSide.post({ jsonrpc: '2.0', id: method, method, params: {} } as Message);
         await Promise.resolve();
      }
      expect(written).toEqual([]);

      release();
      await expect(relay.wired).resolves.toBe(true);

      expect(written).toEqual(['first', 'second', 'third']);
      relay.dispose();
      extensionSide.dispose();
      webviewSide.dispose();
   });

   it('signals the host when the framed side dies, since the clone hop cannot', async () => {
      // The asymmetry the relay documents: a `PostMessageChannel` has no
      // `close()`, so a dead server is invisible to the far end and its pending
      // requests would hang with no rejection. `onClose` is the host's only
      // notice, so its absence would be a silent hang in production.
      mountClient(new RelayedWebviewPort(dataServer!.port, crossed));
      const server = await session!.connected();
      await server.getProjects();

      let closed = 0;
      port!.relay!.onClose(() => (closed += 1));

      dataServer!.killConnections();

      await waitFor(() => closed > 0, { message: 'relay never reported the framed side going away' });
   });

   it('reports a failure to open the framed side instead of hanging', async () => {
      const unusedPort = await findClosedPort();
      const failingPort = new RelayedWebviewPort(unusedPort, crossed);
      port = failingPort;
      await failingPort.connect();

      await expect(failingPort.relay!.wired).resolves.toBe(false);
      expect(failingPort.errors.map(entry => entry.context)).toContain('opening the transport to relay');
   });
});

/**
 * A framed side that answers nothing and records the method of every message
 * written to it, in arrival order.
 *
 * Deliberately not a socket: this is the one test whose subject is the relay's
 * own ordering contract, so the far end has to be an observable rather than a
 * server whose semantics might mask the thing being measured.
 */
function recordingTransport(written: Array<string | undefined>): RelayTransport {
   const readerErrors = new Emitter<Error>();
   const readerClose = new Emitter<void>();
   const partial = new Emitter<PartialMessageInfo>();
   const writerErrors = new Emitter<[Error, Message | undefined, number | undefined]>();
   const writerClose = new Emitter<void>();

   return {
      reader: {
         onError: readerErrors.event,
         onClose: readerClose.event,
         onPartialMessage: partial.event,
         listen: () => ({ dispose: () => undefined }),
         dispose: () => undefined
      },
      writer: {
         onError: writerErrors.event,
         onClose: writerClose.event,
         write: (message: Message) => {
            const named = Message.isRequest(message) || Message.isNotification(message);
            written.push(named ? message.method : undefined);
            return Promise.resolve();
         },
         end: () => undefined,
         dispose: () => undefined
      }
   };
}

/** A port number nothing is listening on: bind one, then give it back. */
async function findClosedPort(): Promise<number> {
   const probe = net.createServer();
   await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', () => resolve()));
   const address = probe.address();
   if (address === null || typeof address === 'string') {
      throw new Error('expected an AddressInfo from the probe server');
   }
   const { port: probePort } = address;
   await new Promise<void>(resolve => probe.close(() => resolve()));
   return probePort;
}
