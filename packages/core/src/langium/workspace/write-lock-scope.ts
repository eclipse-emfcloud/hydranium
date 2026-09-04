/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * Tracks whether the currently-executing code is running inside a holder of the
 * workspace WRITE lock.
 *
 * The question matters because `WorkspaceLock` is not reentrant: acquiring the
 * write lock calls `cancelWrite()` on the running holder, so a caller that
 * reaches the model facade from inside a build has its ENCLOSING build cancelled
 * and may then stall in the follow-up phase wait. That is a latent deadlock with
 * no static signature — the call looks ordinary at every layer — so the only way
 * to surface it is to know, at the moment of acquisition, whether the lock is
 * already held further up the same async stack.
 *
 * Answering it needs async-context propagation, which has no browser-neutral
 * implementation: Node's `AsyncLocalStorage` is a `node:async_hooks` import (so
 * it cannot appear on the portable `.` entry, which `check:neutral` gates), and
 * TC39's `AsyncContext` is unshipped. Hence the same seam shape the log file-tee
 * uses: this module declares the contract and defaults to inert, and
 * `@hydranium/core/node` installs a real implementation at entry load. A browser
 * bundle therefore gets NO detection rather than a broken approximation, which
 * is the right degradation — the reentrant shape is a server-side build concern,
 * and a false negative costs the pre-existing stall while a false positive would
 * reject a legitimate write.
 */
export interface WriteLockScope {
   /** Run `fn` marked as executing inside a write-lock holder. */
   run<T>(fn: () => T): T;
   /** Whether the caller is already inside a {@link run} scope. */
   isInside(): boolean;
}

let writeLockScope: WriteLockScope | undefined;

/** Install (or clear, with `undefined`) the write-lock scope tracker. Idempotent. */
export function setWriteLockScope(scope: WriteLockScope | undefined): void {
   writeLockScope = scope;
}

/**
 * Run `fn` inside the write-lock scope, if a tracker is installed. Without one
 * this is a plain call, so the wrapper is safe to apply unconditionally on the
 * neutral path.
 */
export function runInWriteLockScope<T>(fn: () => T): T {
   return writeLockScope ? writeLockScope.run(fn) : fn();
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

/**
 * Thrown when the model facade is reached from inside a workspace write-lock
 * holder — typically an integrity rule or build-phase pass writing through
 * `ModelService.update` / `save` / `rebuild` during a build.
 *
 * Named rather than a bare `Error` because the remedy is specific and worth
 * pointing at: either move the write out of the build (integrity rules that
 * persist repairs should write through `FileSystemProvider.writeFile`, which
 * takes no lock), or set `ModelServiceOptions.serializeBuilds: false` to accept
 * unserialised builds in exchange for the reentrancy.
 */
export class ReentrantWriteLockError extends Error {
   constructor(readonly uri: string) {
      super(
         `Model facade reached for '${uri}' from inside a workspace write-lock holder. ` +
            'Acquiring the write lock would cancel the enclosing build and may stall this call. ' +
            'Write through FileSystemProvider.writeFile from a build-phase pass, or set ' +
            'ModelServiceOptions.serializeBuilds: false to opt out of build serialisation.'
      );
      this.name = 'ReentrantWriteLockError';
   }
}
