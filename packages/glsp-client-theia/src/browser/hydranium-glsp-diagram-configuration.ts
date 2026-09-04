/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { type ExternalMarkerManager } from '@eclipse-glsp/client';
import { GLSPDiagramConfiguration, connectTheiaContextMenuService, connectTheiaMarkerManager } from '@eclipse-glsp/theia-integration';
import { type Container, injectable } from '@theia/core/shared/inversify';
import { NoOpExternalMarkerManager } from './diagram-only-marker-manager.js';

/**
 * `GLSPDiagramConfiguration` base for hydranium adopters. By default GLSP
 * validation markers propagate into Theia's Problems view (the stock
 * `@eclipse-glsp/theia-integration` behaviour); a head that already publishes
 * the same diagnostics over LSP suppresses that propagation by setting
 * {@link propagateMarkersToProblemsView} to `false`.
 *
 * **When to suppress.** A head with a co-resident LSP that publishes its
 * diagnostics over standard LSP `publishDiagnostics` would otherwise list each
 * error twice: GLSP's `TheiaMarkerManager` pushes the *same* errors again under
 * a different marker owner, and Theia shows the union across owners. The GLSP
 * path is also open-diagram-scoped (markers clear when the diagram closes), so
 * for such a head it cannot reproduce the LSP head's persistent, cross-file
 * Problems entries — it is only ever a flickering duplicate. A graphical-only
 * head (no LSP diagnostics, or markers the LSP never produces) keeps the
 * default so its markers reach the Problems view. The on-diagram decoration is
 * a separate client feedback path (`ApplyMarkersCommand`), unaffected either
 * way.
 *
 * **How.** {@link initializeContainer} hands {@link connectTheiaMarkerManager}
 * the Theia marker-manager factory by default; when suppression is enabled it
 * hands a no-op {@link ExternalMarkerManager} factory instead, so the
 * per-diagram container binds a manager that renders-but-does-not-forward and
 * the real `TheiaMarkerManager` (with its `@postConstruct`
 * `ProblemManager`/shell subscriptions) is never constructed.
 *
 * NB: this overrides `GLSPDiagramConfiguration.initializeContainer` rather than
 * calling `super`. It mirrors the base body (context-menu + marker-manager
 * wiring); revisit if a future `@eclipse-glsp/theia-integration` adds further
 * setup there.
 */
@injectable()
export abstract class AbstractHydraniumGlspDiagramConfiguration extends GLSPDiagramConfiguration {
   /**
    * Whether GLSP markers propagate into Theia's Problems view. `true` (the
    * framework default) keeps the stock Theia propagation; set `false` for a
    * head with a co-resident LSP that already publishes the same diagnostics,
    * to render markers on the diagram only and avoid double-listing.
    */
   protected propagateMarkersToProblemsView = true;

   protected override initializeContainer(container: Container): void {
      connectTheiaContextMenuService(container, this.contextMenuServiceFactory);
      const markerManagerFactory = this.propagateMarkersToProblemsView
         ? this.theiaMarkerManager
         : (): ExternalMarkerManager => new NoOpExternalMarkerManager();
      connectTheiaMarkerManager(container, markerManagerFactory, this.diagramType);
   }
}
