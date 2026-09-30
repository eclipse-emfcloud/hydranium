/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { codiconCSSString, DiagramLoader } from '@eclipse-glsp/client';
import { GLSPDiagramManager } from '@eclipse-glsp/theia-integration';
import { type GLSPDiagramLanguage } from '@eclipse-glsp/theia-integration/lib/common';
import { type GLSPDiagramWidget, type GLSPWidgetOpenerOptions } from '@eclipse-glsp/theia-integration/lib/browser';
import { type WidgetOpenerOptions } from '@theia/core/lib/browser';
import { type Disposable, DisposableCollection } from '@theia/core';
import { injectable } from '@theia/core/shared/inversify';
import { HydraniumGlspClientContribution } from './client-contribution';
import { HydraniumDiagramLoader } from './diagram-loader';
import { HydraniumGlspDiagramWidget } from './diagram-widget';

/**
 * `GLSPDiagramManager` subclass that derives the language-correlated getters
 * (`fileExtensions`, `diagramType`, `contributionId`, `iconClass`) from a
 * {@link GLSPDiagramLanguage} descriptor and the human-readable `label` from a
 * separate adopter field — so adopters override two abstract members per
 * manager rather than a getter apiece.
 *
 * Adopters subclass and provide:
 *  - {@link diagramLanguage} — wire-format identifiers + file routing
 *  - {@link managerLabel} — human-readable label shown in the open-with menu
 *
 * Optional override:
 *  - {@link customIconClass} — overrides the language's `iconClass`
 *  - `get id()` — manager id; defaults to nothing because manager id is
 *    typically `static readonly ID = '…'` referenced by external callers
 *    (Theia `WidgetManager` lookups). Adopter subclasses set `static ID`
 *    and override `get id()` to return it.
 *
 * Abstract base class with hook fields, adopter subclasses with concrete
 * values, following the GLSP module convention. The container always
 * constructs the adopter subclass, never the abstract base directly.
 */
@injectable()
export abstract class AbstractHydraniumGlspDiagramManager extends GLSPDiagramManager {
   /** Wire-format identifiers + file routing for this manager's diagram type. */
   protected abstract readonly diagramLanguage: GLSPDiagramLanguage;

   /** Human-readable label shown in the open-with menu and editor tabs. */
   protected abstract readonly managerLabel: string;

   /** Optional icon-class override; takes precedence over the language's `iconClass`. */
   protected readonly customIconClass?: string;

   protected clientListeners?: Disposable;
   /** The reopens asked for so far, which run one at a time. */
   protected reopening: Promise<void> = Promise.resolve();

   override get fileExtensions(): string[] {
      return [...this.diagramLanguage.fileExtensions];
   }

   override get diagramType(): string {
      return this.diagramLanguage.diagramType;
   }

   override get contributionId(): string {
      return this.diagramLanguage.contributionId;
   }

   override get iconClass(): string {
      return this.customIconClass ?? this.diagramLanguage.iconClass ?? codiconCSSString('type-hierarchy-sub');
   }

   get label(): string {
      return this.managerLabel;
   }

   override async createWidget(options?: unknown): Promise<GLSPDiagramWidget> {
      this.listenToClient();
      const widget = await super.createWidget(options);
      if (widget instanceof HydraniumGlspDiagramWidget) {
         widget.onDidRequestReopen(() => void this.reopen(widget));
      }
      return widget;
   }

   /**
    * Reopen every diagram once its client is lost, since none of them has a
    * server behind it any more, and a failed one once a client starts.
    */
   protected listenToClient(): void {
      if (this.clientListeners) {
         return;
      }
      const contribution = this.diagramServiceProvider.getGLSPClientContribution(this.contributionId);
      this.clientListeners =
         contribution instanceof HydraniumGlspClientContribution
            ? new DisposableCollection(
                 contribution.onDidLoseClient(() => this.reopenAll(() => true)),
                 contribution.onDidStartClient(() => this.reopenAll(widget => this.loadFailed(widget)))
              )
            : new DisposableCollection();
   }

   protected reopenAll(which: (widget: GLSPDiagramWidget) => boolean): void {
      for (const widget of this.all.filter(which)) {
         void this.reopen(widget);
      }
   }

   protected loadFailed(widget: GLSPDiagramWidget): boolean {
      const loader = widget.diContainer.get<DiagramLoader>(DiagramLoader);
      return loader instanceof HydraniumDiagramLoader && loader.loadOutcome?.status === 'failed';
   }

   /**
    * Replace `widget` with a fresh one for the same diagram, in the same tab
    * position and with its viewport: a new container, client id and load.
    * Reopens run one at a time, since each places its replacement next to a
    * neighbour that a reopen running alongside could take out of the layout.
    */
   reopen(widget: GLSPDiagramWidget): Promise<void> {
      const reopened = this.reopening.then(() => this.replaceWidget(widget));
      this.reopening = reopened.catch(() => undefined);
      return reopened;
   }

   /** Taken down as a close does, but without its save prompt, since a dirty
    *  diagram whose server is gone has nothing to save to. */
   protected async replaceWidget(widget: GLSPDiagramWidget): Promise<void> {
      if (widget.isDisposed) {
         return;
      }
      const tabBar = this.shell.getTabBarFor(widget);
      const titles = tabBar?.titles ?? [];
      const index = titles.indexOf(widget.title);
      // ponytail: a diagram alone in its tab bar reopens where a new one opens,
      // since its split closes with it; restore the dock layout if that matters.
      const neighbour = index > 0 ? titles[index - 1].owner : titles[index + 1]?.owner;
      const mode = this.shell.activeWidget === widget ? 'activate' : tabBar?.currentTitle === widget.title ? 'reveal' : 'open';
      // Detached before the dispose, as a close does: the widget stores its
      // viewport on detach, and its dispose empties the container it reads.
      widget.parent = null;
      widget.dispose();
      const options: GLSPWidgetOpenerOptions = {
         mode,
         editMode: widget.options.editMode,
         widgetOptions: neighbour ? { ref: neighbour, mode: index > 0 ? 'tab-after' : 'tab-before' } : undefined
      };
      await this.open(widget.uri, options);
   }

   /**
    * Drops a `selection` key that is present but `undefined` before the base
    * class reads it.
    *
    * Without this, opening a diagram from Theia's file picker throws and the
    * editor never leaves "Loading diagram…". Upstream's
    * `OptionsWithSelection.is` tests `'selection' in options`, which is true for
    * a key explicitly set to `undefined`, and the branch it guards then calls
    * `Object.keys` on that value. Theia's own `QuickFileOpenService` always sets
    * the key — its `buildOpenerOptions` returns `{ selection: range }`, and
    * `range` is `undefined` unless the query carried a `:line:column` suffix —
    * so the crash is reached by the ordinary act of opening a diagram by name.
    *
    * Normalising the OPTIONS rather than rebinding
    * `TheiaOpenerOptionsNavigationService`: the service is shared by every
    * diagram type in the container, so replacing it would make one adopter's
    * fix silently global, and the guard belongs where the value enters rather
    * than where it is consumed. The base method stays the single implementation.
    */
   protected override handleNavigations(widget: GLSPDiagramWidget, options?: WidgetOpenerOptions): boolean {
      if (options && 'selection' in options && (options as { selection?: unknown }).selection === undefined) {
         const { selection: _dropped, ...rest } = options as WidgetOpenerOptions & { selection?: unknown };
         return super.handleNavigations(widget, rest);
      }
      return super.handleNavigations(widget, options);
   }
}
