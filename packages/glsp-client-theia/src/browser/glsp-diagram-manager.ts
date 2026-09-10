/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { codiconCSSString } from '@eclipse-glsp/client';
import { GLSPDiagramManager } from '@eclipse-glsp/theia-integration';
import { type GLSPDiagramLanguage } from '@eclipse-glsp/theia-integration/lib/common';
import { type GLSPDiagramWidget } from '@eclipse-glsp/theia-integration/lib/browser';
import { type WidgetOpenerOptions } from '@theia/core/lib/browser';
import { injectable } from '@theia/core/shared/inversify';

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
