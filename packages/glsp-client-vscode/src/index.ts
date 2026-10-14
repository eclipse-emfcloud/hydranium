/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

// Neutral: what both tiers name. `./node` is the extension host's, and never
// reaches `@eclipse-glsp/client`, whose stylesheets Node cannot load;
// `./browser` is the webview's.
export * from './diagram-container';
