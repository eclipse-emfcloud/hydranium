/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import 'reflect-metadata';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FramedSocketWriteBuffer } from '../../src/common/framed-socket-write-buffer';
import { ACKNOWLEDGEMENT_EVENT } from '../../src/common/inbound-message-sequence';
import { AcknowledgedSocketChannel, type FrontendSocket } from '../../src/node/session-bound-frontend-connection-service';

type Listener = (...args: unknown[]) => void;

/** Stands in for one socket.io server socket: `send` goes to the frontend, `deliver` plays the frontend. */
class FakeSocket {
   connected = true;
   readonly sent: number[] = [];
   readonly sequences: number[] = [];
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

   emit(): boolean {
      return true;
   }

   send(data: Uint8Array, sequence: number): this {
      this.sent.push(data[data.length - 1]);
      this.sequences.push(sequence);
      return this;
   }

   deliver(event: string, ...args: unknown[]): void {
      for (const listener of [...(this.listeners.get(event) ?? [])]) {
         listener(...args);
      }
   }

   get asSocket(): FrontendSocket {
      return this as unknown as FrontendSocket;
   }
}

describe('AcknowledgedSocketChannel', () => {
   let channel: AcknowledgedSocketChannel;

   function write(value: number): void {
      const writer = channel.getWriteBuffer();
      writer.writeUint8(value);
      writer.commit();
   }

   beforeEach(() => {
      vi.spyOn(console, 'info').mockImplementation(() => undefined);
      channel = new AcknowledgedSocketChannel(new FramedSocketWriteBuffer());
   });

   afterEach(() => {
      channel.close();
      vi.restoreAllMocks();
   });

   it('resends what it sent into a socket whose far end died unnoticed', () => {
      // The server's socket still reports itself connected, so its writes go out and are lost.
      const dead = new FakeSocket();
      const replacement = new FakeSocket();
      channel.connect(dead.asSocket);
      dead.deliver('message', Uint8Array.of(9), 1);
      write(1);
      write(2);

      channel.disconnect();
      channel.connect(replacement.asSocket);

      expect(replacement.sent).toEqual([1, 2]);
      expect(replacement.sequences).toEqual([1, 2]);
   });

   it('resends nothing to a frontend that does not number its messages', () => {
      // Such a frontend lacks the hardening, and would apply a resent message a second time.
      const dead = new FakeSocket();
      const replacement = new FakeSocket();
      channel.connect(dead.asSocket);
      dead.deliver('message', Uint8Array.of(9));
      write(1);

      channel.disconnect();
      channel.connect(replacement.asSocket);

      expect(replacement.sent).toEqual([]);
   });

   it('resends nothing the frontend has acknowledged', () => {
      const first = new FakeSocket();
      const replacement = new FakeSocket();
      channel.connect(first.asSocket);
      write(1);
      write(2);
      first.deliver(ACKNOWLEDGEMENT_EVENT, 1);

      channel.disconnect();
      channel.connect(replacement.asSocket);

      expect(replacement.sequences).toEqual([2]);
   });

   it('delivers a message the frontend resent only once, across sockets', () => {
      const first = new FakeSocket();
      const replacement = new FakeSocket();
      const received: number[] = [];
      channel.onMessage(provider => void received.push(provider().readUint8()));

      channel.connect(first.asSocket);
      first.deliver('message', Uint8Array.of(4), 1);
      channel.disconnect();
      channel.connect(replacement.asSocket);
      replacement.deliver('message', Uint8Array.of(4), 1);
      replacement.deliver('message', Uint8Array.of(5), 2);

      expect(received).toEqual([4, 5]);
   });

   it('stops listening to a socket it was disconnected from', () => {
      const first = new FakeSocket();
      const received: number[] = [];
      channel.onMessage(provider => void received.push(provider().readUint8()));

      channel.connect(first.asSocket);
      channel.disconnect();
      first.deliver('message', Uint8Array.of(4), 1);

      expect(received).toEqual([]);
   });
});
