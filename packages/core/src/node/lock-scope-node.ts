/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { AsyncLocalStorage } from 'node:async_hooks';
import { type LockScope, type ReadHold, setReadLockScope, setWriteLockScope } from '../langium/workspace/lock-scope.js';

/**
 * `node:async_hooks`-backed {@link LockScope}.
 *
 * `AsyncLocalStorage` is the right primitive rather than a plain module-level
 * boolean: the lock's action is async, and a flag set around it would report
 * "inside" for every other task interleaved on the event loop while that action
 * awaits — which is most of them. The store follows the async stack instead, so
 * only code actually descended from the action sees it. Each scope has its own
 * store, so a read started inside a write keeps the write's mark.
 */
export function createNodeLockScope<V = true>(): LockScope<V> {
   // The mark is a token that the action's end clears: a task the action
   // spawned keeps the store but no longer holds the lock. It links the live mark
   // it started in, which may outlive it.
   interface Mark {
      live: boolean;
      value?: V;
      readonly outer?: Mark;
   }
   const storage = new AsyncLocalStorage<Mark>();
   const live = (): Mark | undefined => {
      let mark = storage.getStore();
      while (mark !== undefined && !mark.live) {
         mark = mark.outer;
      }
      return mark;
   };
   return {
      run<T>(fn: () => T, value?: V): T {
         // The live mark, not the store's: a dead one never revives, so linking it only retains it.
         const mark: Mark = { live: true, value, outer: live() };
         const end = (): void => {
            mark.live = false;
            // A context that outlives the action keeps the mark, not what the value holds.
            mark.value = undefined;
         };
         let result: T;
         try {
            result = storage.run(mark, fn);
         } catch (error: unknown) {
            end();
            throw error;
         }
         if (isPromiseLike(result)) {
            // A derived promise, so a caller that drops it still gets the rejection reported.
            return Promise.resolve(result).finally(end) as T;
         }
         end();
         return result;
      },
      exit: fn => storage.exit(fn),
      isInside: () => live() !== undefined,
      current: () => live()?.value
   };
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
   return typeof (value as PromiseLike<unknown> | undefined)?.then === 'function';
}

export const nodeWriteLockScope: LockScope = createNodeLockScope();
export const nodeReadLockScope: LockScope<ReadHold> = createNodeLockScope<ReadHold>();

/**
 * Install the Node write-lock and read-lock scope trackers, enabling reentrancy
 * detection on the model facade. Idempotent. Called once at
 * `@hydranium/core/node` load, so any Node host that imports the entry gets the
 * detection for free. A browser bundle imports only `.` and keeps the inert
 * default.
 */
export function installNodeLockScopes(): void {
   setWriteLockScope(nodeWriteLockScope);
   setReadLockScope(nodeReadLockScope);
}
