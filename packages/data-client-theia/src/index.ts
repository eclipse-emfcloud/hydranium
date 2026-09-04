/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

// Root barrel, deliberately empty: this package integrates a host whose own
// packages declare no root entry, so a consumer names a tier. The
// environment-agnostic surface is `@hydranium/data-client-theia/common`,
// browser-side primitives (channel transport / proxy wiring) are
// `.../browser`, and node-side ones (connection bootstrap) are `.../node`, so
// env-specific imports cannot leak into the wrong bundle. Re-exporting `common/`
// from here would make the root a partial surface that hides which tier a
// symbol lives on, which is the ambiguity the split exists to remove.
export {};
