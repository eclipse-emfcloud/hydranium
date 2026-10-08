/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { NoopLogger, type PostMessageChannel } from '@hydranium/protocol';
import { describe, expect, it } from 'vitest';
import type { Message, MessageConnection } from 'vscode-jsonrpc';
import { WebviewDataPort } from '../src/webview/properties-data-port';

/** A pipe that counts the readers subscribed to it. */
function countingChannel(): PostMessageChannel & { readonly readers: number } {
   const listeners = new Set<(message: Message) => void>();
   return {
      get readers(): number {
         return listeners.size;
      },
      post: () => undefined,
      onMessage(listener) {
         listeners.add(listener);
         return { dispose: () => listeners.delete(listener) };
      }
   };
}

describe('WebviewDataPort', () => {
   it('hands every generation the same connection until it is disposed', async () => {
      const channel = countingChannel();
      const port = new WebviewDataPort(channel, () => undefined, new NoopLogger());
      try {
         const first = await port.connect();

         // A second live one would take answers meant for the first, which a
         // retry after a failed readiness check would otherwise get.
         expect(await port.connect()).toBe(first);
         expect(channel.readers).toBe(1);

         first.dispose();
         const next = await port.connect();

         expect(next).not.toBe(first);
         expect(channel.readers).toBe(1);
      } finally {
         port.dispose();
      }
   });

   it('disposes its connection when the relay is lost, though no generation holds it', async () => {
      const channel = countingChannel();
      const port = new WebviewDataPort(channel, () => undefined, new NoopLogger());
      try {
         const lost = await port.connect();

         port.connectionLost();

         expect(channel.readers).toBe(0);
         expect(await port.connect()).not.toBe(lost);
      } finally {
         port.dispose();
      }
   });

   it('hands a listener that connects as the relay is lost a fresh connection', async () => {
      const channel = countingChannel();
      const port = new WebviewDataPort(channel, () => undefined, new NoopLogger());
      try {
         const lost = await port.connect();
         let reconnected: Promise<MessageConnection> | undefined;
         port.onDispose(() => (reconnected ??= port.connect()));

         port.connectionLost();

         expect(await reconnected).not.toBe(lost);
         expect(channel.readers).toBe(1);
      } finally {
         port.dispose();
      }
   });

   it('releases its connection and refuses to connect once disposed', async () => {
      const channel = countingChannel();
      const port = new WebviewDataPort(channel, () => undefined, new NoopLogger());
      await port.connect();

      port.dispose();

      expect(channel.readers).toBe(0);
      // The consumer reconnects when told of the dispose; a connection opened then is released by nothing.
      await expect(port.connect()).rejects.toThrow('disposed');
      expect(channel.readers).toBe(0);
   });
});
