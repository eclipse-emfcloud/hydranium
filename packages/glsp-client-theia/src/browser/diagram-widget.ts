/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { DiagramLoader } from '@eclipse-glsp/client';
import { GLSPDiagramWidget } from '@eclipse-glsp/theia-integration';
// Type-only: the `@theia/core/lib/browser` barrel touches DOM globals at module
// load, which the node-environment unit tests cannot provide.
import { type Message } from '@theia/core/lib/browser';
import { injectable } from '@theia/core/shared/inversify';
import { type DiagramLoadOutcome, HydraniumDiagramLoader } from './diagram-loader';
// Shipped by this package rather than left to adopters: an overlay whose
// stylesheet was forgotten is an unstyled div in normal flow, which is a silent
// failure. Adopters override individual rules from their own stylesheet.
import '../../style/diagram-loading.css';

/** Class on the overlay root. Adopters style / override via this contract. */
export const DIAGRAM_LOADING_CLASS = 'hydranium-diagram-loading';

/** Added to the overlay root when it switches from pending to reporting a
 *  failure, so the spinner can be hidden and the text restyled from CSS alone. */
export const DIAGRAM_LOADING_FAILED_CLASS = `${DIAGRAM_LOADING_CLASS}-failed`;

/**
 * `GLSPDiagramWidget` that covers the canvas with a spinner until the diagram
 * load reaches a terminal state.
 *
 * **Why.** GLSP renders nothing until the first model arrives, so opening a
 * diagram shows a blank tab for the whole round trip — long enough on a large
 * model to read as a broken editor rather than a slow one.
 *
 * **How the pending state is sourced.** From {@link HydraniumDiagramLoader}, not
 * from `actionDispatcher.onceModelInitialized()`. The loader settles on failure
 * as well as on success, and it does so even when its own error-reporting
 * dispatch throws; `onceModelInitialized()` simply never settles on a failed
 * load. That distinction is not academic here: this overlay is opaque and covers
 * the widget node, while GLSP's `StatusOverlay` — where the loader reports the
 * failure — mounts *inside* the diagram's base div. Keyed on model
 * initialization, a failed load would leave a spinner turning on top of the
 * error message explaining it. Keyed on the loader, exactly one component decides
 * whether the canvas is pending and the two mechanisms compose instead of
 * competing.
 *
 * **The one case where this overlay reports the failure itself.** When
 * `DiagramLoadFailure.surfaced` is `false` the loader could not dispatch its
 * `StatusAction` — the action dispatcher was what failed — so the status overlay
 * shows nothing. Uncovering the canvas would then leave a blank diagram whose only
 * explanation is a line in the Output channel. In that case, and only that case,
 * the overlay stays up and swaps the spinner for the error text.
 *
 * Bound unconditionally by `AbstractHydraniumGlspTheiaFrontendModule`. To opt out,
 * override {@link showLoadingOverlay} to a no-op; to change what is rendered,
 * override {@link createLoadingOverlay} or {@link loadingLabel}.
 */
@injectable()
export class HydraniumGlspDiagramWidget extends GLSPDiagramWidget {
   protected loadingOverlay?: HTMLElement;

   protected override onAfterAttach(msg: Message): void {
      // Before `super`, which is what starts the load on first attach — so the
      // overlay is already up when the round trip begins.
      this.showLoadingOverlay();
      super.onAfterAttach(msg);
   }

   override dispose(): void {
      this.hideLoadingOverlay();
      super.dispose();
   }

   /**
    * Cover the canvas until the load settles.
    *
    * Nothing is created unless there is a signal to take it down again: no
    * overlay without a framework loader, and none when the load has already
    * settled — re-attaching a loaded diagram (a tab switch) skips it entirely
    * rather than creating and immediately removing one, so there is no flash.
    */
   protected showLoadingOverlay(): void {
      if (this.loadingOverlay) {
         return;
      }
      const loader = this.hydraniumDiagramLoader;
      if (!loader || loader.loadOutcome !== undefined) {
         return;
      }
      this.loadingOverlay = this.createLoadingOverlay();
      this.node.appendChild(this.loadingOverlay);
      // Both arms: `onceLoadSettled` never rejects, but a widget must not be able
      // to strand an overlay if that ever changes — a rejection is treated as an
      // outcome it cannot report, which is the safe reading.
      loader.onceLoadSettled().then(
         outcome => this.onLoadSettled(outcome),
         () => this.hideLoadingOverlay()
      );
   }

   /**
    * Take the overlay down, or keep it as the failure's only reporter.
    *
    * The overlay is retained ONLY for a failure the loader could not surface;
    * anything else uncovers the canvas, so a load that failed *and was reported*
    * reveals GLSP's status overlay rather than double-reporting on top of it.
    */
   protected onLoadSettled(outcome: DiagramLoadOutcome): void {
      if (outcome.status === 'failed' && !outcome.surfaced) {
         this.showLoadFailure(outcome.error);
         return;
      }
      this.hideLoadingOverlay();
   }

   /**
    * Repurpose the pending overlay in place as a failure report: same node, so
    * there is no removal-then-insertion flicker, plus a marker class so the
    * spinner can be hidden from CSS.
    *
    * The wording is {@link HydraniumDiagramLoader.loadFailureLabel}'s, so an
    * adopter rewording a load failure reaches every surface that reports it.
    * Without the framework loader there is no failure to render, so its absence
    * is a no-op rather than a fallback wording.
    */
   protected showLoadFailure(error: unknown): void {
      const overlay = this.loadingOverlay;
      const loader = this.hydraniumDiagramLoader;
      if (!overlay || !loader) {
         return;
      }
      overlay.classList.add(DIAGRAM_LOADING_FAILED_CLASS);
      const label = overlay.querySelector(`.${DIAGRAM_LOADING_CLASS}-label`);
      if (label) {
         label.textContent = loader.loadFailureLabel(error);
      }
   }

   protected hideLoadingOverlay(): void {
      this.loadingOverlay?.remove();
      this.loadingOverlay = undefined;
   }

   /** Build the overlay DOM. Override to change the wording or add content; the
    *  root must carry {@link DIAGRAM_LOADING_CLASS} for the shipped styling, and
    *  the label element its `-label` class so {@link showLoadFailure} finds it. */
   protected createLoadingOverlay(): HTMLElement {
      const overlay = document.createElement('div');
      overlay.className = DIAGRAM_LOADING_CLASS;
      const spinner = document.createElement('div');
      spinner.className = `${DIAGRAM_LOADING_CLASS}-spinner`;
      const label = document.createElement('div');
      label.className = `${DIAGRAM_LOADING_CLASS}-label`;
      label.textContent = this.loadingLabel;
      overlay.appendChild(spinner);
      overlay.appendChild(label);
      return overlay;
   }

   /** Text shown under the spinner. Override for a domain-specific wording; the
    *  failure text that replaces it is {@link showLoadFailure}'s. */
   protected get loadingLabel(): string {
      return 'Loading diagram...';
   }

   /**
    * The framework loader for this diagram, or `undefined` when the container
    * binds a plain `DiagramLoader`. Absence degrades to "no overlay" rather than
    * an error: a head that opted out of the framework loader has no settle signal
    * to key on, and an overlay that never comes down is worse than none.
    */
   protected get hydraniumDiagramLoader(): HydraniumDiagramLoader | undefined {
      const loader = this.diContainer.get<DiagramLoader>(DiagramLoader);
      return loader instanceof HydraniumDiagramLoader ? loader : undefined;
   }
}
