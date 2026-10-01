/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { type Clock, type Tracer } from '@hydranium/protocol';
import { DefaultWorkspaceLock, type MaybePromise } from '@hydranium/langium';
import { type CancellationToken, type Disposable } from 'vscode-languageserver-protocol';
import { type LogNameOptions } from '../diagnostics/logger.js';
import { type ServerSharedServicesMinimal } from '../shared-services.js';
import { runInWriteLockScope } from './write-lock-scope.js';

/** Constructor options for {@link HydraniumWorkspaceLock}. */
export interface HydraniumWorkspaceLockOptions extends LogNameOptions {
   /**
    * How long a write may keep running after a later write cancelled it before
    * the lock logs an error. Every write and read waits behind it meanwhile, so
    * one that never ends stops the server. Defaults to 10 s; `0` turns the
    * check off.
    */
   readonly stalledWriteWarnMs?: number;
}

const DEFAULT_STALLED_WRITE_WARN_MS = 10_000;

/** The write action a {@link HydraniumWorkspaceLock} is running, with the timer its cancellation started. */
export interface RunningWrite {
   stallTimer?: Disposable;
}

/**
 * Langium's {@link DefaultWorkspaceLock} with the write action marked as a
 * write-lock scope, so anything it reaches can be asked whether the lock is
 * already held (see `isInsideWriteLock`).
 *
 * The wrapping has to live HERE rather than at the facade's own `write` call
 * sites, because the holders worth detecting are mostly not the facade: Langium's
 * `DefaultWorkspaceManager.initialized` and `DefaultDocumentUpdateHandler` both
 * take this lock, and the reentrant shape that matters is an integrity rule or
 * build-phase pass running *inside* one of those builds and writing back through
 * the facade. Marking the scope at the lock covers every holder, present and
 * future, including an adopter's own `write` calls.
 *
 * `read` is deliberately NOT marked. Read actions do not cancel a running holder,
 * so reaching the facade from inside one is not the hazard, and marking them
 * would turn ordinary read-then-write sequences into false positives.
 */
export class HydraniumWorkspaceLock extends DefaultWorkspaceLock {
   /** Backs {@link writeCancellations}. */
   protected cancelledWriteCount = 0;
   protected readonly clock: Clock;
   protected readonly tracer: Tracer;
   protected readonly stalledWriteWarnMs: number;
   protected runningWrite?: RunningWrite;

   constructor(services: Pick<ServerSharedServicesMinimal, 'Clock' | 'Tracer'>, options: HydraniumWorkspaceLockOptions = {}) {
      super();
      this.clock = services.Clock;
      this.tracer = services.Tracer.for(options.logName ?? 'WorkspaceLock');
      this.stalledWriteWarnMs = options.stalledWriteWarnMs ?? DEFAULT_STALLED_WRITE_WARN_MS;
   }

   /**
    * How many calls have cancelled the lock's latest write: every `write`,
    * which cancels the write before it, and every `cancelWrite`. A caller that
    * reads this right after queuing a write, and reads the same number later,
    * holds a write nothing has cancelled, whether it is still queued or
    * already running. Its token answers that only once the write runs, since
    * a queued write has not been handed it yet.
    */
   get writeCancellations(): number {
      return this.cancelledWriteCount;
   }

   override write(action: (token: CancellationToken) => MaybePromise<void>): Promise<void> {
      return super.write(token => runInWriteLockScope(() => this.runWrite(action, token)));
   }

   /** Run `action` as {@link runningWrite}, so a cancellation while it runs can time it. */
   protected async runWrite(action: (token: CancellationToken) => MaybePromise<void>, token: CancellationToken): Promise<void> {
      const running: RunningWrite = {};
      this.runningWrite = running;
      try {
         await action(token);
      } finally {
         running.stallTimer?.dispose();
         if (this.runningWrite === running) {
            this.runningWrite = undefined;
         }
      }
   }

   /**
    * Counted here rather than in {@link write}, because Langium's `write` cancels
    * through this method too. A write running when this is called has been
    * cancelled, by this call or an earlier one, so its timer starts here.
    */
   override cancelWrite(): void {
      this.cancelledWriteCount++;
      const running = this.runningWrite;
      if (running && !running.stallTimer && this.stalledWriteWarnMs > 0) {
         running.stallTimer = this.clock.setTimer(() => this.reportStalledWrite(), this.stalledWriteWarnMs);
      }
      super.cancelWrite();
   }

   protected reportStalledWrite(): void {
      this.tracer.error(
         `A write is still running ${this.stalledWriteWarnMs} ms after it was cancelled, and every write and read waits behind it. ` +
            'Likely causes: a model-service write or rebuild from inside a build in a host with no write-lock scope tracker, ' +
            'which waits for the build it runs in, or a write action that ignores its cancellation token. ' +
            'See https://github.com/eclipse-emfcloud/hydranium/issues/245.'
      );
   }
}
