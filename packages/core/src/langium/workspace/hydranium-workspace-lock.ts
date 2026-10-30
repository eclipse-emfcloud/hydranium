/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { type Clock, type Tracer } from '@hydranium/protocol';
import { DefaultWorkspaceLock, Deferred, isOperationCancelled, type MaybePromise, ReadPriority } from '@hydranium/langium';
import { type CancellationToken, type Disposable } from 'vscode-languageserver-protocol';
import { type LogNameOptions } from '../diagnostics/logger.js';
import { type ServerSharedServicesMinimal } from '../shared-services.js';
import {
   currentReadHold,
   type ReadHold,
   releaseCallerReadHolds,
   runInReadLockScope,
   runInWriteLockScope,
   runOutsideReadLockScope
} from './lock-scope.js';

/** Constructor options for {@link HydraniumWorkspaceLock}. */
export interface HydraniumWorkspaceLockOptions extends LogNameOptions {
   /**
    * How long a write may keep running after a later write cancelled it, or
    * wait to start behind reads, before the lock logs a warning. Every later
    * write, and every read that is not immediate, waits meanwhile, so one that
    * never ends stops the server. Defaults to 10 s. `0` turns the check off.
    */
   readonly stalledWriteWarnMs?: number;
   /**
    * How long a queued write, or a read queued behind running queued reads,
    * waits for the reads that hold it off before it starts beside them. A read
    * that never ends, or waits for work that waits for the write or the queued
    * read, would otherwise stop every build. Defaults to 1 s. `0` starts it at
    * the next timer tick. A value past Node's longest timer, `Infinity`
    * included, waits that long, about 24.8 days.
    */
   readonly readHoldLimitMs?: number;
}

const DEFAULT_STALLED_WRITE_WARN_MS = 10_000;
const DEFAULT_READ_HOLD_LIMIT_MS = 1_000;
/** The longest timer Node keeps. It fires a longer one after 1 ms. */
const MAX_TIMER_MS = 2_147_483_647;

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
 * A read action is marked in its own scope (see `isInsideReadLock`), not the
 * write one, and holds every write off until it ends. In an immediate read, the
 * kind Langium runs each request in, a write it queues, a build it requests or
 * waits for through the document builder or the model service, and a queued
 * read it starts on this lock release that hold and the holds of the immediate
 * reads it is nested in while they wait (see `releaseReadHolds`), since what
 * they wait for is itself held off. Each takes its hold back once that wait is
 * over, as an immediate read, inside the write or queued read that ends it. A
 * wait for a parse, a recovery build or a member relink takes it back as it
 * settles instead, so a write that starts in between runs beside the read. A
 * write not yet started then waits for the read again, while one that started
 * meanwhile runs beside it, as beside any request Langium starts during a
 * write. A write or a queued read releases the holds whether or not the read
 * awaits it, so a request that queues one and reads on runs beside it. A queued
 * read keeps its own hold, so a write it queues waits for it. In a host without
 * a read-lock tracker, a build requested or waited for through the document
 * builder, the model service, a recovery build or a member relink releases
 * every running read instead, since the caller's is unknown, and a write or
 * read queued on this lock directly releases none. Any other wait for a build
 * still waits for the read. A write action runs outside the read scope, since a
 * write queued from a read starts in that read's context.
 *
 * **A write that reads hold off for `readHoldLimitMs` starts beside them.**
 * A read that never ends, that awaits a write while it still holds it off, or
 * that awaits work another read finishes only after that write, would
 * otherwise stop every build. The reads then run beside it, and the lock
 * warns. A read that running queued reads hold off for as long starts beside
 * them too, since Langium starts the next queued reads only once those end,
 * and a queued read that awaits one, such as a recovery build's, would wait
 * for itself. Those reads still hold writes off, as immediate reads. A read
 * its caller released holds nothing off and is left to take its hold back.
 *
 * **A write that reads hold back is reported.** Langium runs each document
 * request, such as completion or hover, as an immediate read and starts a
 * write only once none is left, so a slow provider, or a steady stream of
 * requests, holds every later write off. With the defaults the read-hold
 * limit starts the write first and warns, so this report comes only from a
 * `readHoldLimitMs` longer than `stalledWriteWarnMs`.
 */
export class HydraniumWorkspaceLock extends DefaultWorkspaceLock {
   /** Backs {@link writeCancellations}. */
   protected cancelledWriteCount = 0;
   protected readonly clock: Clock;
   protected readonly tracer: Tracer;
   protected readonly stalledWriteWarnMs: number;
   protected runningWrite?: RunningWrite;
   /** Writes queued and not yet started. */
   protected queuedWrites = 0;
   /** Reads queued and not yet started, which a running batch of queued reads holds off as a write would. */
   protected queuedReads = 0;
   /** Times the first queued write from when it became first. It fires once, so each held-back write is reported once. */
   protected heldBackTimer?: Disposable;
   protected readonly readHoldLimitMs: number;
   /** Starts the first queued write or read beside the reads still holding it, once it has waited {@link readHoldLimitMs}. */
   protected readHoldLimitTimer?: Disposable;
   /**
    * The reads running now, each with the release {@link releaseHeldReads} calls, whether it still runs in a batch
    * of queued reads, and whether its caller has released it.
    */
   protected readonly runningReads = new Map<ReadHold, { release: () => () => void; queued: boolean; released: () => boolean }>();

   constructor(services: Pick<ServerSharedServicesMinimal, 'Clock' | 'Tracer'>, options: HydraniumWorkspaceLockOptions = {}) {
      super();
      this.clock = services.Clock;
      this.tracer = services.Tracer.for(options.logName ?? 'WorkspaceLock');
      this.stalledWriteWarnMs = Math.min(options.stalledWriteWarnMs ?? DEFAULT_STALLED_WRITE_WARN_MS, MAX_TIMER_MS);
      this.readHoldLimitMs = Math.min(options.readHoldLimitMs ?? DEFAULT_READ_HOLD_LIMIT_MS, MAX_TIMER_MS);
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

   /** The reads running now, which a build request releases in a host without a read-lock tracker. */
   runningReadHolds(): ReadHold[] {
      return [...this.runningReads.keys()];
   }

   override write(action: (token: CancellationToken) => MaybePromise<void>): Promise<void> {
      return releaseCallerReadHolds(this, retake => {
         // The first queued write times itself, also when a queued read is timed already.
         if (++this.queuedWrites === 1) {
            this.restartHeldBackTimer();
         }
         return super.write(async token => {
            try {
               this.queuedWrites--;
               this.restartHeldBackTimer();
               await runOutsideReadLockScope(() => runInWriteLockScope(() => this.runWrite(action, token)));
            } finally {
               // Before Langium sees the write end, so its next write waits for the read.
               retake();
            }
         });
      });
   }

   override read<T>(action: () => MaybePromise<T>, priority?: ReadPriority): Promise<T> {
      // A queued read waits behind a queued write, which waits for the caller's read.
      return priority === ReadPriority.Immediate
         ? this.trackRead(action, priority)
         : releaseCallerReadHolds(this, retake => this.trackRead(action, priority, retake));
   }

   /**
    * Run `action` as a read Langium tracks through a stand-in, which a release settles and a take-back registers anew.
    * `ended` runs as the action settles, before Langium sees the read end.
    */
   protected trackRead<T>(action: () => MaybePromise<T>, priority?: ReadPriority, ended?: () => void): Promise<T> {
      const result = new Deferred<T>();
      const start = new Deferred<void>();
      let released = new Deferred<void>();
      let releases = 0;
      // Langium tracks this rather than the action, so a released read holds no write off.
      const standIn = (): Promise<void> => Promise.race([running.then(noop, noop), released.promise]);
      const release = (): (() => void) => {
         if (releases++ === 0) {
            released.resolve();
         }
         let taken = false;
         return () => {
            if (taken) {
               return;
            }
            taken = true;
            if (--releases === 0) {
               // Immediate: a write not yet started waits for it, and one already running runs on beside it.
               released = new Deferred<void>();
               void super.read(standIn, ReadPriority.Immediate);
            }
         };
      };
      const hold: ReadHold = {
         lock: this,
         outer: currentReadHold(),
         // Its caller queued it to read between writes, so only the read-hold limit releases it.
         release: priority === ReadPriority.Immediate ? release : () => noop
      };
      // Chained now, so the action runs in the caller's context, not the one Langium drains its queue in.
      const running = start.promise.then(() => runInReadLockScope(action, hold));
      // Registered before the stand-in's own reaction to `running`, so it runs first.
      running.then(
         value => {
            this.runningReads.delete(hold);
            ended?.();
            result.resolve(value);
         },
         (error: unknown) => {
            this.runningReads.delete(hold);
            ended?.();
            // Langium resolves a queued read its token cancelled, and hands an immediate one's error on.
            if (priority !== ReadPriority.Immediate && isOperationCancelled(error)) {
               result.resolve(undefined as T);
            } else {
               result.reject(error);
            }
         }
      );
      const queued = priority !== ReadPriority.Immediate;
      if (queued) {
         this.queuedReads++;
         if (!this.readHoldLimitTimer) {
            this.restartHeldBackTimer();
         }
      }
      void super.read(() => {
         if (queued && --this.queuedReads === 0 && this.queuedWrites === 0) {
            this.readHoldLimitTimer?.dispose();
            this.readHoldLimitTimer = undefined;
         }
         this.runningReads.set(hold, { release, queued, released: () => releases > 0 });
         start.resolve();
         return standIn();
      }, priority);
      return result.promise;
   }

   /** Time a queued write from now, so one that reads hold back is reported, and started once it has waited too long. */
   protected restartHeldBackTimer(): void {
      this.heldBackTimer?.dispose();
      this.heldBackTimer = undefined;
      this.readHoldLimitTimer?.dispose();
      this.readHoldLimitTimer = undefined;
      if (this.queuedWrites > 0 && this.stalledWriteWarnMs > 0) {
         this.heldBackTimer = this.clock.setTimer(() => this.reportHeldBackWrite(), this.stalledWriteWarnMs);
      }
      if (this.queuedWrites > 0 || this.queuedReads > 0) {
         this.readHoldLimitTimer = this.clock.setTimer(() => this.releaseHeldReads(), this.readHoldLimitMs);
      }
   }

   /**
    * Release every running read that holds the queued write off for good, so
    * the write starts beside them, and time it again, since Langium also waits
    * for reads that start meanwhile. With only reads queued, the running queued
    * reads end their batch, so Langium starts the next one, and take their
    * holds back at once as immediate reads, so a later write still waits for
    * them. A read its caller has released holds nothing off, and stays to take
    * its hold back. A cancelled write still running holds it instead, and starts
    * the timer again once it ends.
    */
   protected releaseHeldReads(): void {
      if (this.runningWrite) {
         return;
      }
      const writeWaits = this.queuedWrites > 0;
      const holding = [...this.runningReads].filter(([, read]) => !read.released() && (writeWaits || read.queued));
      if (holding.length > 0 && writeWaits) {
         this.tracer.warn(
            `A write has waited ${this.readHoldLimitMs} ms for ${holding.length} read(s), and now starts beside them. ` +
               'Those reads hold no write off until they end.'
         );
         for (const [hold, read] of holding) {
            // A release whose take-back never runs, so the read stays released.
            read.release();
            this.runningReads.delete(hold);
         }
      } else if (holding.length > 0) {
         this.tracer.warn(
            `A queued read has waited ${this.readHoldLimitMs} ms for ${holding.length} queued read(s), and now starts beside them. ` +
               'Those reads still hold writes off until they end.'
         );
         for (const [, read] of holding) {
            // Taken back at once as an immediate read, which ends the batch but not the hold on writes.
            read.release()();
            read.queued = false;
         }
      }
      // At least 1 ms, so a limit of 0 does not re-arm forever before Langium starts the write.
      this.readHoldLimitTimer = this.clock.setTimer(() => this.releaseHeldReads(), Math.max(this.readHoldLimitMs, 1));
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
         // From here the queued write waits for reads alone.
         this.restartHeldBackTimer();
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

   /** A cancelled write still running is {@link reportStalledWrite}'s to report. */
   protected reportHeldBackWrite(): void {
      if (this.runningWrite) {
         return;
      }
      this.tracer.warn(
         `A write has waited ${this.stalledWriteWarnMs} ms to start behind reads, and every later write, and every read that is not immediate, waits behind it. ` +
            'Likely causes: a slow LSP provider or a steady stream of requests, or a provider that awaits a build it cannot release its read for, such as one a promise of its own waits on. ' +
            'Langium runs each document request, such as completion or hover, as a workspace lock read.'
      );
   }

   protected reportStalledWrite(): void {
      this.tracer.warn(
         `A write is still running ${this.stalledWriteWarnMs} ms after it was cancelled, and every later write, and every read that is not immediate, waits behind it. ` +
            'Likely causes: a model-service write or rebuild from inside a build in a host with no write-lock scope tracker, ' +
            'which waits for the build it runs in, or a write action that ignores its cancellation token. ' +
            'See https://github.com/eclipse-emfcloud/hydranium/issues/245.'
      );
   }
}

function noop(): void {}
