/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

// CANARY — this file is SUPPOSED to fail `check:neutral`, and the gate asserts
// that it does. Nothing imports it; it is bundled only by the gate's self-test.
//
// Covers the original check: a `node:`-prefixed builtin is left unresolved on
// purpose, so esbuild reports it. If this ever passes, the `node:` filter has
// stopped matching.

import 'node:fs';

export const canary = 'node-prefixed-builtin';
