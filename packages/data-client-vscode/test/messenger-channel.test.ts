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
 * The adapter under test presents a `Messenger` AS a `PostMessageChannel`;
 * `createPostMessageTransport` and `relayToPostMessageChannel` are covered
 * elsewhere. Both messengers are the real classes, joined by
 * `makeMessengerHarness`, so the two sides keep their real differences: the
 * webview side's `onNotification` returns the messenger itself and cannot be
 * released, it has no `sender` option, and delivery is asynchronous both ways.
 * An absence is therefore established by waiting for a later message on the
 * same path, which the messengers deliver in order.
 */

import { DATA_SERVER_WIRE_PREFIX, createPostMessageTransport } from '@hydranium/protocol';
import { waitFor } from '@hydranium/protocol/testing';
import type { Disposable, Message } from 'vscode-jsonrpc';
import { createMessageConnection } from 'vscode-jsonrpc/node';
import { HOST_EXTENSION } from 'vscode-messenger-common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createExtensionSideChannel, createWebviewSideChannel, DATA_TO_EXTENSION, DATA_TO_WEBVIEW } from '../src/messenger-channel';
import { makeMessengerHarness, type MessengerHarness } from '../src/testing/messenger-harness';

const REQUEST: Message = { jsonrpc: '2.0', id: 1, method: 'probe', params: {} } as Message;
const LATER: Message = { jsonrpc: '2.0', id: 2, method: 'probe', params: {} } as Message;

let harness: MessengerHarness | undefined;
afterEach(() => {
   harness?.dispose();
   harness = undefined;
});

function openHarness(): MessengerHarness {
   harness = makeMessengerHarness();
   return harness;
}

describe('data head over a host notification hop', () => {
   it('carries a message from the webview to the extension host', async () => {
      const { extension, openWebview } = openHarness();
      const webview = openWebview();
      const received: Message[] = [];
      createExtensionSideChannel(extension, webview.participant).onMessage(message => received.push(message));

      createWebviewSideChannel(webview.messenger, HOST_EXTENSION).post(REQUEST);

      await waitFor(() => received.length === 1);
      expect(received).toEqual([REQUEST]);
   });

   it('carries a message from the extension host to the webview', async () => {
      const { extension, openWebview } = openHarness();
      const webview = openWebview();
      const received: Message[] = [];
      createWebviewSideChannel(webview.messenger, HOST_EXTENSION).onMessage(message => received.push(message));

      createExtensionSideChannel(extension, webview.participant).post(REQUEST);

      await waitFor(() => received.length === 1);
      expect(received).toEqual([REQUEST]);
   });

   it('posts each side on its own direction, addressed at the other side', async () => {
      // The direction MAPPING: each side's post arrives under the other side's
      // inbound type. Swapping a side's outbound and inbound types reddens it.
      const { extension, openWebview } = openHarness();
      const webview = openWebview();
      const methods: string[] = [];
      extension.onNotification(DATA_TO_EXTENSION, () => void methods.push(DATA_TO_EXTENSION.method), { sender: webview.participant });
      webview.messenger.onNotification(DATA_TO_WEBVIEW, () => void methods.push(DATA_TO_WEBVIEW.method));

      createWebviewSideChannel(webview.messenger, HOST_EXTENSION).post(REQUEST);
      createExtensionSideChannel(extension, webview.participant).post(REQUEST);

      await waitFor(() => methods.length === 2);
      expect(methods.sort()).toEqual(['hydranium/data/toExtension', 'hydranium/data/toWebview']);
   });

   it('ignores inbound traffic from a webview that is not this connection', async () => {
      // The hop is shared with the diagram by design, so the sender filter is
      // what stops a second webview injecting into this connection.
      const { extension, openWebview } = openHarness();
      const webview = openWebview();
      const intruder = openWebview();
      const received: Message[] = [];
      createExtensionSideChannel(extension, webview.participant).onMessage(message => received.push(message));

      createWebviewSideChannel(intruder.messenger, HOST_EXTENSION).post(REQUEST);
      createWebviewSideChannel(webview.messenger, HOST_EXTENSION).post(LATER);

      await waitFor(() => received.includes(LATER));
      expect(received).toEqual([LATER]);
   });

   it('releases the extension-side registration on dispose, leaving nothing on the shared hop', async () => {
      const { extension, openWebview } = openHarness();
      const webview = openWebview();
      const register = vi.spyOn(extension, 'onNotification');
      const received: Message[] = [];
      const subscription = createExtensionSideChannel(extension, webview.participant).onMessage(message => received.push(message));
      const registration = register.mock.results[0]?.value as Disposable;
      const release = vi.spyOn(registration, 'dispose');
      const webviewChannel = createWebviewSideChannel(webview.messenger, HOST_EXTENSION);
      webviewChannel.post(REQUEST);
      await waitFor(() => received.length === 1);

      subscription.dispose();
      const later: Message[] = [];
      createExtensionSideChannel(extension, webview.participant).onMessage(message => later.push(message));
      webviewChannel.post(LATER);

      await waitFor(() => later.length === 1);
      expect(received).toEqual([REQUEST]);
      // Not merely "stopped delivering": the handler is released. The hop
      // outlives every webview on it, so a channel that only muted itself
      // would accumulate one dead registration per disposed webview.
      expect(release).toHaveBeenCalledOnce();
   });

   it('stops delivering on the webview side, where the registration cannot be released', async () => {
      // The webview messenger has no unregister API, so `onMessage`'s
      // `Disposable` can only mean "stop delivering to this listener", which
      // `PostMessageReader.dispose` relies on.
      const { extension, openWebview } = openHarness();
      const webview = openWebview();
      const received: Message[] = [];
      const subscription = createWebviewSideChannel(webview.messenger, HOST_EXTENSION).onMessage(message => received.push(message));
      const hostChannel = createExtensionSideChannel(extension, webview.participant);
      hostChannel.post(REQUEST);
      await waitFor(() => received.length === 1);

      subscription.dispose();
      const marker: string[] = [];
      webview.messenger.onNotification({ method: 'probe/marker' }, () => void marker.push('marker'));
      hostChannel.post(LATER);
      extension.sendNotification({ method: 'probe/marker' }, webview.participant);

      await waitFor(() => marker.length === 1);
      expect(received).toEqual([REQUEST]);
   });

   it('forwards a close from the host to the channel', () => {
      const { extension, openWebview } = openHarness();
      const webview = openWebview();
      let fireClose = (): void => undefined;
      const channel = createExtensionSideChannel(extension, webview.participant, listener => {
         fireClose = listener;
         return { dispose: () => undefined };
      });

      let closed = 0;
      channel.onClose?.(() => (closed += 1));
      fireClose();

      expect(closed).toBe(1);
   });

   it('runs a JSON-RPC request/response pair over the hop', async () => {
      // The adapter feeding `createPostMessageTransport`, so the channel is
      // exercised through the real reader/writer. A hand-rolled responder
      // stands in for the server, which the socket-relay suite covers.
      const { extension, openWebview } = openHarness();
      const webview = openWebview();
      const extensionTransport = createPostMessageTransport(createExtensionSideChannel(extension, webview.participant));
      const webviewTransport = createPostMessageTransport(createWebviewSideChannel(webview.messenger, HOST_EXTENSION));

      const responder = createMessageConnection(extensionTransport.reader, extensionTransport.writer);
      responder.onRequest(`${DATA_SERVER_WIRE_PREFIX}getProjects`, () => [{ id: 'one' }]);
      responder.listen();

      const client = createMessageConnection(webviewTransport.reader, webviewTransport.writer);
      client.listen();

      const projects = await client.sendRequest<Array<{ id: string }>>(`${DATA_SERVER_WIRE_PREFIX}getProjects`);
      expect(projects).toEqual([{ id: 'one' }]);

      responder.dispose();
      client.dispose();
      extensionTransport.dispose();
      webviewTransport.dispose();
   });
});
