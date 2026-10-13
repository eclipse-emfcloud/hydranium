/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { HydraniumDiagramLoader } from '@hydranium/glsp-client';
import { nls } from '@theia/core';
import { injectable } from '@theia/core/shared/inversify';

/**
 * The framework loader rendering its failure through Theia's catalogue, which
 * knows the reading user's locale where the neutral loader does not.
 *
 * The key and the English are inline literals, because `theia nls-extract`
 * drops a key it cannot resolve. The English must match
 * `DIAGRAM_LOAD_FAILED`'s text in `@hydranium/glsp-client`; a test holds them
 * equal.
 *
 * Bound by `createGlspClientTheiaModule` via `rebind(DiagramLoader)`, after
 * `createGlspClientModule` bound the neutral loader.
 */
@injectable()
export class HydraniumGlspTheiaDiagramLoader extends HydraniumDiagramLoader {
   override loadFailureLabel(err: unknown): string {
      return nls.localize('hydranium/glsp-client-theia/diagram-load-failed', 'Diagram failed to load: {0}', this.formatError(err));
   }
}
