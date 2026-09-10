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
// Covers a key that is a PREFIX of another key. A catalogue is nested JSON, so
// the longer key needs an object where the shorter one already put a string;
// the extractor drops it and exits 0. This is a property of the whole
// catalogue rather than of one call site, which is why no lint selector can
// express it.
//
// `nls` is deliberately undeclared, for the reason the sibling fixture states.

// The control. It must survive extraction, or a fixture the gate never reached
// would look identical to one whose key was dropped.
export const present = nls.localize('canary/prefix-collision/present', 'Present');

export const parent = nls.localize('canary/prefix-collision/parent', 'Parent');

export const child = nls.localize('canary/prefix-collision/parent/child', 'Child');
