/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { defineMessage } from '@hydranium/protocol';

/**
 * What a user reads when a diagram load fails: `reason` is the described
 * error. Formatted in English by `HydraniumDiagramLoader`; a host that knows
 * the reading user's locale renders the same sentence under a key of its own
 * by overriding its `loadFailureLabel`, as the Theia loader does.
 *
 * In a module of its own, apart from the loader that raises it, so the
 * `./messages` barrel loads no `@eclipse-glsp/client`: a bundle that only
 * translates the code must not need GLSP's stylesheets.
 */
export const DIAGRAM_LOAD_FAILED = defineMessage('hydranium/glsp-client/diagram-load-failed', 'Diagram failed to load: {reason}');
