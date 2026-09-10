/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * The VS Code properties panel's data path, composed exactly as the panel
 * composes it: real socket → relay → extension-side messenger channel ↔
 * webview-side messenger channel → transport → session → properties model.
 *
 * **This composition falls between the two suites either side of it, and that
 * gap is where the panel actually lives.** The relay suite runs a real
 * socket but hand-rolls its clone pipe, so the messenger channel is absent from
 * the path it proves. The messenger-channel suite uses the channel but has no
 * socket and no server, so the far end is a hand-written responder. Neither
 * therefore exercises what `connectDataHead` + `createWebviewSideChannel`
 * actually do together, which is the whole of the panel's plumbing.
 *
 * **The reconnect case is the one worth having, but not for the hazard it looks
 * like.** The webview messenger's ONE-HANDLER-PER-METHOD registry is real —
 * `DataSession` builds a fresh `PostMessageTransport` per connection generation,
 * each calls `channel.onMessage` again, and upstream's registry is a `Map`, so
 * generation two's registration replaces generation one's — and it is *benign*:
 * flipping the double to allow many handlers per method leaves every suite
 * green, because a superseded generation's reader is already inert via the
 * channel's per-subscription forwarding flag, so a surviving stale handler has
 * nothing to deliver to. A control that will not redden is itself the answer,
 * not a wording problem.
 *
 * What the reconnect test does establish is narrower and still uncovered
 * elsewhere: that dropping a generation and re-relaying really does build a
 * SECOND connection over the same messenger channel and get answered on it.
 * Nothing else drives a second generation over this hop, and the `setField`
 * afterwards shows data flows rather than merely that a connection object exists.
 *
 * **Stated precisely: the panel does not do this.** On `MessageRelay.onClose`
 * the panel notifies the webview (which disposes its session, so pending
 * requests reject instead of hanging) and warns the user to reopen the panel; it
 * does NOT re-resolve the port and re-relay. The re-relay below is the TEST's
 * step. So this test covers the mechanism such a reconnect would use, and is the
 * evidence that it works — not evidence that the panel performs it.
 *
 * Everything above the hop is unchanged and unaware, which is the standing claim
 * of the client tier: `createRpcProxy`, `DataSession` and
 * `OrderFlowPropertiesModel` are the same objects the Theia and in-process
 * suites drive.
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
   type PostMessageChannel,
   type ResolvedMessage,
   createPostMessageTransport,
   relayToPostMessageChannel
} from '@hydranium/protocol';
import { waitFor } from '@hydranium/protocol/lib/testing';
import { createOrderFlowServices } from '@hydranium/example-order-flow-server/lib/language-server/order-flow-module';
import * as path from 'node:path';
import { Emitter, type Event, type MessageConnection } from 'vscode-jsonrpc';
import { createMessageConnection } from 'vscode-jsonrpc/node';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createExtensionSideChannel, createWebviewSideChannel } from '../src/data/order-flow-messenger-channel';
import { OrderFlowPropertiesModel } from '../src/data/order-flow-properties-model';
import { FakeMessengerHub } from './testing/fake-messenger-hub';
import {
   type OrderFlowTransferRoot,
   type SocketDataServer,
   openSocketTransport,
   startSocketDataServer
} from './testing/socket-data-server';
import type { ProcessModel } from '@hydranium/example-order-flow-server/lib/language-server/generated-hydranium/transfer-model';

const WORKSPACE_ROOT = path.resolve(__dirname, '../../workspace');
const FULFILLMENT_PROCESS = 'orders/fulfillment.process';
const THIRD_PARTY = 'some-other-editor';
/** Request id the intruder uses, so its answer is identifiable if one comes. */
const INTRUDER_ID = 9999;

/** The `id` of a JSON-RPC message, if it carries one. */
function idOf(message: unknown): unknown {
   return typeof message === 'object' && message !== null ? (message as { id?: unknown }).id : undefined;
}

/** The three participants a shared VS Code hop has. */
type Participant = 'host-extension' | 'webview' | 'other-webview';

/**
 * The webview's port, over the messenger hop rather than a bare pipe.
 *
 * This is `order-flow-vscode`'s `WebviewDataPort` reproduced at the tier that
 * can be tested headlessly — the same moves (transport over the channel, a
 * listening connection, `onDispose` on the host's word) against the same channel
 * factory. It cannot be imported: that class lives in the VS Code example and
 * pulls `vscode-jsonrpc/browser`, whose RAL is the wrong one for a Node test.
 */
class MessengerHopPort implements DataPort {
   readonly clientId = 'order-flow-properties-webview';
   readonly errors: Array<{ error: unknown; message: ResolvedMessage }> = [];
   /** One entry per connection generation, so a reconnect is observable. */
   readonly generations: MessageConnection[] = [];

   protected readonly disposeEmitter = new Emitter<void>();
   readonly onDispose: Event<void> = this.disposeEmitter.event;
   protected readonly toDispose: Array<{ dispose(): void }> = [];

   constructor(protected readonly channel: PostMessageChannel) {}

   async connect(): Promise<MessageConnection> {
      const transport = createPostMessageTransport(this.channel);
      this.toDispose.push(transport);
      const connection = createMessageConnection(transport.reader, transport.writer);
      connection.onDispose(() => transport.dispose());
      connection.listen();
      this.generations.push(connection);
      return connection;
   }

   reportError(error: unknown, message: ResolvedMessage): void {
      this.errors.push({ error, message });
   }

   /** What the panel's `connectionLost` notification triggers. */
   connectionLost(): void {
      this.disposeEmitter.fire();
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
let hub: FakeMessengerHub<Participant> | undefined;
let relay: MessageRelay | undefined;
let port: MessengerHopPort | undefined;
let events: DataEvents<OrderFlowTransferRoot> | undefined;
let session: DataSession<OrderFlowTransferRoot> | undefined;
let model: OrderFlowPropertiesModel<OrderFlowTransferRoot> | undefined;

function uriOf(relativePath: string): string {
   if (!workspace) {
      throw new Error('scratch workspace not seeded');
   }
   return workspace.uri(relativePath);
}

/**
 * Stand up both halves of the hop, as `OrderFlowPropertiesPanel.create` does.
 *
 * `webview` names which participant the extension addresses, so the isolation
 * test can point the panel at one webview while another one talks.
 */
function mountHop(webview: Participant = 'webview'): void {
   const messengerHub = new FakeMessengerHub<Participant>();
   hub = messengerHub;

   // Extension host: the socket, relayed onto the messenger.
   relay = relayToPostMessageChannel(
      createExtensionSideChannel(messengerHub.asExtension('host-extension'), webview),
      () => openSocketTransport(dataServer!.port),
      { reportError: (error, reported) => port?.reportError(error, reported) }
   );

   // Webview: the mirror channel, and the whole host-invariant stack above it.
   port = new MessengerHopPort(createWebviewSideChannel(messengerHub.asWebview('webview'), 'host-extension'));
   events = new DataEvents<OrderFlowTransferRoot>();
   session = new DataSession<OrderFlowTransferRoot>(port, events);
   model = new OrderFlowPropertiesModel<OrderFlowTransferRoot>(session, events);
}

/** Write `root` as a third party, ungated, so it always lands. */
async function thirdPartyWrite(uri: string, root: OrderFlowTransferRoot): Promise<void> {
   const server = await session!.connected();
   await server.updateModelDocument({ uri, clientId: THIRD_PARTY, model: root });
}

describe('order-flow properties panel data path (socket → relay → messenger hop)', () => {
   beforeEach(async () => {
      workspace = makeScratchWorkspace({ seed: WORKSPACE_ROOT, prefix: 'order-flow-hop-' });
      const { shared } = createOrderFlowServices({ ...NodeFileSystem });
      await initializeWorkspaceProgrammatically(shared, workspace.root);
      dataServer = await startSocketDataServer(shared);
   });

   afterEach(async () => {
      model?.dispose();
      model = undefined;
      session?.dispose();
      session = undefined;
      events?.dispose();
      events = undefined;
      relay?.dispose();
      relay = undefined;
      port?.dispose();
      port = undefined;
      hub = undefined;
      await dataServer?.dispose();
      dataServer = undefined;
      workspace?.dispose();
      workspace = undefined;
   });

   it('opens a document and writes a field across the whole hop', async () => {
      mountHop();
      const uri = uriOf(FULFILLMENT_PROCESS);

      await model!.open(uri);
      expect(model!.fields).toEqual([
         { name: 'name', value: 'Fulfillment' },
         { name: 'subject', value: 'Order' }
      ]);

      expect(await model!.setField('name', 'Fulfilment')).toEqual({ status: 'applied' });

      // Re-read from the server, so this is the document and not the local copy.
      const server = await session!.connected();
      const reread = (await server.getModelDocument({ uri })).root as ProcessModel;
      expect(reread.name).toBe('Fulfilment');

      // Both directions really used the messenger, rather than some path that
      // happened to work. Controlled by collapsing the two notification
      // constants to one name, which reddens this line — worth noting because
      // the channel suite's own version of that control does NOT redden there
      // (`vscode-messenger` addresses by receiver, so a shared method name still
      // delivers correctly). With a real round trip in the path the direction
      // ENCODING becomes observable, which it is not at that tier.
      const methods = new Set(hub!.delivered.map(delivery => delivery.method));
      expect(methods).toEqual(new Set(['orderFlow/data/toExtension', 'orderFlow/data/toWebview']));
   });

   it('follows a third-party write pushed back through the hop', async () => {
      mountHop();
      const uri = uriOf(FULFILLMENT_PROCESS);
      await model!.open(uri);

      const server = await session!.connected();
      const foreign = (await server.getModelDocument({ uri })).root as ProcessModel;
      await thirdPartyWrite(uri, { ...foreign, name: 'RenamedByOther' });

      // A server-initiated notification, which crosses framing and the clone hop
      // in the direction nothing else in this suite drives.
      await waitFor(() => model!.fields.find(field => field.name === 'name')?.value === 'RenamedByOther', {
         message: 'the model never picked up the third-party rename through the hop'
      });
   });

   it('serves a second connection generation over the same webview messenger', async () => {
      // The recovery MECHANISM, which nothing else drives: `connectionLost`
      // fires the port's `onDispose`, the session drops its generation, and the
      // next request builds a second one over the SAME messenger channel. The
      // panel itself stops at the notification — see the suite doc.
      // Controlled by making `connectionLost` a no-op, which leaves one
      // generation and reddens the length assertion.
      mountHop();
      const uri = uriOf(FULFILLMENT_PROCESS);
      await model!.open(uri);

      // What the panel does on `connectionLost`: the session drops its
      // generation and disposes the connection.
      port!.connectionLost();

      // The extension side has to be re-relayed too — a restarted server binds a
      // fresh port, which is why `connectDataHead` re-resolves it per generation.
      relay!.dispose();
      relay = relayToPostMessageChannel(createExtensionSideChannel(hub!.asExtension('host-extension'), 'webview'), () =>
         openSocketTransport(dataServer!.port)
      );

      // A fresh request builds generation two and must be answered.
      await model!.open(uri);
      expect(model!.fields.find(field => field.name === 'name')?.value).toBe('Fulfillment');
      expect(port!.generations).toHaveLength(2);
      expect(await model!.setField('name', 'AfterReconnect')).toEqual({ status: 'applied' });
   });

   it('does not forward a second webview traffic onto the socket', async () => {
      // The hop is shared with the diagram by design, so the extension side
      // filters by sender. Worth re-asserting here even though the channel suite
      // covers the filter, because the failure mode this level can see is
      // different: not "the handler fired" but "a foreign message reached the
      // REAL server and it answered".
      mountHop();
      await model!.open(uriOf(FULFILLMENT_PROCESS));

      const intruder = createWebviewSideChannel(hub!.asWebview('other-webview'), 'host-extension');
      intruder.post({ jsonrpc: '2.0', id: INTRUDER_ID, method: `${DATA_SERVER_WIRE_PREFIX}getProjects`, params: {} } as never);

      // **A BOUNDED WAIT, NOT A SYNCHRONOUS PEEK.** Reading `hub.delivered` on
      // the line after `post` shows nothing: a forwarded message still has a
      // whole socket round trip ahead of it, so that version passes with the
      // sender filter deliberately removed. The observable is an ABSENCE, so it
      // can only be established by waiting longer than the thing would have
      // taken — neighbouring round trips in this suite land in single-digit ms.
      await new Promise(resolve => setTimeout(resolve, 500));

      // Matched by id, not by direction alone: the model's own traffic produces
      // `toWebview` deliveries throughout, so "no toWebview since" would be
      // satisfied by an unrelated quiet moment.
      const answered = hub!.delivered.filter(
         delivery => delivery.method === 'orderFlow/data/toWebview' && idOf(delivery.message) === INTRUDER_ID
      );
      expect(answered).toEqual([]);
      // The panel's own connection is untouched by the intrusion.
      expect(model!.fields).not.toEqual([]);
   });
});
