/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InboundMessageSequence } from '../../src/common/inbound-message-sequence';

describe('InboundMessageSequence', () => {
   let acknowledged: number[];
   let inbound: InboundMessageSequence;

   beforeEach(() => {
      vi.useFakeTimers();
      acknowledged = [];
      inbound = new InboundMessageSequence(sequence => void acknowledged.push(sequence));
   });

   afterEach(() => {
      inbound.dispose();
      vi.useRealTimers();
      vi.restoreAllMocks();
   });

   it('delivers each number once', () => {
      // A resumed session resends everything unacknowledged, some of which already arrived.
      expect([1, 2, 1, 2, 3].map(sequence => inbound.accept(sequence, 1))).toEqual([true, true, false, false, true]);
   });

   it('delivers a message without a number, from a peer that does not number them', () => {
      expect(inbound.accept(undefined, 1)).toBe(true);
      expect(inbound.accept(undefined, 1)).toBe(true);
   });

   it('acknowledges the first message of a session at once', () => {
      // The peer resends nothing until an acknowledgement shows it may.
      inbound.accept(1, 1);

      expect(acknowledged).toEqual([1]);
   });

   it('acknowledges the highest accepted number after a short delay', () => {
      inbound.accept(1, 1);
      inbound.accept(2, 1);
      inbound.accept(3, 1);
      expect(acknowledged).toEqual([1]);

      vi.advanceTimersByTime(InboundMessageSequence.ACKNOWLEDGE_DELAY_MS);

      expect(acknowledged).toEqual([1, 3]);
   });

   it('acknowledges by message count without waiting for the timer', () => {
      // A background tab throttles timers, and the peer holds every message until this arrives.
      for (let sequence = 1; sequence <= InboundMessageSequence.ACKNOWLEDGE_AFTER_MESSAGES + 1; sequence++) {
         inbound.accept(sequence, 1);
      }

      expect(acknowledged).toEqual([1, InboundMessageSequence.ACKNOWLEDGE_AFTER_MESSAGES + 1]);
   });

   it('acknowledges by volume without waiting for the timer', () => {
      inbound.accept(1, InboundMessageSequence.ACKNOWLEDGE_AFTER_BYTES);

      expect(acknowledged).toEqual([1]);
   });

   it('acknowledges a duplicate, whose acknowledgement the peer evidently never received', () => {
      inbound.accept(1, 1);
      vi.advanceTimersByTime(InboundMessageSequence.ACKNOWLEDGE_DELAY_MS);
      inbound.accept(1, 1);
      vi.advanceTimersByTime(InboundMessageSequence.ACKNOWLEDGE_DELAY_MS);

      expect(acknowledged).toEqual([1, 1]);
   });

   it('warns about a skipped number, which is a lost message, and still delivers past it', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

      expect([1, 4, 5].map(sequence => inbound.accept(sequence, 1))).toEqual([true, true, true]);

      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toMatch(/lost 2 message\(s\), numbered 2 to 3/);
   });

   it('does not warn about a resent or unnumbered message', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

      [1, 2, 1, 2, undefined, 3].forEach(sequence => inbound.accept(sequence, 1));

      expect(warn).not.toHaveBeenCalled();
   });

   it('sends nothing once disposed', () => {
      inbound.accept(1, 1);
      inbound.accept(2, 1);
      inbound.dispose();
      vi.advanceTimersByTime(InboundMessageSequence.ACKNOWLEDGE_DELAY_MS);

      expect(acknowledged).toEqual([1]);
   });
});
