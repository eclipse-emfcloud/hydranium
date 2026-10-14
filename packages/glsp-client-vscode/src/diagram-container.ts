/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * The class on the element the diagram mounts into. The extension host writes
 * it into the webview document and the webview's stylesheet sizes it, so it
 * lives on the neutral root both tiers reach.
 */
export const DIAGRAM_CONTAINER_CLASS = 'hydranium-diagram-container';
