/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { type WorkspaceLock } from '@hydranium/langium';

/**
 * Tracks whether the currently-executing code runs inside an action of the
 * workspace lock, with one scope for writes and one for reads.
 *
 * The question matters because `WorkspaceLock` is not reentrant. Acquiring the
 * write lock calls `cancelWrite()` on the running holder, so a caller that
 * reaches the model facade from inside a build has its ENCLOSING build cancelled
 * and may then stall in the follow-up phase wait. A read holds every write
 * off, so a write awaited from inside it, or a wait for the build it needs,
 * ends only once the read gives up its hold for that wait (see
 * {@link releaseReadHolds}).
 * Neither has a static signature, since the call looks ordinary at every
 * layer, so the only way to handle it is to know, at the moment of
 * acquisition, whether the lock is already held further up the same async
 * stack.
 *
 * Answering it needs async-context propagation, which has no browser-neutral
 * implementation: Node's `AsyncLocalStorage` is a `node:async_hooks` import (so
 * it cannot appear on the portable `.` entry, which `check:neutral` gates), and
 * TC39's `AsyncContext` is unshipped. Userland polyfills lose the context at a
 * native `await` unless every awaited path, Langium's included, is transpiled.
 * Hence the same seam shape the log file-tee uses: this module declares the
 * contract and defaults to inert, and `@hydranium/core/node` installs a real
 * implementation at entry load. A browser bundle therefore gets NO detection
 * rather than a broken approximation, which is the right degradation. A false
 * negative costs the stall, which `HydraniumWorkspaceLock` reports once the
 * write has waited too long, while a false positive would reject a legitimate
 * call. Detection without a tracker is tracked in
 * https://github.com/eclipse-emfcloud/hydranium/issues/245.
 */
export interface LockScope<V = true> {
   /** Run `fn` inside this scope with `value`, until `fn` or the promise it returns settles. */
   run<T>(fn: () => T, value?: V): T;
   /** Run `fn` marked as executing outside this scope. */
   exit<T>(fn: () => T): T;
   /** Whether the caller is inside a {@link run} scope. */
   isInside(): boolean;
   /** The value of the innermost {@link run} scope the caller is inside. */
   current(): V | undefined;
}

/** A running read of a workspace lock, which holds every write of that lock off until it ends or is released. */
export interface ReadHold {
   readonly lock: WorkspaceLock;
   /** The read this one started in, on this lock or another. */
   readonly outer?: ReadHold;
   /**
    * Stop holding writes off while the read runs on, until the returned
    * function takes the hold back. Released twice, it is taken back once both
    * are. A read that must keep holding writes off, such as a queued read of
    * `HydraniumWorkspaceLock`, ignores it.
    */
   release(): () => void;
}

let writeLockScope: LockScope | undefined;
let readLockScope: LockScope<ReadHold> | undefined;

/** Install (or clear, with `undefined`) the write-lock scope tracker. Idempotent. */
export function setWriteLockScope(scope: LockScope | undefined): void {
   writeLockScope = scope;
}

/** Install (or clear, with `undefined`) the read-lock scope tracker. Idempotent. */
export function setReadLockScope(scope: LockScope<ReadHold> | undefined): void {
   readLockScope = scope;
}

/**
 * Run `fn` inside the write-lock scope, if a tracker is installed. Without one
 * this is a plain call, so the wrapper is safe to apply unconditionally on the
 * neutral path.
 */
export function runInWriteLockScope<T>(fn: () => T): T {
   return writeLockScope ? writeLockScope.run(fn) : fn();
}

/** Run `fn` inside the read-lock scope as `hold`, if a tracker is installed. */
export function runInReadLockScope<T>(fn: () => T, hold: ReadHold): T {
   return readLockScope ? readLockScope.run(fn, hold) : fn();
}

/** The read the caller runs in, if a tracker is installed. */
export function currentReadHold(): ReadHold | undefined {
   return readLockScope?.current();
}

/**
 * Release every read of `lock` the caller runs in, the reads it is nested in
 * included, while the promise `wait` returns runs, so a write or a build it
 * waits for can start. They take their holds back once it settles. An outer
 * read that has already ended holds nothing, so its take-back ends at once.
 * Outside such a read, this only calls `wait`. Without a tracker the caller's
 * read is unknown, so every read running on a `HydraniumWorkspaceLock` is
 * released instead, and runs beside the build.
 *
 * A wait that a write's end settles calls `retake` itself, inside that write.
 * The lock starts its next write a few microtasks after one ends, which may
 * be before the settled promise reaches the caller. A `retake` called earlier
 * than that holds off the very write the read waits for.
 */
export function releaseReadHolds<T>(lock: WorkspaceLock, wait: (retake: () => void) => Promise<T>): Promise<T> {
   const holds = readLockScope ? callerReadHolds(lock) : isRunningReadsLock(lock) ? lock.runningReadHolds() : [];
   return releaseHolds(holds, wait);
}

/**
 * {@link releaseReadHolds} for the reads the caller runs in only, also without
 * a tracker. The lock's own `write` and `read` use it, so a build Langium
 * starts holds off every read in a host without one.
 */
export function releaseCallerReadHolds<T>(lock: WorkspaceLock, wait: (retake: () => void) => Promise<T>): Promise<T> {
   return releaseHolds(callerReadHolds(lock), wait);
}

function callerReadHolds(lock: WorkspaceLock): ReadHold[] {
   const holds: ReadHold[] = [];
   for (let hold = currentReadHold(); hold; hold = hold.outer) {
      if (hold.lock === lock) {
         holds.push(hold);
      }
   }
   return holds;
}

interface RunningReadsLock extends WorkspaceLock {
   runningReadHolds(): ReadHold[];
}

function isRunningReadsLock(lock: WorkspaceLock): lock is RunningReadsLock {
   return typeof (lock as Partial<RunningReadsLock>).runningReadHolds === 'function';
}

function releaseHolds<T>(holds: ReadHold[], wait: (retake: () => void) => Promise<T>): Promise<T> {
   const retakes = holds.map(hold => hold.release());
   // Emptied as it runs, so the take-back after an early one does nothing.
   const retake = (): void => retakes.splice(0).forEach(retakeHold => retakeHold());
   let waiting: Promise<T>;
   try {
      waiting = wait(retake);
   } catch (error: unknown) {
      retake();
      throw error;
   }
   // A derived promise, so a caller that drops it still gets the rejection reported.
   return waiting.finally(retake);
}

/**
 * Run `fn` outside the read-lock scope. A write queued from inside a read
 * starts in that read's async context and must not be taken for one.
 */
export function runOutsideReadLockScope<T>(fn: () => T): T {
   return readLockScope ? readLockScope.exit(fn) : fn();
}

/**
 * Whether the caller is executing inside a workspace write-lock holder.
 *
 * Returns `false` when no tracker is installed, so every guard reading this
 * fails OPEN — an un-instrumented host keeps its current behaviour rather than
 * gaining spurious rejections.
 */
export function isInsideWriteLock(): boolean {
   return writeLockScope?.isInside() ?? false;
}

/** Whether the caller is executing inside a workspace lock read. `false` without a tracker. */
export function isInsideReadLock(): boolean {
   return readLockScope?.isInside() ?? false;
}

/**
 * Whether a write-lock scope tracker is installed, which is what makes a
 * `false` from {@link isInsideWriteLock} mean "outside" rather than "unknown".
 */
export function isWriteLockScopeInstalled(): boolean {
   return writeLockScope !== undefined;
}

/**
 * Thrown when the model facade is reached from inside a workspace write-lock
 * holder — typically an integrity rule or build-phase pass writing through
 * a session's `update` / `save` / `delete` or `ModelService.rebuild` during a
 * build.
 *
 * Named rather than a bare `Error` because the remedy is specific and worth
 * pointing at: either move the write out of the build (integrity rules that
 * persist repairs should write through `FileSystemProvider.writeFile`, which
 * takes no lock), or set `ModelServiceOptions.allowReentrantBuilds: true`,
 * which keeps the facade's build from cancelling the holder but not its wait
 * from stalling on a document that needs a re-queue. A delete is refused on
 * either value.
 */
export class ReentrantWriteLockError extends Error {
   constructor(readonly uri: string) {
      super(
         `Model facade reached for '${uri}' from inside a workspace write-lock holder. ` +
            'Acquiring the write lock would cancel the enclosing build and may stall this call. ' +
            'Write through FileSystemProvider.writeFile from a build-phase pass, or, for an update, save or rebuild, ' +
            'set ModelServiceOptions.allowReentrantBuilds: true to build without the lock from inside it.'
      );
      this.name = 'ReentrantWriteLockError';
   }
}
