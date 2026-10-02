/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { CONNECTION_LOG_PREFIX } from './framed-socket-write-buffer';

/** The socket.io event that carries the highest message number a side has accepted. */
export const ACKNOWLEDGEMENT_EVENT = 'hydranium:ack';

/**
 * What one side has received on a session: drops a message it already accepted
 * and acknowledges the rest.
 *
 * The peer resends everything unacknowledged when a session resumes, because it
 * cannot tell which of its messages died with the old socket, so every resumed
 * session can repeat messages already delivered. Delivering one twice corrupts
 * anything applied by position, just as losing one does.
 *
 * Acknowledges once enough has arrived, and otherwise after a short delay. A
 * timer alone is not enough: a background tab throttles timers, and the peer
 * holds every unacknowledged message until the acknowledgement arrives. The
 * first message of a session is acknowledged at once, because the peer resends
 * nothing until an acknowledgement shows it may.
 *
 * Belongs to one session. A new session numbers from the start again, so it
 * needs a new instance.
 */
export class InboundMessageSequence {
   static readonly ACKNOWLEDGE_AFTER_MESSAGES = 64;
   static readonly ACKNOWLEDGE_AFTER_BYTES = 32 * 1024;
   static readonly ACKNOWLEDGE_DELAY_MS = 100;

   protected lastAccepted = 0;
   protected messagesSinceAcknowledgement = 0;
   protected bytesSinceAcknowledgement = 0;
   protected acknowledgementTimer: ReturnType<typeof setTimeout> | undefined;

   constructor(protected readonly sendAcknowledgement: (sequence: number) => void) {}

   /**
    * Whether to deliver a message that arrived with `sequence`.
    *
    * A message without a number comes from a peer that does not number them,
    * and is delivered as it is. A duplicate is still acknowledged: the peer
    * resent it because an earlier acknowledgement was lost, and keeps it until
    * one arrives.
    *
    * A skipped number is delivered past, with a warning: the skipped messages
    * are lost, and this is the one place that can tell.
    */
   accept(sequence: unknown, bytes: number): boolean {
      if (typeof sequence !== 'number') {
         return true;
      }
      const isFirst = this.lastAccepted === 0;
      const isNew = sequence > this.lastAccepted;
      if (isNew) {
         if (sequence > this.lastAccepted + 1) {
            const missing = sequence - this.lastAccepted - 1;
            console.warn(
               `${CONNECTION_LOG_PREFIX} lost ${missing} message(s), numbered ${this.lastAccepted + 1} to ${sequence - 1}; ` +
                  'they never arrived and nothing will resend them'
            );
         }
         this.lastAccepted = sequence;
      }
      this.messagesSinceAcknowledgement++;
      this.bytesSinceAcknowledgement += bytes;
      if (
         isFirst ||
         this.messagesSinceAcknowledgement >= InboundMessageSequence.ACKNOWLEDGE_AFTER_MESSAGES ||
         this.bytesSinceAcknowledgement >= InboundMessageSequence.ACKNOWLEDGE_AFTER_BYTES
      ) {
         this.acknowledge();
      } else {
         this.acknowledgementTimer ??= setTimeout(() => this.acknowledge(), InboundMessageSequence.ACKNOWLEDGE_DELAY_MS);
      }
      return isNew;
   }

   /** Sends the acknowledgement now rather than waiting for more traffic. */
   acknowledge(): void {
      this.cancelTimer();
      this.messagesSinceAcknowledgement = 0;
      this.bytesSinceAcknowledgement = 0;
      this.sendAcknowledgement(this.lastAccepted);
   }

   dispose(): void {
      this.cancelTimer();
   }

   protected cancelTimer(): void {
      clearTimeout(this.acknowledgementTimer);
      this.acknowledgementTimer = undefined;
   }
}
