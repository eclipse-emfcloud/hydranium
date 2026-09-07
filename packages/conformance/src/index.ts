/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

// Head-agnostic core of the hydranium conformance kit (TCK). Exports the
// shared fixture model + the check/run-loop/reporting primitives the per-head
// slices build on. Each head ships as a SEPARATE subpath — `@hydranium/
// conformance/data`, `.../lsp`, `.../glsp` — so importing one slice never
// pulls another head's protocol types in (the no-root-hub rule). This root
// barrel deliberately re-exports NONE of the slices.

export * from './model.js';
export * from './conformance-suite.js';
// `waitFor` / `tick` belong to `@hydranium/protocol/testing`, the shared
// server-free test primitives — import them from there, not from the kit.
