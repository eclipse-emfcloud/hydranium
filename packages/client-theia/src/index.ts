/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

// Root barrel. Every surface this package has is environment-bound, so the root
// exposes nothing directly rather than privileging one tier: node-side
// primitives (the socket-forwarding connection-handler base, which imports
// `node:net`) via `@hydranium/client-theia/node`; browser-side primitives (the
// preference-driven Output-channel logger, the renderer-runtime capture, the
// memory-diagnostics contribution) via `@hydranium/client-theia/browser`;
// shared test doubles via `@hydranium/client-theia/testing`. Re-exporting
// either tier here would drag a `node:net` import or a DOM type into the entry
// a consumer of the *other* tier resolves first.
export {};
