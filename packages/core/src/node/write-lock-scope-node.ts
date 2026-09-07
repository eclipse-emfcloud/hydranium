/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { AsyncLocalStorage } from 'node:async_hooks';
import { type WriteLockScope, setWriteLockScope } from '../langium/workspace/write-lock-scope.js';

const storage = new AsyncLocalStorage<true>();

/**
 * `node:async_hooks`-backed {@link WriteLockScope}.
 *
 * `AsyncLocalStorage` is the right primitive rather than a plain module-level
 * boolean: the lock's action is async, and a flag set around it would report
 * "inside" for every other task interleaved on the event loop while that action
 * awaits — which is most of them. The store follows the async stack instead, so
 * only code actually descended from the action sees it.
 */
export const nodeWriteLockScope: WriteLockScope = {
   run<T>(fn: () => T): T {
      return storage.run(true, fn);
   },
   isInside(): boolean {
      return storage.getStore() === true;
   }
};

/**
 * Install the Node write-lock scope tracker, enabling reentrancy detection on the
 * model facade. Idempotent. Called once at `@hydranium/core/node` load, so any
 * Node host that imports the entry gets the detection for free; a browser bundle
 * imports only `.` and keeps the inert default.
 */
export function installNodeWriteLockScope(): void {
   setWriteLockScope(nodeWriteLockScope);
}
