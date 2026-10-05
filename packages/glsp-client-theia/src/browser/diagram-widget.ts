/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { DiagramLoader, EditorContextService, GLSPActionDispatcher, SetViewportAction } from '@eclipse-glsp/client';
import { GLSPDiagramWidget, type GLSPDiagramWidgetOptions } from '@eclipse-glsp/theia-integration';
// Type-only: the `@theia/core/lib/browser` barrel touches DOM globals at module
// load, which the node-environment unit tests cannot provide.
import { type Message } from '@theia/core/lib/browser';
import { Emitter, type Event, nls } from '@theia/core';
import { type Container, injectable } from '@theia/core/shared/inversify';
import { type DiagramLoadOutcome, HydraniumDiagramLoader } from './diagram-loader';
import { HydraniumGlspSaveable } from './glsp-saveable';
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
 * from `actionDispatcher.onceModelInitialized()`: the loader settles on failure
 * as well as on success, even when its own error report throws, while
 * `onceModelInitialized()` never settles on a failed load and would leave the
 * spinner turning for good.
 *
 * A failed load keeps the overlay up with the error and a Retry, which asks for
 * a fresh widget through {@link onDidRequestReopen}.
 *
 * Bound unconditionally by `AbstractHydraniumGlspTheiaFrontendModule`. To opt out,
 * override {@link showLoadingOverlay} to a no-op; to change what is rendered,
 * override {@link createLoadingOverlay} or {@link loadingLabel}.
 *
 * Its saveable is a {@link HydraniumGlspSaveable}, which keeps a pending save
 * dirty, so Theia's exit check still counts it; see {@link createSaveable}.
 */
@injectable()
export class HydraniumGlspDiagramWidget extends GLSPDiagramWidget {
   protected loadingOverlay?: HTMLElement;
   protected readonly reopenRequestEmitter = new Emitter<void>();

   /** Fires when this diagram asks to be replaced by a fresh widget, as its
    *  Retry does; `AbstractHydraniumGlspDiagramManager` reopens it. A load is
    *  not repeated in place, since GLSP's model source registers its handlers
    *  once per load. */
   readonly onDidRequestReopen: Event<void> = this.reopenRequestEmitter.event;

   /**
    * Replaces the saveable GLSP's `configure` builds inline, with no factory
    * seam. The widget factory calls `configure` before the widget reaches the
    * shell, so Theia only ever tracks this one.
    */
   override configure(options: GLSPDiagramWidgetOptions, diContainer: Container): void {
      super.configure(options, diContainer);
      this.saveable.dispose();
      this.saveable = this.createSaveable();
      this.toDispose.push(this.saveable);
      this.toDispose.push(this.reopenRequestEmitter);
   }

   /** The widget's saveable. Override to change how saves and dirty state behave. */
   protected createSaveable(): GLSPDiagramWidget['saveable'] {
      return new HydraniumGlspSaveable(this.actionDispatcher, this.diContainer.get(EditorContextService));
   }

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
    * GLSP's restore with `animate: false`; compare the two on a GLSP upgrade.
    * An animated restore holds back every later command, so a Delete right
    * after a select-all typed as the diagram opens finds nothing selected.
    */
   protected override async setViewportData(viewportData: Parameters<GLSPDiagramWidget['setViewportData']>[0]): Promise<void> {
      if (this.actionDispatcher instanceof GLSPActionDispatcher) {
         this.actionDispatcher.dispatchOnceModelInitialized(
            SetViewportAction.create(viewportData.elementId, viewportData.viewportData, { animate: false })
         );
      }
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

   /** Take the overlay down, or keep it as the failure's report. */
   protected onLoadSettled(outcome: DiagramLoadOutcome): void {
      if (outcome.status === 'failed') {
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
      overlay.appendChild(this.createRetryButton());
   }

   /** Ask for a fresh widget, after a failed load. */
   protected retryLoad(): void {
      if (this.hydraniumDiagramLoader?.loadOutcome?.status === 'failed') {
         this.reopenRequestEmitter.fire();
      }
   }

   /** Build the failure overlay's Retry button, which calls {@link retryLoad}. */
   protected createRetryButton(): HTMLElement {
      const button = document.createElement('button');
      button.className = `theia-button ${DIAGRAM_LOADING_CLASS}-retry`;
      button.textContent = nls.localize('hydranium/glsp-client-theia/diagram-load-retry', 'Retry');
      button.addEventListener('click', () => this.retryLoad());
      return button;
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
