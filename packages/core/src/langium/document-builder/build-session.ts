/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { type URI } from '@hydranium/langium';

/** What a build is about, handed to `HydraniumDocumentBuilder.createBuildSession`. */
export interface BuildSessionContext {
   /**
    * Which entry point opened the build: `'build'` is the workspace-wide pass
    * (initialization), `'update'` an incremental rebuild. A subclass deriving
    * cascade state skips the work for `'build'`, where every document is in the
    * set already and `shouldRelink` is never consulted.
    */
   readonly kind: 'build' | 'update';
   /** Formatted description of what caused the build — a URI, a count summary. */
   readonly trigger: string;
   /** True when {@link trigger} already states the document count. */
   readonly triggerCountsDocs: boolean;
   /** URIs the build was asked to rebuild, already flattened and canonicalized. */
   readonly changed: readonly URI[];
   /** URIs the build was asked to delete, already expanded by `collectDeletedURIs`. Empty for a `build` call. */
   readonly deleted: readonly URI[];
}

/**
 * One rebuild, treated as a correlated unit.
 *
 * Everything a build phase needs to know about the build it belongs to — what
 * triggered it, when it started, whether it was cancelled, and the log lines it
 * has produced so far. A `HydraniumDocumentBuilder` opens one per `update` /
 * `build` call and holds it for the duration, so a per-phase hook can reach
 * build-wide facts that no per-line formatting hook could.
 *
 * **Identity is the object, not {@link traceId}.** `Tracer.time` short-circuits
 * when its log level is suppressed and never calls `captureId`, so `traceId` is
 * `undefined` on every build in a production configuration that logs above
 * `debug`. A teardown guard keyed on the id would then compare `undefined`
 * against `undefined` and let a preempted build clear its successor's state.
 * Reference equality against `HydraniumDocumentBuilder.activeSession` holds in
 * both configurations, which is why nothing here is keyed on the id.
 *
 * Adopters carrying build-scoped state of their own subclass this and return it
 * from `HydraniumDocumentBuilder.createBuildSession`, narrowing with an
 * `instanceof` where they read it back. That buys them the framework's
 * preemption-correct teardown rather than a second copy of it.
 */
export class BuildSession {
   /**
    * `Tracer.time` correlation id, so a phase line and the build line share a
    * `#N`. `undefined` until the timer starts, and permanently `undefined` when
    * the timing line is suppressed.
    */
   traceId?: number;
   /** Set when the build ended in `OperationCancelled`, so the successor can tag itself "cancels #N". */
   cancelled = false;
   /** Phase-reached lines produced so far; the first one measures from {@link startMs} rather than from the previous phase. */
   phasesLogged = 0;
   /** Lines held back by {@link detailThresholdMs}; flushed or dropped when the build ends. */
   readonly bufferedLines: string[] = [];

   constructor(
      /** Millisecond timestamp the build started at, on the same clock as `performance.now()`. */
      readonly startMs: number,
      /** What caused this build — a formatted URI, a count summary, or an adopter label. */
      readonly trigger: string,
      /** True when {@link trigger} already states the document count, so a phase line must not repeat it. */
      readonly triggerCountsDocs: boolean,
      /**
       * Build duration at or above which the buffered lines are emitted; `0`
       * disables buffering entirely. Captured per session so the flush decision
       * uses the same value the buffering decision did, even if the underlying
       * observable changed mid-build.
       */
      readonly detailThresholdMs: number
   ) {}

   /** True while lines are being held rather than emitted as they are produced. */
   get buffers(): boolean {
      return this.detailThresholdMs > 0;
   }
}
