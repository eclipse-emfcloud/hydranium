/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

// Subpath barrel for `@hydranium/protocol/testing` — the BROWSER-NEUTRAL shared
// primitives: `makeFakeClock` (deterministic `Clock` double on one virtual time
// axis), `waitFor` / `tick`, the client-side data-head doubles
// (`makeFakeDataPort` / `makeCapturingDataClient`), and the `Harness` marker
// interface every framework harness extends. Kept out of the main barrel so production bundles don't pull
// the test scaffolding in by default; adopters opt in by importing from
// `@hydranium/protocol/testing`.
//
// Neutrality is gated (`scripts/check-neutral-bundles.mjs`), which is why the
// duplex transports are NOT here: a `PassThrough` pair is in their exported
// type, so they cannot be made portable and live at `./testing/node` instead.
// The same rule the package surface uses — the portable name is the short one.

export * from './data-doubles';
export * from './fake-clock';
export * from './harness';
export * from './wait-for';
