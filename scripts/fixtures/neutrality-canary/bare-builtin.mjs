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
// Covers a builtin spelled WITHOUT the `node:` prefix. Being bare, it is
// externalised rather than resolved, so it produces no error and can only be
// caught by name. It doubles as a standing check that the allowlist is keyed by
// IMPORTER: `'path'` is allowed from the workspace initializer and from nowhere
// else, so this file must still be rejected.

import 'path';

export const canary = 'bare-builtin';
