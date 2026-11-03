/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { type Clock, type Tracer } from '@hydranium/protocol';
import { DefaultWorkspaceLock, type MaybePromise, type WorkspaceLock, ReadPriority } from '@hydranium/langium';
import { type CancellationToken, type Disposable } from 'vscode-languageserver-protocol';
import { type LogNameOptions } from '../diagnostics/logger.js';
import { type ServerSharedServicesMinimal } from '../shared-services.js';
import { Deferred } from '@hydranium/protocol';
import { type ReadLockMark, refuseWaitInRead, runInReadLockScope } from './read-lock-scope.js';
import { readLockOwners, readLockScopeState } from './read-lock-scope-state.js';
import type { HydraniumDocumentBuilder } from '../document-builder/document-builder.js';
import { runInWriteLockScope } from './write-lock-scope.js';

/** Constructor options for {@link DefaultHydraniumWorkspaceLock}. */
export interface HydraniumWorkspaceLockOptions extends LogNameOptions {
   /**
    * How long a write may keep running after a later write cancelled it before
    * the lock logs a warning. Every other write and every queued read waits
    * behind it meanwhile, so one that never ends stops the server. A write
    * that has waited this long to start is warned about too. Defaults to 10 s.
    * `0` turns both checks off.
    */
   readonly stalledWriteWarnMs?: number;
   /**
    * How long a wait inside a read for a build or write may go on with none
    * running before it is refused with `ReadLockWaitError`, since that build or
    * write waits for the read. A period that ends with a build or write running
    * starts again. Defaults to 1 s. `0` refuses at the next timer tick, and
    * does not turn the check off. The timer does not keep a Node process
    * alive, so a script whose only pending work is such a wait exits without
    * the refusal.
    */
   readonly readWaitGraceMs?: number;
}

const DEFAULT_STALLED_WRITE_WARN_MS = 10_000;
const DEFAULT_READ_WAIT_GRACE_MS = 1_000;

/** The write action a {@link DefaultHydraniumWorkspaceLock} is running, with the timer its cancellation started. */
export interface RunningWrite {
   stallTimer?: Disposable;
}

/**
 * A workspace lock whose cancelled writes remain observable even when their
 * promises resolve normally. Recovery uses this counter to retry work that a
 * later write cancelled before it ran or while it was running.
 */
export interface HydraniumWorkspaceLock extends WorkspaceLock {
   /**
    * Monotonic count of calls to write or cancelWrite made while a write is
    * queued or running. A completed write must not count as cancelled by the
    * next write. Read immediately after queuing a write: an unchanged value
    * after it settles proves it was not cancelled. A changed value may also
    * describe a later write's cancellation, so retrying can do extra work.
    */
   readonly writeCancellations: number;
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
 * `read` is marked in a read scope of its own, not as a write. A read does not
 * cancel a running holder, so the hazard inside one is a wait for a build or
 * write, which waits for the read. Such a wait is refused once the read has run
 * on past `readWaitGraceMs` with no build running (see `refuseWaitInRead`).
 * Without async context, as in a browser, a read is marked only until its
 * first `await`, so a later wait hangs instead.
 */
export class DefaultHydraniumWorkspaceLock extends DefaultWorkspaceLock implements HydraniumWorkspaceLock {
   /** Backs {@link writeCancellations}. */
   protected cancelledWriteCount = 0;
   protected readonly clock: Clock;
   protected readonly tracer: Tracer;
   protected readonly stalledWriteWarnMs: number;
   protected readonly readWaitGraceMs: number;
   protected runningWrite?: RunningWrite;
   /** Writes queued and not yet started. */
   protected queuedWrites = 0;
   /** Whether a waiting write has been warned about since a write last started, so writes queued behind it are not. */
   protected waitingWriteWarned = false;
   /**
    * The reads this lock runs, each with whether it is `Immediate`, which
    * holds off writes but not queued reads. A read of another lock holds off
    * nothing here.
    */
   protected readonly ownReads = new WeakMap<ReadLockMark, boolean>();
   /** Read when a grace period ends, since the builder takes this lock and is built after it. */
   protected readonly documentBuilder: () => HydraniumDocumentBuilder | undefined;

   constructor(
      services: Pick<ServerSharedServicesMinimal, 'Clock' | 'Tracer'> & Partial<Pick<ServerSharedServicesMinimal, 'workspace'>>,
      options: HydraniumWorkspaceLockOptions = {}
   ) {
      super();
      this.clock = services.Clock;
      this.tracer = services.Tracer.for(options.logName ?? 'WorkspaceLock');
      this.stalledWriteWarnMs = options.stalledWriteWarnMs ?? DEFAULT_STALLED_WRITE_WARN_MS;
      this.readWaitGraceMs = options.readWaitGraceMs ?? DEFAULT_READ_WAIT_GRACE_MS;
      this.documentBuilder = () => services.workspace?.DocumentBuilder;
   }

   /**
    * How many calls to `write` or `cancelWrite` came while a write was still
    * queued or running. A caller that reads this right after queuing a
    * write, and reads the same number later, holds a write nothing has
    * cancelled, whether it is still queued or already running. Its token
    * answers that only once the write runs, since a queued write has not been
    * handed it yet. A different number read after the caller's write ended
    * does not prove that write was cancelled, since a later write that
    * cancels another queued or running write counts too. A caller that
    * retries on it builds once more than it needs to.
    */
   get writeCancellations(): number {
      return this.cancelledWriteCount;
   }

   override write(action: (token: CancellationToken) => MaybePromise<void>): Promise<void> {
      const queuedIn = readLockScopeState.scope?.current();
      let waiting: Disposable | undefined;
      const queued = super.write(token => {
         this.queuedWrites--;
         this.waitingWriteWarned = false;
         waiting?.dispose();
         // A write queued inside a read starts in that read's async context, and is no part of it.
         return runInReadLockScope(() => runInWriteLockScope(() => this.runWrite(action, token)), undefined);
      });
      // Counted after Langium's `write` has cancelled the write before it, so the new write does not count itself.
      this.queuedWrites++;
      if (this.stalledWriteWarnMs > 0) {
         waiting = this.clock.setTimer(() => this.reportWaitingWrite(queuedIn?.running === true), this.stalledWriteWarnMs);
      }
      return queued;
   }

   /** Run `action` marked as a read until it settles, so a wait inside it for a build or write is refused (see `refuseWaitInRead`). */
   override read<T>(action: () => MaybePromise<T>, priority?: ReadPriority): Promise<T> {
      const queued = { started: false };
      const reading = super.read(async () => {
         queued.started = true;
         const ended = new Deferred<void>();
         const read = {
            running: true as boolean,
            ended: ended.promise,
            startGrace: (refuse: () => void) => this.startReadWaitGrace(refuse)
         } satisfies ReadLockMark;
         this.ownReads.set(read, priority === ReadPriority.Immediate);
         readLockOwners.set(read, this);
         try {
            return await runInReadLockScope(action, read);
         } finally {
            read.running = false;
            ended.resolve();
         }
      }, priority);
      return priority === ReadPriority.Immediate ? reading : this.refuseQueuedRead(reading, queued);
   }

   /**
    * A queued read waits for the running batch of queued reads and for queued
    * writes. A queued caller is in that batch, and a write waits for every
    * running read, so such a wait never ends. An `Immediate` caller holds off
    * only writes, so its wait is refused only once a write is queued. A read
    * that has started ends on its own, and so does a read of another lock,
    * so their waits go on. A refused read
    * still runs once its turn comes, as a refused build does, since a caller
    * that does not await it relies on that.
    */
   protected refuseQueuedRead<T>(reading: Promise<T>, queued: { readonly started: boolean }): Promise<T> {
      const caller = readLockScopeState.scope?.current();
      const fromRequest = caller && this.ownReads.get(caller);
      if (!caller || fromRequest === undefined) {
         return reading;
      }
      const waitingIn: ReadLockMark = {
         get running() {
            return caller.running;
         },
         ended: caller.ended,
         startGrace: refuse => this.startReadWaitGrace(refuse, () => queued.started || (fromRequest && this.queuedWrites === 0))
      };
      return runInReadLockScope(() => refuseWaitInRead('A queued read', reading, this), waitingIn);
   }

   /**
    * Call `refuse` once a grace period passes with no write or build running,
    * since a running one may still reach the awaited state. A build outside the
    * lock counts too. It also waits on while `keepWaiting` returns true.
    */
   protected startReadWaitGrace(refuse: () => void, keepWaiting: () => boolean = () => false): { dispose(): void } {
      let timer: { dispose(): void };
      const arm = (): void => {
         timer = this.clock.setTimer(
            () => (this.runningWrite || this.documentBuilder()?.activeBuild || keepWaiting() ? arm() : refuse()),
            this.readWaitGraceMs
         );
      };
      arm();
      return { dispose: () => timer.dispose() };
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
    * through this method too. A write that has ended is not counted, so the
    * next write does not count as cancelling it. A write running when this is
    * called has been cancelled, by this call or an earlier one, so its timer
    * starts here.
    */
   override cancelWrite(): void {
      if (this.queuedWrites > 0 || this.runningWrite !== undefined) {
         this.cancelledWriteCount++;
      }
      const running = this.runningWrite;
      if (running && !running.stallTimer && this.stalledWriteWarnMs > 0) {
         running.stallTimer = this.clock.setTimer(() => this.reportStalledWrite(), this.stalledWriteWarnMs);
      }
      super.cancelWrite();
   }

   /**
    * A write has waited `stalledWriteWarnMs` to start, behind running reads or
    * a running write. `fromRead` tells whether the read it was queued in still runs.
    */
   protected reportWaitingWrite(fromRead: boolean): void {
      if (this.runningWrite || this.waitingWriteWarned) {
         // The running write's own cancellation warns about it, and one warning covers the writes queued behind another.
         return;
      }
      this.waitingWriteWarned = true;
      this.tracer.warn(
         `A write has waited ${this.stalledWriteWarnMs} ms for running requests or reads to end. ` +
            (fromRead
               ? 'It was queued inside one, which never ends if it awaits the write.'
               : 'A long request delays it, and one that awaits a build or write holds it off for good.')
      );
   }

   protected reportStalledWrite(): void {
      this.tracer.warn(
         `A write is still running ${this.stalledWriteWarnMs} ms after it was cancelled, and every write and queued read waits behind it. ` +
            'Likely causes: a model-service write or rebuild from inside a build in a host with no write-lock scope tracker, ' +
            'which waits for the build it runs in, or a write action that ignores its cancellation token. ' +
            'See https://github.com/eclipse-emfcloud/hydranium/issues/245.'
      );
   }
}
