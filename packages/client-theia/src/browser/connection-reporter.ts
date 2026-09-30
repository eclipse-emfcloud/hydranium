/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { MessageService, nls, type Progress } from '@theia/core';
import { inject, injectable, type interfaces } from '@theia/core/shared/inversify';

/** What a head connects to, as the whole sentences reported about it. */
export interface ConnectionTarget {
   readonly connectingMessage: string;
   readonly connectedMessage: string;
}

/** One connection attempt; it reports exactly one end. */
export interface ConnectionAttempt {
   connected(): void;
   /** Ends the attempt with nothing to report, as when its head is disposed
    *  or a newer attempt takes over. */
   cancelled(): void;
   /**
    * `message` is the whole sentence to report. `retry`, when given, starts a
    * fresh attempt at once; a head without one keeps retrying on its own.
    */
   failed(message: string, retry?: () => void): void;
}

/**
 * How a head's connection attempts reach the user. A head calls
 * {@link connecting} for every attempt, a reconnect included, and keeps the
 * attempt's retries and bounds itself; this decides only what is shown. Rebind
 * the slot to show nothing, or something other than notifications.
 */
export interface ConnectionReporter {
   connecting(target: ConnectionTarget): ConnectionAttempt;
}
export const ConnectionReporter = Symbol('ConnectionReporter');

/**
 * Reports through Theia notifications: an attempt still running after
 * {@link connectingNoticeDelayMs} shows its progress, and an attempt ends in at
 * most one notification. A failure is shown once per target until it connects
 * again, so a head that keeps retrying does not raise one per attempt.
 */
@injectable()
export class DefaultConnectionReporter implements ConnectionReporter {
   @inject(MessageService) protected readonly messageService!: MessageService;

   protected readonly connectingNoticeDelayMs: number = 3_000;
   /** Targets whose last reported attempt failed. */
   protected readonly failing = new Set<ConnectionTarget>();

   connecting(target: ConnectionTarget): ConnectionAttempt {
      let progress: Promise<Progress> | undefined;
      const notice = this.failing.has(target)
         ? undefined
         : setTimeout(() => (progress = this.showConnecting(target)), this.connectingNoticeDelayMs);
      let settled = false;
      const settle = (): boolean => {
         if (settled) {
            return false;
         }
         settled = true;
         clearTimeout(notice);
         void progress?.then(shown => shown.cancel());
         return true;
      };
      return {
         connected: () => {
            if (settle() && (this.failing.delete(target) || progress)) {
               this.showConnected(target);
            }
         },
         cancelled: () => {
            settle();
         },
         failed: (message, retry) => {
            if (settle() && !this.failing.has(target)) {
               this.failing.add(target);
               void this.showFailed(target, message, retry);
            }
         }
      };
   }

   protected showConnecting(target: ConnectionTarget): Promise<Progress> {
      return this.messageService.showProgress({ text: target.connectingMessage });
   }

   protected showConnected(target: ConnectionTarget): void {
      this.messageService.info(target.connectedMessage);
   }

   protected async showFailed(target: ConnectionTarget, message: string, retry?: () => void): Promise<void> {
      if (!retry) {
         this.messageService.error(message);
         return;
      }
      const label = this.retryLabel();
      if ((await this.messageService.error(message, label)) === label) {
         // The retried attempt reports afresh, progress included.
         this.failing.delete(target);
         retry();
      }
   }

   protected retryLabel(): string {
      return nls.localize('hydranium/client-theia/connection-retry', 'Retry');
   }
}

/** Bind {@link DefaultConnectionReporter} unless the slot is bound already; every head calls this. */
export function bindConnectionReporter(bind: interfaces.Bind, isBound: interfaces.IsBound): void {
   if (!isBound(ConnectionReporter)) {
      bind(ConnectionReporter).to(DefaultConnectionReporter).inSingletonScope();
   }
}
