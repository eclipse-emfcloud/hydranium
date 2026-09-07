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
// Covers a third-party package's `/node` subpath, the shape that actually got
// through: `vscode-jsonrpc/node` sat in a duplex test transport reachable from
// three gated entries, and the gate reported them neutral because a bare
// specifier is externalised unread. This is the canary to keep if any is
// dropped.

import 'vscode-jsonrpc/node';

export const canary = 'third-party-node-subpath';
