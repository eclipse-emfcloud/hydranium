/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * Watches work started elsewhere until it settles, so a caller can ask whether
 * any is still pending and wait for what is pending now. It starts, orders and
 * limits nothing, and keeps no clock: a caller that must not wait for good
 * races {@link whenSettled} against its own bound.
 */
export class PendingWorkTracker {
   /** The tracked work. {@link track} removes each entry once it settles. */
   protected readonly pending = new Set<Promise<unknown>>();

   /**
    * Watch `work` until it settles. The promise handed back settles as `work`
    * does, so a caller that drops it still sees a failure reported.
    */
   track<T>(work: Promise<T>): Promise<T> {
      this.pending.add(work);
      return work.finally(() => {
         this.pending.delete(work);
      });
   }

   /** How much of the tracked work has not settled yet. */
   get size(): number {
      return this.pending.size;
   }

   /** Whether all tracked work has settled. Synchronous, for a check that must decide within the tick. */
   get isIdle(): boolean {
      return this.pending.size === 0;
   }

   /**
    * Resolves once the work pending now has settled; work tracked later is not
    * waited for. Never rejects, since failed work has settled too.
    */
   async whenSettled(): Promise<void> {
      await Promise.allSettled([...this.pending]);
   }
}
