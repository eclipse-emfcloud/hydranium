/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { createPostMessageTransport } from '@hydranium/protocol';
import { createMessageConnection } from 'vscode-jsonrpc/node';
import { HOST_EXTENSION } from 'vscode-messenger-common';
import { afterEach, describe, expect, it } from 'vitest';
import { createWebviewSideChannel } from '../src/messenger-channel';
import { connectDataServer, openSocketTransport } from '../src/node/data-server-connection';
import { makeMessengerHarness } from '../src/testing/messenger-harness';
import { startEchoServer } from './echo-server';

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
   for (const cleanup of cleanups.splice(0).reverse()) {
      await cleanup();
   }
});

describe('connectDataServer', () => {
   it('answers a webview request from the socket behind the extension host', async () => {
      const server = await startEchoServer();
      cleanups.push(() => server.close());
      const harness = makeMessengerHarness();
      cleanups.push(() => harness.dispose());
      const webview = harness.openWebview();
      const relay = connectDataServer({ messenger: harness.extension, webview: webview.participant, findPort: async () => server.port });
      cleanups.push(() => relay.dispose());
      expect(await relay.wired).toBe(true);

      const transport = createPostMessageTransport(createWebviewSideChannel(webview.messenger, HOST_EXTENSION));
      const client = createMessageConnection(transport.reader, transport.writer);
      client.listen();
      cleanups.push(
         () => client.dispose(),
         () => transport.dispose()
      );

      await expect(client.sendRequest('echo', 'one')).resolves.toBe('one');
   });

   it('rejects an unreachable port', async () => {
      const server = await startEchoServer();
      await server.close();

      await expect(openSocketTransport(server.port)).rejects.toThrow(/ECONNREFUSED/);
   });
});
