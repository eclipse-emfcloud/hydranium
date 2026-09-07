/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { ExternalMarkerManager, type Marker } from '@eclipse-glsp/client';
import { injectable } from '@theia/core/shared/inversify';

/**
 * {@link ExternalMarkerManager} that drops all marker propagation into Theia's
 * Problems view. GLSP's `SetMarkersActionHandler` still applies the in-diagram
 * decoration through the separate `ValidationFeedbackEmitter` path; only the
 * forward into the `ProblemManager` is suppressed, so the LSP head stays the
 * single source of Problems-view diagnostics.
 *
 * Bound per diagram by `AbstractHydraniumGlspDiagramConfiguration` when its
 * `propagateMarkersToProblemsView` flag is `false`; see that flag for when a
 * head should choose it.
 *
 * Kept in its own module — importing only `@eclipse-glsp/client`, not
 * `@eclipse-glsp/theia-integration` — so it stays unit-testable without pulling
 * the Theia integration into the test graph.
 */
@injectable()
export class NoOpExternalMarkerManager extends ExternalMarkerManager {
   setMarkers(_markers: Marker[], _reason?: string, _sourceUri?: string): void {
      // Intentionally empty — the LSP head owns the Problems view.
   }
}
