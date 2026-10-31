/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { defineMessage } from '@hydranium/protocol';

/**
 * The label of the button that closes a server message on the diagram.
 * Formatted in English by `HydraniumMessageOverlay`. A host that knows the
 * reading user's locale overrides its `dismissLabel`.
 *
 * In a module of its own, apart from the overlay, so the `./messages` barrel
 * loads no `@eclipse-glsp/client`.
 */
export const DIAGRAM_MESSAGE_DISMISS = defineMessage('hydranium/glsp-client/diagram-message-dismiss', 'Dismiss');
