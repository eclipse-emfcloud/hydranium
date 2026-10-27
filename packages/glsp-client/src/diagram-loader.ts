/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { DiagramLoader, type DiagramLoadingOptions, StatusAction } from '@eclipse-glsp/client';
import { Deferred, describeError, type Logger } from '@hydranium/protocol';
import { inject, injectable } from 'inversify';
import { DIAGRAM_LOAD_FAILED } from './diagram-load-failed';
import { HydraniumClientTypes } from './types';

/**
 * How a diagram load ended. A discriminated union rather than a boolean or a
 * string: a consumer showing a pending indicator has to distinguish "not settled
 * yet" (`undefined`) from either terminal state, and the failed arm has to carry
 * enough for that consumer to decide whether *it* is now the only thing that can
 * report the failure — see {@link DiagramLoadFailure.surfaced}.
 */
export type DiagramLoadOutcome = DiagramLoadSuccess | DiagramLoadFailure;

export interface DiagramLoadSuccess {
   readonly status: 'loaded';
}

export interface DiagramLoadFailure {
   readonly status: 'failed';
   /** The thrown value, verbatim. `unknown` because a rejection can be anything. */
   readonly error: unknown;
   /**
    * Whether the `severity: 'ERROR'` {@link StatusAction} reached the action
    * dispatcher. It says nothing about whether a status overlay shows it.
    *
    * `false` means the report itself failed, which happens when the action
    * dispatcher is the thing that could not initialize. A consumer that covers
    * the canvas must then render the failure itself: it is the only surface
    * left, and removing its overlay would leave a blank diagram whose only
    * explanation is a line in the log — the exact failure mode this loader
    * exists to prevent.
    */
   readonly surfaced: boolean;
}

/**
 * Diagram loader that never lets a load failure vanish.
 *
 * `DiagramLoader.load()` orchestrates the full diagram-init path — action
 * dispatcher init, GLSP-client connect + server `initialize`, the first
 * `RequestModelAction`, and the model-initialization constraint. Of these only
 * the `IDiagramStartup` hooks are wrapped by the base loader (it logs them to
 * `console.error`); the dispatcher-init / connection / request-model steps are
 * not.
 *
 * This subclass catches every load failure, routes it to the host's logger (in
 * Theia the Output channel the server log and action traffic share, so it is
 * discoverable where a developer already looks), and surfaces a persistent
 * error to the user via a `severity: 'ERROR'` {@link StatusAction} on the
 * diagram's status overlay. It deliberately does **not** rethrow. GLSP's Theia
 * widget would render a rethrown failure a second time, in place of the
 * diagram.
 *
 * GLSP 2.7: its Theia widget calls `load()` without catching it, so a rethrown
 * failure becomes an uncaught rejection visible only in the browser devtools
 * console, and the diagram stays blank.
 *
 * It also publishes the load's terminal state ({@link loadOutcome} /
 * {@link onceLoadSettled}) so a pending indicator has one authority to key on.
 * The Theia diagram widget uses it to cover the canvas while loading; see
 * {@link settle} for why the signal cannot be derived from the error
 * `StatusAction` instead.
 *
 * Bound by `createGlspClientModule` via `rebind(DiagramLoader)`.
 */
@injectable()
export class HydraniumDiagramLoader extends DiagramLoader {
   @inject(HydraniumClientTypes.Logger) protected readonly hydraniumLogger!: Logger;

   protected readonly settled = new Deferred<DiagramLoadOutcome>();
   protected outcome?: DiagramLoadOutcome;

   /** Terminal state of the load, or `undefined` while it is still in flight.
    *  The synchronous companion of {@link onceLoadSettled}, for a consumer that
    *  must decide something in the same tick (e.g. whether to show an indicator
    *  at all when re-attaching an already-loaded diagram). */
   get loadOutcome(): DiagramLoadOutcome | undefined {
      return this.outcome;
   }

   /** Resolves once the load reaches a terminal state — on success **and** on
    *  failure, so a caller awaiting it cannot hang. Never rejects. */
   onceLoadSettled(): Promise<DiagramLoadOutcome> {
      return this.settled.promise;
   }

   override async load(options?: DiagramLoadingOptions): Promise<void> {
      try {
         await super.load(options);
         this.settle({ status: 'loaded' });
      } catch (err) {
         // Report first, settle second, and carry whether the report landed.
         const surfaced = await this.reportLoadFailure(err);
         this.settle({ status: 'failed', error: err, surfaced });
      }
   }

   /**
    * Record the terminal state and release {@link onceLoadSettled}. Idempotent —
    * the first outcome wins, so a reload cannot flip a settled indicator.
    *
    * This runs unconditionally after {@link reportLoadFailure}, *including* when
    * the status dispatch inside it threw. That is the load-bearing property: when
    * the action dispatcher is itself the thing that failed to initialize — the
    * exact failure this class exists for — no `StatusAction` ever lands, so a
    * consumer observing actions would wait forever. Settling here means a pending
    * indicator always comes down, and `surfaced: false` tells that consumer it is
    * now the only thing that can report the failure.
    */
   protected settle(outcome: DiagramLoadOutcome): void {
      if (this.outcome !== undefined) {
         return;
      }
      this.outcome = outcome;
      this.settled.resolve(outcome);
   }

   /**
    * Route a diagram-load failure to the host's logger and the status overlay.
    * The status dispatch is itself guarded: when the action dispatcher is the
    * thing that failed to initialize, dispatching may throw too, and a failure
    * to *report* the failure must not re-escape as an uncaught rejection.
    *
    * @returns whether the `StatusAction` reached the dispatcher — i.e. whether the
    * user can see this failure on the diagram. The log line always happens, so
    * the return value is specifically about the *user-visible* report; a `false`
    * makes {@link DiagramLoadFailure.surfaced} false and hands the job to whoever
    * is covering the canvas.
    */
   protected async reportLoadFailure(err: unknown): Promise<boolean> {
      const label = this.loadFailureLabel(err);
      this.hydraniumLogger.error(label, err);
      try {
         await this.actionDispatcher.dispatch(StatusAction.create(label, { severity: 'ERROR' }));
         return true;
      } catch (statusErr) {
         this.hydraniumLogger.error('Failed to surface the diagram-load failure on the status overlay', statusErr);
         return false;
      }
   }

   /**
    * The sentence a failed load is reported with, on every surface that reports
    * it. Public because the canvas overlay is one of those surfaces and lives in
    * another class, where a second copy of the sentence would drift.
    *
    * English, formatted from {@link DIAGRAM_LOAD_FAILED}: this tier knows no
    * locale. A host that does renders the code through its own mechanism by
    * overriding this method, so every surface, the log line included, carries
    * the one sentence the user reads.
    */
   loadFailureLabel(err: unknown): string {
      return DIAGRAM_LOAD_FAILED.format({ reason: this.formatError(err) });
   }

   /** Render a thrown value as a message. Shared so the log line, the status
    *  overlay and any consumer rendering {@link DiagramLoadFailure.error} agree. */
   protected formatError(err: unknown): string {
      return describeError(err);
   }
}
