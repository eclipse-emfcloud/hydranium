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
function recordingSocket(): { sent: Uint8Array[]; sequences: number[]; send(data: Uint8Array, sequence: number): void } {
   const sent: Uint8Array[] = [];
   const sequences: number[] = [];
   return {
      sent,
      sequences,
      send: (data: Uint8Array, sequence: number) => {
         sent.push(data);
         sequences.push(sequence);
      }
   };
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
      const buffer = createFramedSocketWriteBuffer({ bufferBytes: 64 });

      buffer.buffer(new Uint8Array(64));

      expect(() => buffer.buffer(message(1))).toThrow(/Max disconnected buffer size exceeded/);
   });

   it('falls back to the default when no limit is configured', () => {
      expect(createFramedSocketWriteBuffer().maxBytes).toBe(FramedSocketWriteBuffer.DEFAULT_MAX_BYTES);
      expect(createFramedSocketWriteBuffer({ bufferBytes: 0 }).maxBytes).toBe(FramedSocketWriteBuffer.DEFAULT_MAX_BYTES);
   });

   it('announces an overflow once, with what it was holding', () => {
      const buffer = createFramedSocketWriteBuffer({ bufferBytes: 64 });
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

   it('says what was stranded when a send throws, and that nothing will retry it', () => {
      // Theia flushes once, from its reconnect handler, and by then that handler has deregistered.
      // Without this the stall is reported only once the stuck backlog hits its limit, as an
      // overflow, which names the wrong cause: the socket is up rather than absent.
      const buffer = new FramedSocketWriteBuffer();
      buffer.buffer(message(1));
      buffer.buffer(message(2));
      buffer.buffer(message(3));

      expect(() =>
         buffer.flush({
            send(data: Uint8Array): void {
               if (data[0] === 2) {
                  throw new Error('transport gone');
               }
            }
         })
      ).toThrow(/transport gone/);

      const reported = vi.mocked(console.error).mock.calls.at(-1)?.[0] as string;
      expect(reported).toContain('send failed 1 message(s)');
      expect(reported).toContain('2 still queued');
      expect(reported).toMatch(/nothing will retry/);
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

   describe('acknowledged delivery', () => {
      it('numbers messages in the order they go out, backlog included', () => {
         const buffer = new FramedSocketWriteBuffer();
         const socket = recordingSocket();

         buffer.sendOrQueue(socket, message(1));
         buffer.sendOrQueue(undefined, message(2));
         buffer.acknowledge(1);
         buffer.flush(socket);
         buffer.sendOrQueue(socket, message(3));

         expect(socket.sequences).toEqual([1, 2, 3]);
      });

      it('resends a message sent into a socket that died unnoticed, under its own number', () => {
         // The defect this exists for: the dead socket accepted the write, so nothing else would
         // ever send it again.
         const buffer = new FramedSocketWriteBuffer();
         const dead = recordingSocket();
         const replacement = recordingSocket();
         buffer.markPeerDeduplicates();

         buffer.sendOrQueue(dead, message(1));
         buffer.flush(replacement);

         expect(replacement.sent.map(entry => entry[0])).toEqual([1]);
         expect(replacement.sequences).toEqual([1]);
      });

      it('resends nothing to a peer that has not shown it drops duplicates', () => {
         // A peer without the hardening would apply the resent message a second time.
         const buffer = new FramedSocketWriteBuffer();
         const dead = recordingSocket();
         const replacement = recordingSocket();

         buffer.sendOrQueue(dead, message(1));
         buffer.flush(replacement);
         buffer.markPeerDeduplicates();
         buffer.flush(replacement);

         expect(replacement.sent).toHaveLength(0);
      });

      it('takes an acknowledgement as the peer showing it drops duplicates', () => {
         const buffer = new FramedSocketWriteBuffer();
         const dead = recordingSocket();
         const replacement = recordingSocket();

         buffer.sendOrQueue(dead, message(1));
         buffer.sendOrQueue(dead, message(2));
         buffer.acknowledge(1);
         buffer.flush(replacement);

         expect(replacement.sequences).toEqual([2]);
      });

      it('needs the peer to show it again after a drain, which ends the session', () => {
         const buffer = new FramedSocketWriteBuffer();
         const replacement = recordingSocket();
         buffer.markPeerDeduplicates();

         buffer.drain();
         buffer.sendOrQueue(recordingSocket(), message(1));
         buffer.flush(replacement);

         expect(replacement.sent).toHaveLength(0);
      });

      it('resends what is unacknowledged ahead of the backlog', () => {
         const buffer = new FramedSocketWriteBuffer();
         const dead = recordingSocket();
         const replacement = recordingSocket();
         buffer.markPeerDeduplicates();

         buffer.sendOrQueue(dead, message(1));
         buffer.sendOrQueue(undefined, message(2));
         buffer.flush(replacement);

         expect(replacement.sent.map(entry => entry[0])).toEqual([1, 2]);
         expect(replacement.sequences).toEqual([1, 2]);
      });

      it('resends nothing the peer has acknowledged', () => {
         const buffer = new FramedSocketWriteBuffer();
         const dead = recordingSocket();
         const replacement = recordingSocket();

         buffer.sendOrQueue(dead, message(1));
         buffer.sendOrQueue(dead, message(2));
         buffer.sendOrQueue(dead, message(3));
         buffer.acknowledge(2);
         buffer.flush(replacement);

         expect(replacement.sequences).toEqual([3]);
      });

      it('keeps resending until acknowledged, across any number of reconnects', () => {
         const buffer = new FramedSocketWriteBuffer();
         const first = recordingSocket();
         const second = recordingSocket();
         buffer.markPeerDeduplicates();

         buffer.sendOrQueue(recordingSocket(), message(1));
         buffer.flush(first);
         buffer.flush(second);

         expect(second.sequences).toEqual([1]);
      });

      it('numbers from the start again after a drain, which ends the session', () => {
         const buffer = new FramedSocketWriteBuffer();
         const socket = recordingSocket();

         buffer.sendOrQueue(recordingSocket(), message(1));
         buffer.drain();
         buffer.flush(socket);
         buffer.sendOrQueue(socket, message(2));

         expect(socket.sequences).toEqual([1]);
         expect(Array.from(socket.sent[0])).toEqual([2]);
      });

      it('does not count kept copies against the disconnected limit', () => {
         // A large transfer on a healthy connection must leave an outage its full room.
         const buffer = createFramedSocketWriteBuffer({ bufferBytes: 64 });
         const socket = recordingSocket();

         buffer.sendOrQueue(socket, new Uint8Array(64));

         expect(() => buffer.buffer(new Uint8Array(64))).not.toThrow();
      });

      it('discards its copies once the peer leaves too much unacknowledged, and warns once', () => {
         // A peer without the hardening never acknowledges, so the copies would otherwise grow for
         // the whole session.
         const buffer = new FramedSocketWriteBuffer();
         buffer.maxUnacknowledgedBytes = 4;
         buffer.markPeerDeduplicates();
         const socket = recordingSocket();
         const replacement = recordingSocket();

         for (let index = 0; index < 10; index++) {
            buffer.sendOrQueue(socket, message(index, index));
         }
         buffer.flush(replacement);

         expect(socket.sent).toHaveLength(10);
         expect(replacement.sent.length).toBeLessThanOrEqual(2);
         expect(vi.mocked(console.warn)).toHaveBeenCalledTimes(1);
         expect(vi.mocked(console.warn).mock.calls[0][0]).toMatch(/has not acknowledged/);
      });

      it('says how many sent messages a drain discards unacknowledged', () => {
         // They are lost with the session, and nothing else reports them.
         const buffer = new FramedSocketWriteBuffer();
         buffer.sendOrQueue(recordingSocket(), message(1, 2));

         buffer.drain();

         expect(vi.mocked(console.warn).mock.calls.at(-1)?.[0]).toMatch(/1 sent but unacknowledged, 2 bytes/);
      });

      it('honours a configured limit on kept copies', () => {
         expect(createFramedSocketWriteBuffer({ unacknowledgedBytes: 8 }).maxUnacknowledgedBytes).toBe(8);
         expect(createFramedSocketWriteBuffer().maxUnacknowledgedBytes).toBe(FramedSocketWriteBuffer.DEFAULT_MAX_UNACKNOWLEDGED_BYTES);
      });

      it('does not keep a message whose send threw, so it is not sent under two numbers', () => {
         const buffer = new FramedSocketWriteBuffer();
         buffer.buffer(message(1));
         expect(() =>
            buffer.flush({
               send: () => {
                  throw new Error('transport gone');
               }
            })
         ).toThrow();

         const socket = recordingSocket();
         buffer.flush(socket);

         expect(socket.sent.map(entry => entry[0])).toEqual([1]);
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
