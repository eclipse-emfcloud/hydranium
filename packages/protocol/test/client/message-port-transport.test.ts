/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * The transport a head's worker `MessagePort` uses at either end, over a real
 * `worker_threads` port, which clones and orders as a browser port does.
 * Neither end calls `close()` on its port before teardown: Node's port would
 * report that with a `close` event, and a browser's reports nothing, which is
 * what the signal under test stands in for.
 *
 * Under `vscode-jsonrpc/node`'s runtime, the one whose queue a close can
 * overtake: it dispatches one queued message per `setImmediate` turn, where the
 * browser's drains the queue on microtasks before the port's next message.
 */

import { afterEach, describe, expect, it } from 'vitest';
import type { Disposable, Message } from 'vscode-jsonrpc';
import { createMessageConnection } from 'vscode-jsonrpc/node';
import { createMessagePortTransport, type TransferredMessagePort } from '../../src/client';
import { tick, waitFor } from '../../src/testing';
import { makeMessagePortPair } from '../../src/testing/node';
import { methodsOf, notification } from './clone-pipe';

const toDispose: Disposable[] = [];

function track<T extends Disposable>(disposable: T): T {
   toDispose.push(disposable);
   return disposable;
}

afterEach(() => {
   for (const disposable of toDispose.reverse()) {
      disposable.dispose();
   }
   toDispose.length = 0;
});

function portPair(): [TransferredMessagePort, TransferredMessagePort] {
   const ports = track(makeMessagePortPair());
   return [ports.port1, ports.port2];
}

/** Every value that arrives on `port`, the close signal included. */
function rawTraffic(port: TransferredMessagePort): unknown[] {
   const seen: unknown[] = [];
   port.addEventListener('message', event => seen.push((event as { readonly data: unknown }).data));
   return seen;
}

describe('createMessagePortTransport', () => {
   it('carries messages both ways', async () => {
      const [near, far] = portPair();
      const nearTransport = track(createMessagePortTransport(near));
      const farTransport = track(createMessagePortTransport(far));

      const atFar: Message[] = [];
      const atNear: Message[] = [];
      track(farTransport.reader.listen(message => atFar.push(message)));
      track(nearTransport.reader.listen(message => atNear.push(message)));
      await nearTransport.writer.write(notification('ns/out', 1));
      await farTransport.writer.write(notification('ns/back', 2));
      await waitFor(() => atFar.length === 1 && atNear.length === 1);

      expect(atFar).toEqual([notification('ns/out', 1)]);
      expect(atNear).toEqual([notification('ns/back', 2)]);
   });

   it('fires close on the far reader and writer when the near writer is disposed, after what it wrote', async () => {
      const [near, far] = portPair();
      const nearTransport = createMessagePortTransport(near);
      const farTransport = track(createMessagePortTransport(far));

      const events: string[] = [];
      track(farTransport.reader.listen(message => events.push(methodsOf([message])[0])));
      track(farTransport.reader.onClose(() => events.push('reader closed')));
      track(farTransport.writer.onClose(() => events.push('writer closed')));
      await nearTransport.writer.write(notification('ns/last'));
      nearTransport.writer.dispose();
      await waitFor(() => events.length === 3);

      expect(events).toEqual(['ns/last', 'reader closed', 'writer closed']);
   });

   it('dispatches every message sent before the dispose ahead of the close, however many are queued', async () => {
      const [near, far] = portPair();
      const nearTransport = createMessagePortTransport(near);
      const nearConnection = createMessageConnection(nearTransport.reader, nearTransport.writer);
      const farTransport = createMessagePortTransport(far);
      const farConnection = track(createMessageConnection(farTransport.reader, farTransport.writer));

      const events: string[] = [];
      farConnection.onNotification('ns/queued', (value: number) => {
         events.push(`queued ${value}`);
      });
      farConnection.onClose(() => {
         events.push('closed');
      });
      farConnection.listen();
      nearConnection.listen();
      for (let i = 1; i <= 3; i++) {
         void nearConnection.sendNotification('ns/queued', i);
      }
      nearConnection.dispose();
      await waitFor(() => events.includes('closed'));

      expect(events).toEqual(['queued 1', 'queued 2', 'queued 3', 'closed']);
   });

   it('signals once, from either dispose, and never as a message', async () => {
      const [near, far] = portPair();
      const atFar = rawTraffic(far);
      const nearTransport = createMessagePortTransport(near);
      const farTransport = track(createMessagePortTransport(far));

      const delivered: Message[] = [];
      track(farTransport.reader.listen(message => delivered.push(message)));
      nearTransport.dispose();
      nearTransport.writer.dispose();
      await waitFor(() => atFar.length > 0);
      await tick();

      // One value, and a string, which no JSON-RPC message is.
      expect(atFar).toHaveLength(1);
      expect(typeof atFar[0]).toBe('string');
      expect(delivered).toEqual([]);
   });

   it('does not answer a peer that has already closed', async () => {
      const [near, far] = portPair();
      const atNear = rawTraffic(near);
      const nearTransport = createMessagePortTransport(near);
      const farTransport = createMessagePortTransport(far);

      let farClosed = false;
      track(farTransport.reader.onClose(() => (farClosed = true)));
      nearTransport.dispose();
      await waitFor(() => farClosed);
      // What a head does on its peer's close: dispose its own connection.
      farTransport.dispose();
      await tick();

      expect(atNear).toEqual([]);
   });

   it('posts nothing once its peer has closed', async () => {
      const [near, far] = portPair();
      const atNear = rawTraffic(near);
      const nearTransport = createMessagePortTransport(near);
      const farTransport = track(createMessagePortTransport(far));

      let farClosed = false;
      track(farTransport.reader.onClose(() => (farClosed = true)));
      nearTransport.dispose();
      await waitFor(() => farClosed);
      // A reply to a request still in flight at the dispose, which nothing at
      // the near end would read.
      await farTransport.writer.write(notification('ns/late'));
      await tick();

      expect(atNear).toEqual([]);
   });

   it('stops listening on the port once disposed', () => {
      const listening = new Set<unknown>();
      const recordingPort = (): TransferredMessagePort => ({
         postMessage: () => undefined,
         addEventListener: (_type, listener) => listening.add(listener),
         removeEventListener: (_type, listener) => listening.delete(listener),
         start: () => undefined
      });
      const transport = createMessagePortTransport(recordingPort());
      expect(listening.size).toBe(1);

      transport.writer.dispose();

      expect(listening.size).toBe(0);
   });

   it('stops listening on the port once its peer has closed', async () => {
      const [near, far] = portPair();
      const listening = new Set<unknown>();
      const recordingFar: TransferredMessagePort = {
         postMessage: message => far.postMessage(message),
         addEventListener: (type, listener) => {
            listening.add(listener);
            far.addEventListener(type, listener);
         },
         removeEventListener: (type, listener) => {
            listening.delete(listener);
            far.removeEventListener(type, listener);
         },
         start: () => far.start()
      };
      const nearTransport = createMessagePortTransport(near);
      const farTransport = track(createMessagePortTransport(recordingFar));
      let farClosed = false;
      track(farTransport.reader.onClose(() => (farClosed = true)));
      expect(listening.size).toBe(1);

      nearTransport.dispose();
      await waitFor(() => farClosed);

      expect(listening.size).toBe(0);
   });
});
