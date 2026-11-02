/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import type { WorkspaceLock } from '@hydranium/langium';
import { readLockOwners, readLockScopeState } from './read-lock-scope-state.js';

/**
 * Tracks whether the caller runs inside a workspace lock read, such as a
 * request Langium handles. A build or write waits for every running read, so
 * a read that awaits one never ends. `@hydranium/core/node` installs an
 * `AsyncLocalStorage` tracker. Without it, as in a browser, a read is marked
 * only until its action's first `await`. A document request's action awaits
 * its document first, so there a provider's wait is not refused and hangs
 * (see https://github.com/eclipse-emfcloud/hydranium/issues/245).
 */
export interface ReadLockScope {
   /** Run `fn` inside `read`, or outside every read with `undefined`. */
   run<T>(fn: () => T, read: ReadLockMark | undefined): T;
   /** The read the caller runs inside, if any. */
   current(): ReadLockMark | undefined;
}

/** A running workspace lock read, such as a request Langium handles. */
export interface ReadLockMark {
   /** Whether its action still runs. */
   readonly running: boolean;
   /** Settles as its action does. */
   readonly ended: Promise<void>;
   /**
    * Call `refuse` once the lock's grace period has passed with no build or
    * write running, unless disposed first. The caller disposes it when the read ends.
    */
   startGrace(refuse: () => void): { dispose(): void };
}

/** A tracker without async context: it marks a read only until the action's first `await`. */
export function createSynchronousReadLockScope(): ReadLockScope {
   let current: ReadLockMark | undefined;
   return {
      run: (fn, read) => {
         const outer = current;
         current = read;
         try {
            return fn();
         } finally {
            current = outer;
         }
      },
      current: () => current
   };
}

readLockScopeState.scope = createSynchronousReadLockScope();

/** Install (or clear, with `undefined`) the read-lock scope tracker. Idempotent. */
export function setReadLockScope(scope: ReadLockScope | undefined): void {
   readLockScopeState.scope = scope;
}

/** Run `fn` inside `read`, or outside every read with `undefined`, if a tracker is installed. */
export function runInReadLockScope<T>(fn: () => T, read: ReadLockMark | undefined): T {
   const scope = readLockScopeState.scope;
   return scope ? scope.run(fn, read) : fn();
}

/**
 * Capture the read the caller runs inside, to run a later call inside it after
 * an `await`. A tracker without async context loses the read at the first one.
 */
export function captureReadLockScope(): <T>(fn: () => T) => T {
   const read = readLockScopeState.scope?.current();
   return fn => (read ? runInReadLockScope(fn, read) : fn());
}

/** Whether the caller runs inside a running workspace lock read. `false` without a tracker. */
export function isInsideReadLock(): boolean {
   return readLockScopeState.scope?.current()?.running ?? false;
}

/** Thrown for a wait inside a workspace lock read that would wait for a build or write. */
export class ReadLockWaitError extends Error {
   constructor(readonly waitFor: string) {
      super(
         `${waitFor} was awaited inside a workspace lock read, such as a request handler. ` +
            'A build or write that has yet to start waits for every running read, so this wait would never end once awaited there. ' +
            'A session update or save refused this way has already applied its text. ' +
            'Wait before the request, as Langium does for its required document state, ' +
            'or start the build without awaiting it through runInReadLockScope with no read, so it runs outside the request.'
      );
      this.name = 'ReadLockWaitError';
   }
}

/**
 * `waiting`, unless the caller runs inside a read that is still running once
 * the lock's grace period has passed with `waiting` pending: a build or write
 * waits for that read, so a read that awaits one never ends, and the returned
 * promise rejects with {@link ReadLockWaitError} instead. A read that ends
 * first did not await it, and the wait goes on. `lock` is the lock the
 * awaited build or write takes. A read another lock runs holds off nothing
 * there, so its wait goes on too. `onRefused` drops what `waiting` registered
 * to settle, so a refused wait leaves nothing behind.
 */
export function refuseWaitInRead<T>(waitFor: string, waiting: Promise<T>, lock: WorkspaceLock, onRefused?: () => void): Promise<T> {
   const read = readLockScopeState.scope?.current();
   const owner = read && readLockOwners.get(read);
   if (!read?.running || (owner && owner !== lock)) {
      return waiting;
   }
   return new Promise<T>((resolve, reject) => {
      const grace = read.startGrace(() => {
         onRefused?.();
         reject(new ReadLockWaitError(waitFor));
      });
      void read.ended.then(() => grace.dispose());
      waiting.then(
         value => {
            grace.dispose();
            resolve(value);
         },
         (error: unknown) => {
            grace.dispose();
            reject(error);
         }
      );
   });
}
