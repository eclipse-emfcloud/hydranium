/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

// CANARY — this file is SUPPOSED to lose a key to `check:nls-extract`, and the
// gate asserts that it does. Nothing imports it and nothing compiles it; it is
// extracted only by the gate's self-test.
//
// Covers a key built from a constant imported from another module. The
// extractor cannot resolve it, drops the key, and still exits 0 — so the only
// evidence is the line it writes to the log.
//
// `nls` is deliberately undeclared: the extractor parses rather than
// typechecks, so a fixture that imported `@theia/core` would add a dependency
// on the host framework to buy nothing.

import { CROSS_FILE_KEY } from './keys';

// The control. It must survive extraction, or a fixture the gate never reached
// would look identical to one whose key was dropped.
export const present = nls.localize('canary/cross-file/present', 'Present');

export const dropped = nls.localize(CROSS_FILE_KEY, 'Dropped');
