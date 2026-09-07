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
}
