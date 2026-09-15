/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import 'reflect-metadata';

// The refused-reconnect path reads Theia's frontend application config, which the
// provider stores on `window` — absent under Vitest's node environment. Aliasing
// the global is enough, and is steadier than mocking the module: Theia's package
// resolves to its own `src`, so a `lib/...` specifier in `vi.mock` names a
// different module id than the one the class under test actually imports.
Object.assign(globalThis, { window: globalThis });

import { FrontendApplicationConfigProvider } from '@theia/core/lib/browser/frontend-application-config-provider';
import { type Channel } from '@theia/core/lib/common/message-rpc/channel';
import { ConnectionManagementMessages } from '@theia/core/lib/common/messaging/connection-management';
import { SocketWriteBuffer } from '@theia/core/lib/common/messaging/socket-write-buffer';
import { FrontendIdProvider } from '@theia/core/lib/browser/messaging/frontend-id-provider';
import { WebSocketConnectionSource } from '@theia/core/lib/browser/messaging/ws-connection-source';
import { Container } from '@theia/core/shared/inversify';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { FramedSocketWriteBuffer } from '../../src/common/framed-socket-write-buffer';
import { SessionAwareConnectionSource } from '../../src/browser/session-aware-connection-source';

/**
 * Whether this Theia injects the write buffer the reconnect hardening replaces.
 *
 * Before 1.71 the connection source builds its own in its constructor and
 * honours no binding, so `bindConnectionResilience` declines and
 * {@link SessionAwareConnectionSource} is never constructed. The cases below
 * drive a rebind that cannot happen there, so they are skipped rather than
 * adapted: adapting them would report a pass on a version where the feature is
 * off. What 1.70 does instead — decline and warn — is asserted by the buffer's
 * own suite, which needs no injection and runs everywhere.
 *
 * Read off a bare instance rather than parsed from a version, so it answers
 * about the Theia actually resolved. A version that builds its own buffer does
 * so in the constructor; one that injects it leaves the member unset until a
 * container fills it. Resolving through a container instead would answer the
 * same question but runs `openSocket` from `@postConstruct`, which reaches the
 * network and browser globals this suite exists to stay clear of.
 */
function injectsWriteBuffer(): boolean {
   const bare = new WebSocketConnectionSource() as unknown as { writeBuffer?: SocketWriteBuffer };
   return bare.writeBuffer === undefined;
}

type Listener = (...args: never[]) => void;
/** Taken from the class rather than from `socket.io-client`: the package's own typings and Theia's
 *  declarations resolve to different builds of the socket type, which do not structurally match. */
type ConnectionSocket = SessionAwareConnectionSource['socket'];

/**
 * Stands in for the socket.io socket.
 *
 * The direction matters and is easy to read backwards: `emit` and `send` go TO
 * the server and are recorded, while `deliver` is the test playing the server's
 * part. Only `send` carries channel messages; `emit` carries the handshake.
 */
class FakeSocket {
   connected = false;
   id = 'fake-socket';
   readonly sent: Uint8Array[] = [];
   readonly emitted: string[] = [];
   protected readonly listeners = new Map<string, Set<Listener>>();

   on(event: string, listener: Listener): this {
      let forEvent = this.listeners.get(event);
      if (!forEvent) {
         forEvent = new Set();
         this.listeners.set(event, forEvent);
      }
      forEvent.add(listener);
      return this;
   }

   off(event: string, listener: Listener): this {
      this.listeners.get(event)?.delete(listener);
      return this;
   }

   emit(event: string): this {
      this.emitted.push(event);
      return this;
   }

   send(data: Uint8Array): this {
      this.sent.push(data);
      return this;
   }

   connect(): this {
      return this;
   }

   disconnect(): this {
      return this;
   }

   /** The server's half: hands an event to whatever the source has registered. */
   deliver(event: string, ...args: unknown[]): void {
      // Copied first: the base class removes its own one-shot listeners while they run.
      for (const listener of [...(this.listeners.get(event) ?? [])]) {
         (listener as (...values: unknown[]) => void)(...args);
      }
   }
}

/** Keeps the real `openSocket` wiring while staying off the network and out of `location`. */
class TestConnectionSource extends SessionAwareConnectionSource {
   readonly fake = new FakeSocket();

   protected override createWebSocketUrl(): string {
      return 'ws://test';
   }

   protected override createWebSocket(): ConnectionSocket {
      return this.fake as unknown as ConnectionSocket;
   }
}

describe.skipIf(!injectsWriteBuffer())('SessionAwareConnectionSource', () => {
   let source: TestConnectionSource;
   let fake: FakeSocket;
   let channel: Channel;

   /** Commits one byte through the channel, which is what a real message eventually does. */
   function write(value: number): void {
      const writer = channel.getWriteBuffer();
      writer.writeUint8(value);
      writer.commit();
   }

   function delivered(): number[] {
      // Every entry is one `send`, which is one delivery, which is one decoded message.
      return fake.sent.map(entry => entry[entry.length - 1]);
   }

   /** Brings the source up to a confirmed session, the state every test starts from. */
   function initialConnect(): void {
      fake.connected = true;
      fake.deliver('connect');
      fake.deliver(ConnectionManagementMessages.INITIAL_CONNECT);
   }

   beforeAll(() => {
      // Reload off, so a refused reconnect stays in the app rather than reloading the page — the
      // branch the last test here observes. Set once: the provider refuses to be set twice.
      FrontendApplicationConfigProvider.set({ reloadOnReconnect: false });
   });

   beforeEach(() => {
      vi.spyOn(console, 'info').mockImplementation(() => undefined);
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);

      const container = new Container();
      container.bind(FrontendIdProvider).toConstantValue({ getId: () => 'test-frontend' });
      container.bind(SocketWriteBuffer).toDynamicValue(() => new FramedSocketWriteBuffer());
      container.bind(TestConnectionSource).toSelf().inSingletonScope();

      source = container.get(TestConnectionSource);
      fake = source.fake;
      source.onConnectionDidOpen(opened => (channel = opened));
   });

   afterEach(() => {
      vi.restoreAllMocks();
   });

   it('sends normally once the server has confirmed the session', () => {
      initialConnect();

      write(1);

      expect(delivered()).toEqual([1]);
   });

   it('holds a message produced while the reconnect handshake is still outstanding', () => {
      // The defect this guards. Nothing was buffered during the outage, so a backlog check alone
      // says the message may go out — but the server has not attached its channel to this socket
      // yet, so it would arrive at a peer with no listener for it and be dropped silently.
      initialConnect();
      fake.connected = false;
      fake.deliver('disconnect');
      fake.connected = true;
      fake.deliver('connect');
      expect(fake.emitted).toContain(ConnectionManagementMessages.RECONNECT);

      write(7);
      expect(delivered()).toEqual([]);

      fake.deliver(ConnectionManagementMessages.RECONNECT, true);
      expect(delivered()).toEqual([7]);
   });

   it('keeps a message produced during the handshake behind the backlog', () => {
      initialConnect();
      fake.connected = false;
      fake.deliver('disconnect');
      write(1);
      write(2);

      fake.connected = true;
      fake.deliver('connect');
      write(3);
      expect(delivered()).toEqual([]);

      fake.deliver(ConnectionManagementMessages.RECONNECT, true);
      expect(delivered()).toEqual([1, 2, 3]);
   });

   it('keeps holding messages when the server refuses the session', () => {
      // A refused reconnect is not a resumed session: the frontend has to start a new one, and
      // nothing may go out on the strength of the socket being up.
      initialConnect();
      fake.connected = false;
      fake.deliver('disconnect');
      fake.connected = true;
      fake.deliver('connect');

      fake.deliver(ConnectionManagementMessages.RECONNECT, false);
      write(5);

      expect(delivered()).toEqual([]);
   });
});
