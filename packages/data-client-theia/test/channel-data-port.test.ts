/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

// These browser modules touch `document` at load; the port only uses them as
// injection tokens.
vi.mock('@hydranium/client-theia/browser', () => ({
   ChannelLogger: class ChannelLogger {},
   ConnectionReporter: Symbol('ConnectionReporter')
}));
vi.mock('@theia/workspace/lib/browser', () => ({
   WorkspaceService: class WorkspaceService {}
}));
vi.mock('@theia/core/lib/browser/messaging/service-connection-provider', () => ({
   RemoteConnectionProvider: Symbol('RemoteConnectionProvider')
}));

import 'reflect-metadata';
import { DATA_SERVER_CONNECT_FAILED, DATA_SERVER_NOT_READY, resolve } from '@hydranium/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChannelDataPort } from '../src/browser/channel-data-port';

/** What the reporter was told, one entry per attempt. */
interface ReportedAttempt {
   outcome?: 'connected' | 'failed' | 'cancelled';
   message?: string;
}

class TestPort extends ChannelDataPort {
   protected readonly servicePath = '/services/test';
   readonly attempts: ReportedAttempt[] = [];
   readonly errors = vi.fn();
   readonly warnings = vi.fn();

   constructor() {
      super();
      Object.assign(this, {
         messageService: { error: this.errors },
         logger: { warn: this.warnings },
         connectionReporter: {
            connecting: () => {
               const attempt: ReportedAttempt = {};
               this.attempts.push(attempt);
               return {
                  connected: () => (attempt.outcome = 'connected'),
                  cancelled: () => (attempt.outcome = 'cancelled'),
                  failed: (message: string) => Object.assign(attempt, { outcome: 'failed', message })
               };
            }
         }
      });
   }
}

describe('ChannelDataPort', () => {
   beforeEach(() => vi.useFakeTimers());
   afterEach(() => vi.useRealTimers());

   it('reports a generation that becomes ready', () => {
      const port = new TestPort();
      port.connectionLifecycle.onConnecting?.();
      port.connectionLifecycle.onReady?.();
      expect(port.attempts).toEqual([{ outcome: 'connected' }]);
   });

   /** The connection keeps waiting for a server that is not there yet, with
    *  nothing reported unless a bound says so. */
   it('reports a generation not ready after 30 s, and then its recovery', async () => {
      const port = new TestPort();
      port.connectionLifecycle.onConnecting?.();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(port.attempts[0]).toEqual({ outcome: 'failed', message: 'The data server did not answer within 30 seconds.' });

      port.connectionLifecycle.onReady?.();
      expect(port.attempts[1]).toEqual({ outcome: 'connected' });
   });

   it('reports a generation that fails', () => {
      const port = new TestPort();
      port.connectionLifecycle.onConnecting?.();
      port.connectionLifecycle.onFailed?.(new Error('boom'));
      expect(port.attempts).toEqual([{ outcome: 'failed', message: 'Could not connect to the data server.' }]);
   });

   /** The attempt is the failure's one notification; the protocol's own report
    *  of it would be a second. */
   it('leaves the connection failures to the reporter once the lifecycle is in use', () => {
      const port = new TestPort();
      port.connectionLifecycle.onConnecting?.();
      port.reportError(new Error('boom'), resolve(DATA_SERVER_CONNECT_FAILED, { detail: 'boom' }));
      port.reportError(new Error('boom'), resolve(DATA_SERVER_NOT_READY, { detail: 'boom' }));
      expect(port.errors).not.toHaveBeenCalled();
      // The reporter's sentence has no detail, so the log keeps it.
      expect(port.warnings).toHaveBeenCalledTimes(2);
      expect(port.warnings).toHaveBeenCalledWith('Could not connect to the data server: boom');
   });

   /** An attempt dropped without an end would leave its progress up for good. */
   it('cancels an attempt a newer one takes over, and the one open at dispose', () => {
      const port = new TestPort();
      port.connectionLifecycle.onConnecting?.();
      port.connectionLifecycle.onConnecting?.();
      port.dispose();
      expect(port.attempts).toEqual([{ outcome: 'cancelled' }, { outcome: 'cancelled' }]);
   });

   it('refuses to connect once disposed', async () => {
      const port = new TestPort();

      port.dispose();

      await expect(port.connect()).rejects.toThrow('disposed');
   });

   it('still raises the connection failures when no lifecycle reports them', () => {
      const port = new TestPort();
      port.reportError(new Error('boom'), resolve(DATA_SERVER_CONNECT_FAILED, { detail: 'boom' }));
      expect(port.errors).toHaveBeenCalledWith('Could not connect to the data server: boom');
   });
});
