/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import 'reflect-metadata';
import { type MessageService } from '@theia/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type ConnectionTarget, DefaultConnectionReporter } from '../../src/browser/connection-reporter';

const target: ConnectionTarget = { connectingMessage: 'Connecting…', connectedMessage: 'Connected.' };

function makeReporter(): {
   reporter: DefaultConnectionReporter;
   progress: { cancel: ReturnType<typeof vi.fn> };
   messages: { showProgress: ReturnType<typeof vi.fn>; info: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };
} {
   const progress = { cancel: vi.fn() };
   const messages = {
      showProgress: vi.fn(async () => progress),
      info: vi.fn(),
      error: vi.fn(async (): Promise<string | undefined> => undefined)
   };
   const reporter = new DefaultConnectionReporter();
   Object.assign(reporter, { messageService: messages as unknown as MessageService });
   return { reporter, progress, messages };
}

describe('DefaultConnectionReporter', () => {
   beforeEach(() => vi.useFakeTimers());
   afterEach(() => vi.useRealTimers());

   it('stays silent for an attempt that connects quickly', async () => {
      const { reporter, messages } = makeReporter();
      reporter.connecting(target).connected();
      await vi.advanceTimersByTimeAsync(10_000);

      expect(messages.showProgress).not.toHaveBeenCalled();
      expect(messages.info).not.toHaveBeenCalled();
   });

   /** An attempt dropped without an end would otherwise leave its progress up for good. */
   it('ends a cancelled attempt without a notification, taking down its progress', async () => {
      const { reporter, progress, messages } = makeReporter();
      const early = reporter.connecting(target);
      early.cancelled();
      const late = reporter.connecting(target);
      await vi.advanceTimersByTimeAsync(3_000);
      late.cancelled();
      await vi.advanceTimersByTimeAsync(10_000);

      expect(messages.showProgress).toHaveBeenCalledTimes(1);
      expect(progress.cancel).toHaveBeenCalledTimes(1);
      expect(messages.info).not.toHaveBeenCalled();
      expect(messages.error).not.toHaveBeenCalled();
   });

   /** Silence through a long wait reads as a hang, and a notice on every quick
    *  start is noise. */
   it('shows progress for a slow attempt, then one result', async () => {
      const { reporter, progress, messages } = makeReporter();
      const attempt = reporter.connecting(target);
      await vi.advanceTimersByTimeAsync(3_000);
      expect(messages.showProgress).toHaveBeenCalledWith({ text: 'Connecting…' });

      attempt.connected();
      await vi.advanceTimersByTimeAsync(0);
      expect(progress.cancel).toHaveBeenCalledTimes(1);
      expect(messages.info).toHaveBeenCalledWith('Connected.');
      expect(messages.error).not.toHaveBeenCalled();
   });

   it('reports a failure once while the target keeps failing, then its recovery', async () => {
      const { reporter, messages } = makeReporter();
      reporter.connecting(target).failed('Could not connect.');
      const retried = reporter.connecting(target);
      await vi.advanceTimersByTimeAsync(10_000);
      retried.failed('Could not connect.');
      expect(messages.error).toHaveBeenCalledTimes(1);
      // A target that is failing shows no progress for its automatic retries.
      expect(messages.showProgress).not.toHaveBeenCalled();

      reporter.connecting(target).connected();
      expect(messages.info).toHaveBeenCalledWith('Connected.');
   });

   it('offers a Retry when the head can retry at once, and reports that attempt afresh', async () => {
      const { reporter, messages } = makeReporter();
      const retry = vi.fn();
      messages.error.mockResolvedValueOnce('Retry');
      reporter.connecting(target).failed('Could not connect.', retry);
      await vi.advanceTimersByTimeAsync(0);

      expect(messages.error).toHaveBeenCalledWith('Could not connect.', 'Retry');
      expect(retry).toHaveBeenCalledTimes(1);
      reporter.connecting(target).failed('Could not connect.');
      expect(messages.error).toHaveBeenCalledTimes(2);
   });

   it('keeps only the first end an attempt reports', () => {
      const { reporter, messages } = makeReporter();
      const attempt = reporter.connecting(target);
      attempt.failed('Could not connect.');
      attempt.connected();
      attempt.failed('Could not connect.');

      expect(messages.error).toHaveBeenCalledTimes(1);
      expect(messages.info).not.toHaveBeenCalled();
   });
});
