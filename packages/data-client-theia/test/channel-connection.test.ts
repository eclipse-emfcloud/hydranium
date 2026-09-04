/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, expect, it } from 'vitest';
import { type Channel } from '@theia/core';
import { type ServiceConnectionProvider } from '@theia/core/lib/browser';
import { Deferred } from '@theia/core/lib/common/promise-util';
import { ForwardingChannel } from '@theia/core/lib/common/message-rpc/channel';
import { Uint8ArrayReadBuffer, Uint8ArrayWriteBuffer } from '@theia/core/lib/common/message-rpc/uint8-array-message-buffer';
import { createChannelConnection, openChannelConnection } from '../src/browser/channel-connection';

/** Flush pending microtasks/timers so the helper's async `start()` runs. */
const flush = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));

/** Records the channel handler so a test can fire it with an in-memory channel. */
class FakeConnectionProvider {
   listenCalls = 0;
   /** Third argument of the last `listen` — the handle's replay opt-out. */
   lastReconnectArg?: boolean;
   handler?: (path: unknown, channel: Channel) => void;
   listen(_path: string, handler: (path: unknown, channel: Channel) => void, reconnect: boolean): void {
      this.listenCalls++;
      this.lastReconnectArg = reconnect;
      this.handler = handler;
   }
}

/**
 * Wait until the handle asks for a replacement channel.
 *
 * Real timers rather than fake ones: the re-open is a `setTimeout` behind
 * vscode-jsonrpc's own `setImmediate`-driven message queue, and freezing the
 * clock stalls that queue too — the connections these tests build would stop
 * delivering. The tests pass a short `reconnectDelays` so the wait is bounded by
 * that, not by the shipped schedule.
 */
async function nextListen(provider: FakeConnectionProvider): Promise<void> {
   const before = provider.listenCalls;
   const deadline = Date.now() + 5_000;
   while (provider.listenCalls === before) {
      if (Date.now() > deadline) {
         throw new Error('the handle never asked for a replacement channel');
      }
      await new Promise(resolve => setTimeout(resolve, 5));
   }
}

/** The reconnect schedule these tests run on — one short delay, repeated. */
const FAST_RECONNECT: readonly number[] = [10];

/**
 * Minimal in-memory Theia `Channel` pair — two `ForwardingChannel`s whose
 * write buffers fire onto the opposite channel's message emitter. This is the
 * recipe `@theia/core`'s `ChannelPipe` test helper uses; reproduced here
 * because that helper ships in a `.spec.js` that pulls in chai + runs its own
 * `describe()` block at import time (unsafe to import into jest).
 */
function makeChannelPipe(): { left: ForwardingChannel; right: ForwardingChannel } {
   const left: ForwardingChannel = new ForwardingChannel(
      'left',
      () => right.onCloseEmitter.fire({ reason: 'left closed' }),
      () => {
         const writeBuffer = new Uint8ArrayWriteBuffer();
         writeBuffer.onCommit(buffer => right.onMessageEmitter.fire(() => new Uint8ArrayReadBuffer(buffer)));
         return writeBuffer;
      }
   );
   const right: ForwardingChannel = new ForwardingChannel(
      'right',
      () => left.onCloseEmitter.fire({ reason: 'right closed' }),
      () => {
         const writeBuffer = new Uint8ArrayWriteBuffer();
         writeBuffer.onCommit(buffer => left.onMessageEmitter.fire(() => new Uint8ArrayReadBuffer(buffer)));
         return writeBuffer;
      }
   );
   return { left, right };
}

describe('createChannelConnection', () => {
   it('round-trips a request to a handler on the other channel end', async () => {
      const pipe = makeChannelPipe();
      const serverConnection = createChannelConnection(pipe.left);
      const clientConnection = createChannelConnection(pipe.right);
      serverConnection.onRequest('echo', (params: { value: string }) => ({ echoed: params.value }));
      serverConnection.listen();
      clientConnection.listen();

      const result = await clientConnection.sendRequest('echo', { value: 'hi' });

      expect(result).toEqual({ echoed: 'hi' });
      serverConnection.dispose();
      clientConnection.dispose();
   });

   it('delivers a notification to the other channel end', async () => {
      const pipe = makeChannelPipe();
      const serverConnection = createChannelConnection(pipe.left);
      const clientConnection = createChannelConnection(pipe.right);
      const received = new Promise<{ value: string }>(resolve => {
         clientConnection.onNotification('ping', (params: { value: string }) => resolve(params));
      });
      serverConnection.listen();
      clientConnection.listen();

      serverConnection.sendNotification('ping', { value: 'pong' });

      expect(await received).toEqual({ value: 'pong' });
      serverConnection.dispose();
      clientConnection.dispose();
   });
});

describe('openChannelConnection', () => {
   it('cannot use Deferred.state as a synchronous built-once guard', () => {
      // A pinned UPSTREAM assumption, not a test of our own code. Theia's
      // `Deferred` sets `state` inside a `.then()` on its own promise, so it is
      // still `'unresolved'` for a microtask after `resolve()` returns — which
      // is why `openChannelConnection` carries its own synchronous `built` flag
      // rather than reading this value.
      //
      // Kept because that flag's code comment asserts this timing. If a Theia
      // upgrade ever makes `state` synchronous, this reddens and the comment
      // needs revisiting rather than silently becoming wrong.
      const deferred = new Deferred<number>();
      deferred.resolve(1);
      expect(deferred.state).toBe('unresolved');
   });

   it('does not register the channel listener until whenReady resolves', async () => {
      const provider = new FakeConnectionProvider();
      let release!: () => void;
      const whenReady = new Promise<void>(resolve => {
         release = resolve;
      });
      openChannelConnection(provider as unknown as ServiceConnectionProvider, 'test-path', { whenReady });
      await flush();
      expect(provider.listenCalls).toBe(0);

      release();
      await flush();
      expect(provider.listenCalls).toBe(1);
   });

   it("never opts into Theia's own handler replay", async () => {
      // The handle re-opens the channel itself, so letting Theia ALSO replay the
      // handler on main-channel recreation would give one path two independent
      // openers. The second `ChannelMultiplexer.open` for an id throws inside a
      // promise `listen` neither awaits nor reports, so the loser's consumer
      // hangs with a clean log.
      const provider = new FakeConnectionProvider();
      const handle = openChannelConnection(provider as unknown as ServiceConnectionProvider, 'test-path');
      await flush();

      expect(provider.lastReconnectArg).toBe(false);
      handle.dispose();
   });

   it('ignores an unsolicited second channel', async () => {
      const provider = new FakeConnectionProvider();
      const handle = openChannelConnection(provider as unknown as ServiceConnectionProvider, 'test-path');
      await flush();

      const pipe = makeChannelPipe();
      provider.handler!('test-path', pipe.left);
      // No close asked for a replacement, so this channel must be ignored even
      // though reconnect is on: exactly one channel is outstanding at a time.
      provider.handler!('test-path', makeChannelPipe().left);

      const connection = await handle.current;
      // The resolved connection is already listening on `pipe.left`; a peer on the
      // other end can reach it, proving it bound to the first channel exactly once.
      const received = new Promise<{ value: string }>(resolve => {
         connection.onNotification('ping', (params: { value: string }) => resolve(params));
      });
      const peer = createChannelConnection(pipe.right);
      peer.listen();
      peer.sendNotification('ping', { value: 'ok' });

      expect(await received).toEqual({ value: 'ok' });
      handle.dispose();
      peer.dispose();
   });

   it('builds exactly one connection for two channels arriving in the same turn', async () => {
      // The hazard this pins is a LEAK, and it needs a direct observation
      // because the promise cannot show it: `resolve` is first-wins, so the
      // handle looks correct while a second connection sits listening on the
      // second channel, reachable by nobody and never disposed.
      //
      // `createChannelConnection` subscribes to `channel.onMessage`, so counting
      // subscriptions per channel counts connections built for it.
      const provider = new FakeConnectionProvider();
      const handle = openChannelConnection(provider as unknown as ServiceConnectionProvider, 'test-path');
      await flush();

      const subscribed: number[] = [];
      const spyChannel = (index: number): Channel => {
         const inner = makeChannelPipe().left;
         return new Proxy(inner, {
            get(target, property, receiver): unknown {
               if (property === 'onMessage') {
                  return (listener: unknown) => {
                     subscribed[index] = (subscribed[index] ?? 0) + 1;
                     return (target.onMessage as (arg: unknown) => unknown)(listener);
                  };
               }
               const value = Reflect.get(target, property, receiver);
               return typeof value === 'function' ? value.bind(target) : value;
            }
         }) as Channel;
      };

      provider.handler!('test-path', spyChannel(0));
      provider.handler!('test-path', spyChannel(1));
      await handle.current;

      expect(subscribed[0]).toBe(1);
      expect(subscribed[1] ?? 0).toBe(0);
      handle.dispose();
   });

   it('does nothing on a close while reconnect is off', async () => {
      const provider = new FakeConnectionProvider();
      const handle = openChannelConnection(provider as unknown as ServiceConnectionProvider, 'test-path', {
         reconnect: false,
         reconnectDelays: FAST_RECONNECT
      });
      await flush();

      let reconnects = 0;
      let losses = 0;
      handle.onDidReconnect(() => {
         reconnects++;
      });
      handle.onDidLoseConnection(() => {
         losses++;
      });
      const pipe = makeChannelPipe();
      provider.handler!('test-path', pipe.left);
      const connection = await handle.current;
      const listensAfterOpen = provider.listenCalls;

      pipe.right.close();
      // Longer than the schedule above, so a re-open that WAS scheduled has had
      // several times its delay to arrive. An absence proves nothing sampled on
      // the next line.
      await new Promise(resolve => setTimeout(resolve, 100));

      expect(losses).toBe(0);
      expect(reconnects).toBe(0);
      expect(provider.listenCalls).toBe(listensAfterOpen);
      // And `current` still hands back the (now dead) original, which is what
      // build-once means.
      expect(await handle.current).toBe(connection);
      handle.dispose();
   });

   it('re-opens the channel when the live one closes, and works over the replacement', async () => {
      const provider = new FakeConnectionProvider();
      const handle = openChannelConnection(provider as unknown as ServiceConnectionProvider, 'test-path', {
         reconnectDelays: FAST_RECONNECT
      });
      await flush();

      const first = makeChannelPipe();
      provider.handler!('test-path', first.left);
      const firstConnection = await handle.current;

      // Close from the FAR end, which is the shape a dead language server
      // produces: the backend forwarder closes the channel when its socket dies.
      const reconnected = new Promise<void>(resolve => {
         handle.onDidReconnect(() => resolve());
      });
      first.right.close();
      await nextListen(provider);

      const second = makeChannelPipe();
      provider.handler!('test-path', second.left);
      await reconnected;

      const secondConnection = await handle.current;
      expect(secondConnection).not.toBe(firstConnection);

      // And the replacement is a WORKING connection, not merely a new object:
      // asserting identity alone would pass for one that never bound its channel.
      const received = new Promise<{ value: string }>(resolve => {
         secondConnection.onNotification('ping', (params: { value: string }) => resolve(params));
      });
      const peer = createChannelConnection(second.right);
      peer.listen();
      peer.sendNotification('ping', { value: 'second' });

      expect(await received).toEqual({ value: 'second' });
      handle.dispose();
      peer.dispose();
   });

   it('repoints current before announcing the loss, so a request in the gap reaches the replacement', async () => {
      // The property that makes `onDidLoseConnection` usable, and the one a
      // listener cannot establish for itself: by the time it runs, `current` is
      // already the replacement's unresolved promise. A handle that repointed
      // afterwards would hand every listener the dead connection instead, and a
      // request built from it would never settle — indistinguishable, from the
      // consumer's side, from the bug this whole path fixes.
      const provider = new FakeConnectionProvider();
      const handle = openChannelConnection(provider as unknown as ServiceConnectionProvider, 'test-path', {
         reconnectDelays: FAST_RECONNECT
      });
      await flush();

      const first = makeChannelPipe();
      const firstPeer = createChannelConnection(first.right);
      firstPeer.onRequest('which', () => 'first');
      firstPeer.listen();
      provider.handler!('test-path', first.left);
      const firstConnection = await handle.current;
      expect(await firstConnection.sendRequest('which')).toBe('first');

      // Captured inside the listener, at the only moment the assertion is about.
      let inGap: Promise<unknown> | undefined;
      handle.onDidLoseConnection(() => {
         inGap = handle.current.then(connection => connection.sendRequest('which'));
      });
      first.right.close();
      await nextListen(provider);

      const second = makeChannelPipe();
      const secondPeer = createChannelConnection(second.right);
      secondPeer.onRequest('which', () => 'second');
      secondPeer.listen();
      provider.handler!('test-path', second.left);

      expect(await inGap).toBe('second');
      handle.dispose();
      firstPeer.dispose();
      secondPeer.dispose();
   });

   it('rejects a request that was in flight when the connection was lost', async () => {
      // Not a nicety. vscode-jsonrpc rejects pending responses from `dispose`
      // and from nothing else — a reader-side close leaves them untouched — so a
      // handle that merely dropped the dead connection would leave every
      // in-flight request unsettled for the life of the page.
      const provider = new FakeConnectionProvider();
      const handle = openChannelConnection(provider as unknown as ServiceConnectionProvider, 'test-path', {
         reconnectDelays: FAST_RECONNECT
      });
      await flush();

      const pipe = makeChannelPipe();
      const peer = createChannelConnection(pipe.right);
      // Never answers, so the request is genuinely in flight at close time.
      peer.onRequest('hang', () => new Promise(() => undefined));
      peer.listen();
      provider.handler!('test-path', pipe.left);
      const connection = await handle.current;

      const inFlight = connection.sendRequest('hang');
      await flush();
      pipe.right.close();

      await expect(inFlight).rejects.toThrow();
      handle.dispose();
      peer.dispose();
   });

   it('stops re-opening once disposed', async () => {
      const provider = new FakeConnectionProvider();
      const handle = openChannelConnection(provider as unknown as ServiceConnectionProvider, 'test-path', {
         reconnectDelays: FAST_RECONNECT
      });
      await flush();

      const pipe = makeChannelPipe();
      provider.handler!('test-path', pipe.left);
      await handle.current;
      const listensAfterOpen = provider.listenCalls;

      // Dispose INSIDE the gap: the close has already scheduled a re-open, so
      // this pins that dispose cancels the pending timer rather than merely
      // ignoring the channel it would produce. A workbench reload closes the
      // channel and disposes in quick succession, in that order.
      pipe.right.close();
      handle.dispose();
      await new Promise(resolve => setTimeout(resolve, 100));

      expect(provider.listenCalls).toBe(listensAfterOpen);
   });

   it('ignores a channel handed over after dispose', async () => {
      const provider = new FakeConnectionProvider();
      const handle = openChannelConnection(provider as unknown as ServiceConnectionProvider, 'test-path', { reconnect: true });
      await flush();
      provider.handler!('test-path', makeChannelPipe().left);
      const firstConnection = await handle.current;

      handle.dispose();

      // A disposed handle must not resurrect on a late channel, which is the
      // shape a reloading workbench produces. The observable is that no new
      // generation was built: `current` still hands back the original
      // connection rather than one bound to the late channel. Counting
      // `onDidReconnect` would NOT work here — dispose tears the emitter down,
      // so a listener registered afterwards can never fire and the assertion
      // could not fail.
      provider.handler!('test-path', makeChannelPipe().left);
      await flush();

      expect(await handle.current).toBe(firstConnection);
      // Idempotent.
      handle.dispose();
   });
});
