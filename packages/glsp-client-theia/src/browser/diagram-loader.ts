/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { DiagramLoader, type DiagramLoadingOptions, StatusAction } from '@eclipse-glsp/client';
import { ChannelLogger } from '@hydranium/client-theia/lib/browser';
import { Deferred } from '@hydranium/protocol';
import { inject, injectable } from '@theia/core/shared/inversify';

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
    * dispatcher — i.e. whether GLSP's `StatusOverlay` is now displaying this
    * failure.
    *
    * `false` means the report itself failed, which happens when the action
    * dispatcher is the thing that could not initialize. A consumer that covers
    * the canvas must then render the failure itself: it is the only surface
    * left, and removing its overlay would leave a blank diagram whose only
    * explanation is a line in the Output channel — the exact failure mode this
    * loader exists to prevent.
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
 * not. The widget that drives loading
 * (`@eclipse-glsp/theia-integration`'s `GLSPDiagramWidget.onAfterAttach`)
 * calls `load()` *without awaiting or catching it*, so any rejection becomes an
 * uncaught promise rejection visible only in the browser devtools console —
 * nothing reaches the e2e output, the server log, or a Theia log sink, and the
 * diagram just stays blank.
 *
 * This subclass closes that gap: it catches every load failure, routes it to
 * the framework Output channel (the same {@link ChannelLogger} sink the server
 * log and action traffic share, so it is discoverable where a developer already
 * looks), and surfaces a persistent error to the user via a `severity: 'ERROR'`
 * {@link StatusAction} on the diagram's status overlay. It deliberately does
 * **not** rethrow — the caller drops the promise, so rethrowing would only
 * reproduce the uncaught rejection this exists to prevent.
 *
 * It also publishes the load's terminal state ({@link loadOutcome} /
 * {@link onceLoadSettled}) so a pending indicator has one authority to key on.
 * `HydraniumGlspDiagramWidget` uses it to cover the canvas while loading; see
 * {@link settle} for why the signal cannot be derived from the error
 * `StatusAction` instead.
 *
 * Bound by `createGlspClientTheiaModule` via `rebind(DiagramLoader)`.
 */
@injectable()
export class HydraniumDiagramLoader extends DiagramLoader {
   @inject(ChannelLogger) protected readonly channel!: ChannelLogger;

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
         // Report first, settle second, and carry whether the report landed: a
         // consumer that uncovers the canvas on settle then finds the error
         // already on the status overlay — or learns that it has to render the
         // failure itself because nothing else can.
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
    * Route a diagram-load failure to the Output channel and the status overlay.
    * The status dispatch is itself guarded: when the action dispatcher is the
    * thing that failed to initialize, dispatching may throw too, and a failure
    * to *report* the failure must not re-escape as an uncaught rejection.
    *
    * @returns whether the `StatusAction` reached the dispatcher — i.e. whether the
    * user can see this failure on the diagram. The channel line always happens, so
    * the return value is specifically about the *user-visible* report; a `false`
    * makes {@link DiagramLoadFailure.surfaced} false and hands the job to whoever
    * is covering the canvas.
    */
   protected async reportLoadFailure(err: unknown): Promise<boolean> {
      const label = this.loadFailureLabel(err);
      this.channel.error(label, err);
      try {
         await this.actionDispatcher.dispatch(StatusAction.create(label, { severity: 'ERROR' }));
         return true;
      } catch (statusErr) {
         this.channel.error('Failed to surface the diagram-load failure on the status overlay', statusErr);
         return false;
      }
   }

   /**
    * The sentence a failed load is reported with, on every surface that reports
    * it, and the only seam an adopter rewords or localizes it at. Public
    * because the canvas overlay is one of those surfaces and lives in another
    * class: it renders this failure exactly when the `StatusAction` did not
    * land, so a second copy of the sentence there could only ever drift unseen.
    */
   loadFailureLabel(err: unknown): string {
      return `Diagram failed to load: ${this.formatError(err)}`;
   }

   /** Render a thrown value as a message. Shared so the channel line, the status
    *  overlay and any consumer rendering {@link DiagramLoadFailure.error} agree. */
   protected formatError(err: unknown): string {
      return err instanceof Error ? err.message : String(err);
   }
}
