/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { Emitter, type Event } from '@theia/core/lib/common/event';
import { SocketWriteBuffer } from '@theia/core/lib/common/messaging/socket-write-buffer';

/**
 * Prefix on every connection log line, deliberately shared by the browser and the
 * server so one pattern greps a console and a pod log at once.
 */
export const CONNECTION_LOG_PREFIX = '[connection]';

/**
 * The part of a socket this buffer uses. Narrower than the socket type Theia
 * declares, which keeps the dependency honest and lets the class be tested
 * without a connection.
 */
export interface MessageSink {
   send(data: Uint8Array): void;
}

/**
 * Reported when the buffer runs out of room. The message that did not fit is
 * rejected, and so is every further one for as long as the buffer stays full.
 * Reconnecting drains it and sending resumes, but whatever was rejected
 * meanwhile is gone, so the two sides no longer agree about the session.
 */
export interface ConnectionBufferOverflow {
   /** Messages held when the limit was reached. */
   readonly messages: number;
   /** Bytes held when the limit was reached. */
   readonly bytes: number;
   /** The limit in force, so a reader can tell what to raise it to. */
   readonly maxBytes: number;
}

/**
 * Holds messages while the peer is away and re-sends them when it returns.
 *
 * Theia copies them into one growing byte array and flushes that with a single
 * `send`. A websocket delivers whole messages rather than a byte stream, so
 * Theia's encoding adds no length prefix and every reader assumes one delivery
 * is one message. The concatenated flush breaks that assumption: the reader
 * decodes the first message and throws away the bytes behind it.
 *
 * Changed here: one entry per message, sent one at a time, so each arrives as
 * its own delivery. The buffer also decides whether a message may go out
 * directly — see {@link sendOrQueue} — because a caller that decides for itself
 * is how messages end up overtaking a backlog.
 *
 * Unchanged from Theia: exceeding the limit rejects the message rather than
 * dropping something silently. The limit is settable, since the right value
 * depends on how long an outage has to survive.
 *
 * Logging goes to `console` rather than through a `Logger`. On the browser side
 * Theia's preloader builds this before any Output channel exists, so there is
 * nothing else to write to; the {@link CONNECTION_LOG_PREFIX} keeps the lines
 * findable on both sides.
 */
export class FramedSocketWriteBuffer extends SocketWriteBuffer {
   /** Theia's fixed limit, kept as the default. */
   static readonly DEFAULT_MAX_BYTES = 100 * 1024;

   /**
    * Settable so a deployment can trade memory for longer outages.
    *
    * Consulted directly rather than through the base class's `maxBufferSize`,
    * which does not exist before Theia 1.71 — an `override` of it would not
    * compile against the oldest release this package supports. Nothing is lost:
    * `buffer`, `flush` and `drain` are all replaced here, so the base's own
    * limit is never reached.
    */
   maxBytes = FramedSocketWriteBuffer.DEFAULT_MAX_BYTES;

   protected pending: Uint8Array[] = [];
   protected pendingBytes = 0;
   protected overflowReported = false;
   protected readonly onOverflowEmitter = new Emitter<ConnectionBufferOverflow>();

   /** Fires once per outage when the limit is reached. */
   get onOverflow(): Event<ConnectionBufferOverflow> {
      return this.onOverflowEmitter.event;
   }

   /**
    * Sends `data` now only if nothing is waiting, and queues it otherwise.
    *
    * Callers say whether the peer is ready for a message; the buffer decides
    * whether it may go ahead of one already waiting. Splitting it this way is
    * the point: a caller that answers both questions from one flag is how a
    * fresh message ends up overtaking a backlog.
    */
   sendOrQueue(socket: MessageSink | undefined, data: Uint8Array): void {
      if (socket && !this.hasBacklog) {
         socket.send(data);
      } else {
         this.buffer(data);
      }
   }

   override buffer(data: Uint8Array): void {
      if (this.pendingBytes + data.byteLength > this.maxBytes) {
         this.reportOverflow();
         throw new Error(`Max disconnected buffer size exceeded by adding ${data.byteLength} bytes`);
      }
      // Copied for the same reason the base class copies: the caller owns `data`.
      this.pending.push(data.slice());
      this.pendingBytes += data.byteLength;
      if (this.pending.length === 1) {
         console.info(`${CONNECTION_LOG_PREFIX} buffering messages, the peer is disconnected`);
      }
   }

   override flush(socket: MessageSink): void {
      if (this.pending.length === 0) {
         return;
      }
      const count = this.pending.length;
      const bytes = this.pendingBytes;
      // Drained one by one rather than snapshot-then-send, so `hasBacklog` stays true until the last
      // message is out and anything produced meanwhile still queues behind it. Each message is
      // removed only once it has been sent, so a throwing send leaves the backlog intact and in
      // order rather than swallowing the message it failed on.
      while (this.pending.length > 0) {
         const message = this.pending[0];
         socket.send(message);
         this.pending.shift();
         this.pendingBytes -= message.byteLength;
      }
      this.overflowReported = false;
      console.info(`${CONNECTION_LOG_PREFIX} sent ${count} buffered message(s), ${bytes} bytes`);
   }

   override drain(): void {
      if (this.pending.length > 0) {
         console.warn(`${CONNECTION_LOG_PREFIX} discarded ${this.pending.length} buffered message(s), ${this.pendingBytes} bytes`);
      }
      this.reset();
   }

   /** Whether messages are still waiting to go out. */
   get hasBacklog(): boolean {
      return this.pending.length > 0;
   }

   protected reportOverflow(): void {
      if (this.overflowReported) {
         return;
      }
      this.overflowReported = true;
      const overflow: ConnectionBufferOverflow = { messages: this.pending.length, bytes: this.pendingBytes, maxBytes: this.maxBytes };
      console.error(
         `${CONNECTION_LOG_PREFIX} buffer full at ${overflow.maxBytes} bytes after ${overflow.messages} message(s); ` +
            'this message is rejected, and so is every further one until the peer returns'
      );
      this.onOverflowEmitter.fire(overflow);
   }

   protected reset(): void {
      this.pending = [];
      this.pendingBytes = 0;
      this.overflowReported = false;
   }
}

/** Named in the warning a skipped install emits, so the reader is told what to upgrade to. */
export const REQUIRED_THEIA_HINT = '@theia/core 1.71 or newer';

/**
 * Whether this Theia exposes the seam the reconnect hardening replaces.
 *
 * Theia only began binding {@link SocketWriteBuffer} in 1.71; before that each
 * connection built one privately, so there is no binding to rebind and no way
 * in. Every other API involved has been there throughout, which makes this one
 * probe the whole compatibility question — and it is a binding check rather
 * than a version parse, so it answers about the container actually in front of
 * us instead of a number that may have been overridden or vendored.
 *
 * Callers that get `false` must leave Theia's own wiring alone: rebinding half
 * of it would be worse than not rebinding at all.
 */
export function supportsConnectionResilience(isBound: (identifier: typeof SocketWriteBuffer) => boolean): boolean {
   return isBound(SocketWriteBuffer);
}

/**
 * The warning a skipped install emits. Says what is lost rather than only what
 * is missing: the failures this guards against are silent, so an adopter who
 * never sees this line has no other way to learn the guard is absent.
 */
export function warnConnectionResilienceUnavailable(tier: 'frontend' | 'backend'): void {
   console.warn(
      `${CONNECTION_LOG_PREFIX} ${tier} reconnect hardening NOT installed: this Theia does not expose an injectable ` +
         `socket write buffer (needs ${REQUIRED_THEIA_HINT}). Theia's own behaviour is left in place, which can lose or ` +
         'reorder messages when a socket drops and reconnects.'
   );
}

/** Builds a buffer with the given limit, or Theia's default when none is configured. */
export function createFramedSocketWriteBuffer(maxBytes?: number): FramedSocketWriteBuffer {
   const buffer = new FramedSocketWriteBuffer();
   if (typeof maxBytes === 'number' && maxBytes > 0) {
      buffer.maxBytes = maxBytes;
   }
   return buffer;
}
