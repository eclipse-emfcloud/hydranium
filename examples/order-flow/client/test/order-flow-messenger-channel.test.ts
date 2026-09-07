/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * The data head over a host's notification hop, which is how it reaches a VS
 * Code webview.
 *
 * The adapter under test is the last VS Code-specific link in the data path:
 * `createPostMessageTransport` turns a channel into a reader/writer pair and
 * `relayToPostMessageChannel` pumps a socket onto the same shape, both covered
 * elsewhere; what this suite adds is presenting a `Messenger` AS that channel.
 *
 * **THE TWO SIDES NEED TWO DOUBLES.** Narrowness protects against a method the
 * adapter uses without declaring it; it does not make a declared signature true
 * of the real class. The webview-side `Messenger` is a materially different
 * shape from the extension-side one — `onNotification` returns the messenger
 * ITSELF rather than a `Disposable`, there is no `sender` option, and a second
 * registration for a method REPLACES the first — so one symmetric hub silently
 * over-promises on the webview end, and the promise it over-promises is the one
 * `PostMessageChannel.onMessage` makes. Both doubles below are written against
 * the installed `vscode-messenger` / `vscode-messenger-webview` sources.
 *
 * What neither double proves is the real classes' delivery semantics across a
 * process boundary; that is what an IDE launch is for. The compile-time
 * conformance assertions live in `examples/order-flow/vscode`, one per side,
 * because only that package declares both messenger packages.
 */

// The module, not the barrel: the barrel re-exports the diagram definition,
// whose `@eclipse-glsp/client` graph reaches untranspiled sources and CSS.
import { createExtensionSideChannel, createWebviewSideChannel } from '../src/data/order-flow-messenger-channel';
import { FakeMessengerHub } from './testing/fake-messenger-hub';
import { DATA_SERVER_WIRE_PREFIX, createPostMessageTransport } from '@hydranium/protocol';
import type { Message } from 'vscode-jsonrpc';
import { createMessageConnection } from 'vscode-jsonrpc/node';
import { describe, expect, it } from 'vitest';

/** The two participants a VS Code hop has, plus an intruder. */
type Participant = 'host-extension' | 'webview' | 'other-webview';

const REQUEST: Message = { jsonrpc: '2.0', id: 1, method: 'probe', params: {} } as Message;

describe('order-flow data head over a host notification hop', () => {
   it('carries a message from the webview to the extension host', () => {
      const hub = new FakeMessengerHub<Participant>();
      const received: Message[] = [];
      createExtensionSideChannel(hub.asExtension('host-extension'), 'webview').onMessage(message => received.push(message));

      createWebviewSideChannel(hub.asWebview('webview'), 'host-extension').post(REQUEST);

      expect(received).toEqual([REQUEST]);
   });

   it('carries a message from the extension host to the webview', () => {
      const hub = new FakeMessengerHub<Participant>();
      const received: Message[] = [];
      createWebviewSideChannel(hub.asWebview('webview'), 'host-extension').onMessage(message => received.push(message));

      createExtensionSideChannel(hub.asExtension('host-extension'), 'webview').post(REQUEST);

      expect(received).toEqual([REQUEST]);
   });

   it('posts each side on its own direction, addressed at the other side', () => {
      // Asserts the direction MAPPING, which is what this suite can actually
      // discriminate. It does NOT show that two notification types stop a side
      // seeing its own traffic: that assertion passes with both constants
      // collapsed to one name, because `vscode-messenger` addresses by receiver,
      // so self-delivery never happens either way. Swapping a side's outbound
      // and inbound types reddens what remains.
      const hub = new FakeMessengerHub<Participant>();
      createExtensionSideChannel(hub.asExtension('host-extension'), 'webview').post(REQUEST);
      createWebviewSideChannel(hub.asWebview('webview'), 'host-extension').post(REQUEST);

      expect(hub.delivered.map(delivery => `${delivery.method} -> ${delivery.receiver}`)).toEqual([
         'orderFlow/data/toWebview -> webview',
         'orderFlow/data/toExtension -> host-extension'
      ]);
   });

   it('ignores inbound traffic from a webview that is not this connection', () => {
      // The hop is shared with the diagram by design, so the sender filter is
      // what stops a second webview injecting into this connection.
      const hub = new FakeMessengerHub<Participant>();
      const received: Message[] = [];
      createExtensionSideChannel(hub.asExtension('host-extension'), 'webview').onMessage(message => received.push(message));

      createWebviewSideChannel(hub.asWebview('other-webview'), 'host-extension').post(REQUEST);

      expect(received).toEqual([]);
   });

   it('releases the extension-side registration on dispose, leaving nothing on the shared hop', () => {
      const hub = new FakeMessengerHub<Participant>();
      const received: Message[] = [];
      const subscription = createExtensionSideChannel(hub.asExtension('host-extension'), 'webview').onMessage(message =>
         received.push(message)
      );
      const webview = createWebviewSideChannel(hub.asWebview('webview'), 'host-extension');

      webview.post(REQUEST);
      expect(hub.registrationCount).toBe(1);
      subscription.dispose();
      webview.post(REQUEST);

      expect(received).toHaveLength(1);
      // Not merely "stopped delivering": the handler is GONE. The hop outlives
      // every panel on it, so a channel that only muted itself would accumulate
      // one dead registration per disposed panel.
      expect(hub.registrationCount).toBe(0);
   });

   it('stops delivering on the webview side, where the registration cannot be released', () => {
      // The webview messenger has no unregister API at all, so `onMessage`'s
      // `Disposable` can only mean "stop delivering to this listener" — and it
      // has to mean at least that, because `PostMessageChannel` promises a
      // `Disposable` and `PostMessageReader.dispose` relies on it. The assertion
      // is deliberately BOTH halves: deliveries stop AND the underlying handler
      // is still registered, which is what distinguishes the honest behaviour
      // from a channel that got lucky.
      const hub = new FakeMessengerHub<Participant>();
      const received: Message[] = [];
      const subscription = createWebviewSideChannel(hub.asWebview('webview'), 'host-extension').onMessage(message =>
         received.push(message)
      );
      const host = createExtensionSideChannel(hub.asExtension('host-extension'), 'webview');

      host.post(REQUEST);
      subscription.dispose();
      host.post(REQUEST);

      expect(received).toHaveLength(1);
      expect(hub.registrationCount).toBe(1);
   });

   it('forwards a close from the host to the channel', () => {
      const hub = new FakeMessengerHub<Participant>();
      let fireClose = (): void => undefined;
      const channel = createExtensionSideChannel(hub.asExtension('host-extension'), 'webview', listener => {
         fireClose = listener;
         return { dispose: () => undefined };
      });

      let closed = 0;
      channel.onClose?.(() => (closed += 1));
      fireClose();

      expect(closed).toBe(1);
   });

   it('runs a JSON-RPC request/response pair over the hop', async () => {
      // The composition that matters: the adapter feeding
      // `createPostMessageTransport`, so the channel is exercised through the
      // real reader/writer rather than only through its own two methods. A
      // hand-rolled responder stands in for the server, which the socket-relay
      // suite already covers end to end.
      const hub = new FakeMessengerHub<Participant>();
      const extensionTransport = createPostMessageTransport(createExtensionSideChannel(hub.asExtension('host-extension'), 'webview'));
      const webviewTransport = createPostMessageTransport(createWebviewSideChannel(hub.asWebview('webview'), 'host-extension'));

      const responder = createMessageConnection(extensionTransport.reader, extensionTransport.writer);
      responder.onRequest(`${DATA_SERVER_WIRE_PREFIX}getProjects`, () => [{ id: 'orders' }]);
      responder.listen();

      const client = createMessageConnection(webviewTransport.reader, webviewTransport.writer);
      client.listen();

      const projects = await client.sendRequest<Array<{ id: string }>>(`${DATA_SERVER_WIRE_PREFIX}getProjects`);
      expect(projects).toEqual([{ id: 'orders' }]);

      responder.dispose();
      client.dispose();
      extensionTransport.dispose();
      webviewTransport.dispose();
   });
});
