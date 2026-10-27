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
 * `data-client-vscode`'s own suites run the same relay and channels over a real
 * socket, against an echo server. What this one adds is the real order-flow
 * data server behind them, the properties model above them, and a reconnect.
 *
 * Both messengers are the real classes, joined by `makeMessengerHarness`. The
 * webview messenger keeps ONE handler per method, so a second generation's
 * registration replaces the first's; that is benign, because a superseded
 * generation's reader is already inert through the channel's per-subscription
 * forwarding flag.
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
import { NodeFileSystem } from '@hydranium/core/node';
import { type ScratchWorkspace, makeScratchWorkspace } from '@hydranium/core/testing/node';
import {
   DATA_SERVER_WIRE_PREFIX,
   DataEvents,
   DataConnection,
   type DataSession,
   type MessageRelay,
   type ResolvedMessage
} from '@hydranium/protocol';
import { waitFor } from '@hydranium/protocol/testing';
import { createOrderFlowServices } from '@hydranium/example-order-flow-server/lib/language-server/order-flow-module';
import * as path from 'node:path';
import type { MessageConnection } from 'vscode-jsonrpc';
import { HOST_EXTENSION } from 'vscode-messenger-common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWebviewSideChannel, DATA_TO_WEBVIEW } from '@hydranium/data-client-vscode';
import { WebviewDataPort } from '@hydranium/data-client-vscode/browser';
import { connectDataServer } from '@hydranium/data-client-vscode/node';
import { makeMessengerHarness, type MessengerHarness, type MessengerHarnessWebview } from '@hydranium/data-client-vscode/testing';
import { OrderFlowPropertiesModel } from '../src/data/order-flow-properties-model';
import { type OrderFlowTransferRoot, type SocketDataServer, startSocketDataServer } from './testing/socket-data-server';
import type { ProcessModel } from '@hydranium/example-order-flow-protocol';
import { thirdPartyWrite as writeAsThirdParty } from './testing/third-party-write.js';

const WORKSPACE_ROOT = path.resolve(__dirname, '../../workspace');
const FULFILLMENT_PROCESS = 'orders/fulfillment.process';
const THIRD_PARTY = 'some-other-editor';
/** Request id the intruder uses, so its answer is identifiable if one comes. */
const INTRUDER_ID = 9999;

/** The `id` of a JSON-RPC message, if it carries one. */
function idOf(message: unknown): unknown {
   return typeof message === 'object' && message !== null ? (message as { id?: unknown }).id : undefined;
}

/** The webview's port, counting the connections it builds so a reconnect is observable. */
class CountingWebviewDataPort extends WebviewDataPort {
   readonly errors: Array<{ error: unknown; message: ResolvedMessage }> = [];
   readonly generations = new Set<MessageConnection>();

   override async connect(): Promise<MessageConnection> {
      const connection = await super.connect();
      this.generations.add(connection);
      return connection;
   }
}

let workspace: ScratchWorkspace | undefined;
let dataServer: SocketDataServer | undefined;
let harness: MessengerHarness | undefined;
let webview: MessengerHarnessWebview | undefined;
let relay: MessageRelay | undefined;
let port: CountingWebviewDataPort | undefined;
let events: DataEvents<OrderFlowTransferRoot> | undefined;
let connection: DataConnection<OrderFlowTransferRoot> | undefined;
let session: DataSession<OrderFlowTransferRoot> | undefined;
let model: OrderFlowPropertiesModel<OrderFlowTransferRoot> | undefined;

function uriOf(relativePath: string): string {
   if (!workspace) {
      throw new Error('scratch workspace not seeded');
   }
   return workspace.uri(relativePath);
}

/** The extension host's end, as the panel wires it. */
function relayHop(): MessageRelay {
   return connectDataServer({
      messenger: harness!.extension,
      webview: webview!.participant,
      findPort: async () => dataServer!.port,
      reportError: (error, reported) => port?.reportError(error, reported)
   });
}

/** Stand up both halves of the hop, as `OrderFlowPropertiesPanel.create` does. */
function mountHop(): void {
   harness = makeMessengerHarness();
   webview = harness.openWebview();

   // Extension host: the socket, relayed onto the messenger.
   relay = relayHop();

   // Webview: the mirror channel, and the whole host-invariant stack above it.
   const webviewPort = new CountingWebviewDataPort(createWebviewSideChannel(webview.messenger, HOST_EXTENSION), {
      reportError: (error, message) => webviewPort.errors.push({ error, message })
   });
   port = webviewPort;
   events = new DataEvents<OrderFlowTransferRoot>();
   connection = new DataConnection<OrderFlowTransferRoot>(port, events);
   const dataSession = connection.createSession('order-flow-hop-test');
   session = dataSession;
   model = new OrderFlowPropertiesModel<OrderFlowTransferRoot>(dataSession, events, uriOf(FULFILLMENT_PROCESS));
}

/** Write `root` as a third party, ungated, so it always lands. */
async function thirdPartyWrite(uri: string, root: OrderFlowTransferRoot): Promise<void> {
   const server = await session!.connected();
   await writeAsThirdParty(server, THIRD_PARTY, uri, root);
}

describe('order-flow properties panel data path through a socket, a relay and a messenger hop', () => {
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
      webview = undefined;
      harness?.dispose();
      harness = undefined;
      await dataServer?.dispose();
      dataServer = undefined;
      workspace?.dispose();
      workspace = undefined;
   });

   it('opens a document and writes a field across the whole hop', async () => {
      mountHop();
      const toWebview = vi.spyOn(harness!.extension, 'sendNotification');
      const toExtension = vi.spyOn(webview!.messenger, 'sendNotification');
      const uri = uriOf(FULFILLMENT_PROCESS);

      await model!.open();
      expect(model!.fields).toEqual([
         { name: 'name', value: 'Fulfillment' },
         { name: 'subject', value: 'Order' }
      ]);

      expect(await model!.setField('name', 'Fulfilment')).toEqual({ status: 'applied' });

      // Re-read from the server, so this is the document and not the local copy.
      const server = await session!.connected();
      const reread = (await server.getModelDocument({ uri })).model?.root as ProcessModel;
      expect(reread.name).toBe('Fulfilment');

      // Both directions really used the messenger, rather than some path that
      // happened to work. Controlled by collapsing the two notification
      // constants to one name, which reddens this line — worth noting because
      // the channel suite's own version of that control does NOT redden there
      // (`vscode-messenger` addresses by receiver, so a shared method name still
      // delivers correctly). With a real round trip in the path the direction
      // ENCODING becomes observable, which it is not at that tier.
      const methods = new Set([...toWebview.mock.calls, ...toExtension.mock.calls].map(([type]) => type.method));
      expect(methods).toEqual(new Set(['hydranium/data/toExtension', 'hydranium/data/toWebview']));
   });

   it('follows a third-party write pushed back through the hop', async () => {
      mountHop();
      const uri = uriOf(FULFILLMENT_PROCESS);
      await model!.open();

      const server = await session!.connected();
      const foreign = (await server.getModelDocument({ uri })).model?.root as ProcessModel;
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
      await model!.open();

      // What the panel does on `connectionLost`: the session drops its
      // generation and disposes the connection.
      port!.connectionLost();

      // The extension side has to be re-relayed too — a restarted server binds a
      // fresh port, which is why `connectDataServer` re-resolves it per generation.
      relay!.dispose();
      relay = relayHop();

      // A fresh request builds generation two and must be answered.
      await model!.close();
      model!.dispose();
      model = new OrderFlowPropertiesModel<OrderFlowTransferRoot>(session!, events!, uriOf(FULFILLMENT_PROCESS));
      await model.open();
      expect(model!.fields.find(field => field.name === 'name')?.value).toBe('Fulfillment');
      expect(port!.generations.size).toBe(2);
      expect(await model!.setField('name', 'AfterReconnect')).toEqual({ status: 'applied' });
   });

   it('does not forward a second webview traffic onto the socket', async () => {
      // The hop is shared with the diagram by design, so the extension side
      // filters by sender. Worth re-asserting here even though the channel suite
      // covers the filter, because the failure mode this level can see is
      // different: not "the handler fired" but "a foreign message reached the
      // REAL server and it answered".
      mountHop();
      await model!.open();
      const toWebview = vi.spyOn(harness!.extension, 'sendNotification');

      const intruder = createWebviewSideChannel(harness!.openWebview().messenger, HOST_EXTENSION);
      intruder.post({ jsonrpc: '2.0', id: INTRUDER_ID, method: `${DATA_SERVER_WIRE_PREFIX}getProjects`, params: {} } as never);

      // **A BOUNDED WAIT, NOT A SYNCHRONOUS PEEK.** Reading the sends on the
      // line after `post` shows nothing: a forwarded message still has a
      // whole socket round trip ahead of it, so that version passes with the
      // sender filter deliberately removed. The observable is an ABSENCE, so it
      // can only be established by waiting longer than the thing would have
      // taken — neighbouring round trips in this suite land in single-digit ms.
      await new Promise(resolve => setTimeout(resolve, 500));

      // Matched by id, not by direction alone: the model's own traffic produces
      // `toWebview` deliveries throughout, so "no toWebview since" would be
      // satisfied by an unrelated quiet moment.
      const answered = toWebview.mock.calls.filter(
         ([type, , params]) => type.method === DATA_TO_WEBVIEW.method && idOf(params) === INTRUDER_ID
      );
      expect(answered).toEqual([]);
      // The panel's own connection is untouched by the intrusion.
      expect(model!.fields).not.toEqual([]);
   });
});
