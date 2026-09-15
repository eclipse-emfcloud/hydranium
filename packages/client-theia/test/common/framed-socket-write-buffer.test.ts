/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SocketWriteBuffer } from '@theia/core/lib/common/messaging/socket-write-buffer';
import {
   type ConnectionBufferOverflow,
   createFramedSocketWriteBuffer,
   FramedSocketWriteBuffer,
   supportsConnectionResilience,
   warnConnectionResilienceUnavailable
} from '../../src/common/framed-socket-write-buffer';

/** Records what reached the socket. One entry is one delivery, which is what a reader decodes. */
function recordingSocket(): { sent: Uint8Array[]; send(data: Uint8Array): void } {
   const sent: Uint8Array[] = [];
   return { sent, send: (data: Uint8Array) => void sent.push(data) };
}

const message = (...bytes: number[]): Uint8Array => Uint8Array.from(bytes);

describe('FramedSocketWriteBuffer', () => {
   beforeEach(() => {
      vi.spyOn(console, 'info').mockImplementation(() => undefined);
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
   });

   afterEach(() => {
      vi.restoreAllMocks();
   });

   it('sends each buffered message separately instead of concatenating them', () => {
      // Concatenating is what loses messages: a reader decodes the first and drops the rest.
      const buffer = new FramedSocketWriteBuffer();
      const socket = recordingSocket();

      buffer.buffer(message(1, 2));
      buffer.buffer(message(3));
      buffer.buffer(message(4, 5, 6));
      buffer.flush(socket);

      expect(socket.sent.map(entry => Array.from(entry))).toEqual([[1, 2], [3], [4, 5, 6]]);
   });

   it('preserves the order messages were buffered in', () => {
      const buffer = new FramedSocketWriteBuffer();
      const socket = recordingSocket();

      for (let index = 0; index < 20; index++) {
         buffer.buffer(message(index));
      }
      buffer.flush(socket);

      expect(socket.sent.map(entry => entry[0])).toEqual([...Array(20).keys()]);
   });

   it('reports a backlog until it has been flushed', () => {
      // The connection source keeps buffering while this holds, so a live message cannot overtake
      // one that is still queued.
      const buffer = new FramedSocketWriteBuffer();
      const socket = recordingSocket();

      expect(buffer.hasBacklog).toBe(false);
      buffer.buffer(message(1));
      expect(buffer.hasBacklog).toBe(true);
      buffer.flush(socket);
      expect(buffer.hasBacklog).toBe(false);
   });

   it('sends nothing when there is no backlog', () => {
      const buffer = new FramedSocketWriteBuffer();
      const socket = recordingSocket();

      buffer.flush(socket);

      expect(socket.sent).toHaveLength(0);
   });

   it('discards the backlog on drain', () => {
      const buffer = new FramedSocketWriteBuffer();
      const socket = recordingSocket();

      buffer.buffer(message(1));
      buffer.drain();
      buffer.flush(socket);

      expect(buffer.hasBacklog).toBe(false);
      expect(socket.sent).toHaveLength(0);
   });

   it('still throws once the limit is exceeded', () => {
      const buffer = new FramedSocketWriteBuffer();

      expect(() => buffer.buffer(new Uint8Array(FramedSocketWriteBuffer.DEFAULT_MAX_BYTES + 1))).toThrow(
         /Max disconnected buffer size exceeded/
      );
   });

   it('honours a configured limit', () => {
      const buffer = createFramedSocketWriteBuffer(64);

      buffer.buffer(new Uint8Array(64));

      expect(() => buffer.buffer(message(1))).toThrow(/Max disconnected buffer size exceeded/);
   });

   it('falls back to the default when no limit is configured', () => {
      expect(createFramedSocketWriteBuffer(undefined).maxBytes).toBe(FramedSocketWriteBuffer.DEFAULT_MAX_BYTES);
      expect(createFramedSocketWriteBuffer(0).maxBytes).toBe(FramedSocketWriteBuffer.DEFAULT_MAX_BYTES);
   });

   it('announces an overflow once, with what it was holding', () => {
      const buffer = createFramedSocketWriteBuffer(64);
      const reported: ConnectionBufferOverflow[] = [];
      buffer.onOverflow(overflow => void reported.push(overflow));

      buffer.buffer(new Uint8Array(64));
      expect(() => buffer.buffer(message(1))).toThrow();
      expect(() => buffer.buffer(message(2))).toThrow();

      expect(reported).toEqual([{ messages: 1, bytes: 64, maxBytes: 64 }]);
   });

   it('accepts messages up to the limit and keeps them in order', () => {
      const buffer = new FramedSocketWriteBuffer();
      const socket = recordingSocket();

      buffer.buffer(new Uint8Array(60 * 1024));
      buffer.buffer(new Uint8Array(40 * 1024));
      buffer.flush(socket);

      expect(socket.sent.map(entry => entry.byteLength)).toEqual([60 * 1024, 40 * 1024]);
   });

   it('keeps the backlog intact when a send throws', () => {
      // The message being sent is removed only once its send returns, so a transport error does not
      // swallow the message it failed on.
      const buffer = new FramedSocketWriteBuffer();
      buffer.buffer(message(1));
      buffer.buffer(message(2));

      expect(() =>
         buffer.flush({
            send: () => {
               throw new Error('transport gone');
            }
         })
      ).toThrow(/transport gone/);

      const socket = recordingSocket();
      buffer.flush(socket);
      expect(socket.sent.map(entry => entry[0])).toEqual([1, 2]);
   });

   describe('sendOrQueue', () => {
      it('sends straight away when nothing is waiting', () => {
         const buffer = new FramedSocketWriteBuffer();
         const socket = recordingSocket();

         buffer.sendOrQueue(socket, message(1));

         expect(socket.sent.map(entry => entry[0])).toEqual([1]);
      });

      it('queues while the peer is unavailable', () => {
         const buffer = new FramedSocketWriteBuffer();
         const socket = recordingSocket();

         buffer.sendOrQueue(undefined, message(1));

         expect(socket.sent).toHaveLength(0);
         expect(buffer.hasBacklog).toBe(true);
      });

      // The bug this guards: reconnecting makes the socket usable before the backlog goes out, so a
      // message accepted in that window would otherwise overtake everything still queued.
      it('queues behind a backlog even when the peer is available again', () => {
         const buffer = new FramedSocketWriteBuffer();
         const socket = recordingSocket();

         buffer.sendOrQueue(undefined, message(1));
         buffer.sendOrQueue(undefined, message(2));
         buffer.sendOrQueue(socket, message(3));
         expect(socket.sent).toHaveLength(0);

         buffer.flush(socket);

         expect(socket.sent.map(entry => entry[0])).toEqual([1, 2, 3]);
      });

      it('resumes direct sends once the backlog has gone out', () => {
         const buffer = new FramedSocketWriteBuffer();
         const socket = recordingSocket();

         buffer.sendOrQueue(undefined, message(1));
         buffer.flush(socket);
         buffer.sendOrQueue(socket, message(2));

         expect(socket.sent.map(entry => entry[0])).toEqual([1, 2]);
      });

      it('keeps order when a message is produced during the flush', () => {
         // `flush` drains one at a time so anything produced while it runs still queues behind.
         const buffer = new FramedSocketWriteBuffer();
         const sent: number[] = [];
         const reentrant = {
            send(data: Uint8Array): void {
               sent.push(data[0]);
               if (data[0] === 1) {
                  buffer.sendOrQueue(reentrant, message(9));
               }
            }
         };

         buffer.sendOrQueue(undefined, message(1));
         buffer.sendOrQueue(undefined, message(2));
         buffer.flush(reentrant);

         expect(sent).toEqual([1, 2, 9]);
      });
   });

   describe('supportsConnectionResilience', () => {
      // The seam the whole feature hangs off. Theia began binding the write buffer in 1.71; asking
      // the container rather than parsing a version is what lets one supported range cover both.
      it('asks whether Theia bound the write buffer, and nothing else', () => {
         const asked: unknown[] = [];

         expect(
            supportsConnectionResilience(identifier => {
               asked.push(identifier);
               return true;
            })
         ).toBe(true);
         expect(asked).toEqual([SocketWriteBuffer]);
      });

      it('reports unsupported when that binding is absent', () => {
         expect(supportsConnectionResilience(() => false)).toBe(false);
      });

      it('names what is lost and what to upgrade to, not just what is missing', () => {
         // The failures this guards against are silent, so a reader who sees only "not installed"
         // has no way to judge whether it matters.
         warnConnectionResilienceUnavailable('frontend');

         const warning = vi.mocked(console.warn).mock.calls.at(-1)?.[0] as string;
         expect(warning).toContain('frontend');
         expect(warning).toContain('1.71');
         expect(warning).toMatch(/lose or.*reorder/s);
      });
   });

   it('does not alias the buffer handed in by the caller', () => {
      const buffer = new FramedSocketWriteBuffer();
      const socket = recordingSocket();
      const reused = message(1, 2);

      buffer.buffer(reused);
      reused[0] = 99;
      buffer.flush(socket);

      expect(Array.from(socket.sent[0])).toEqual([1, 2]);
   });
});
