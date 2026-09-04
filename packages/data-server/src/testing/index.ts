/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

// Subpath barrel for `@hydranium/data-server/testing` — the
// `makeDataServerHarness` harness for in-process round-trip testing without a
// real wire. The duplex `MessageConnection` pair lives in
// `@hydranium/protocol/testing`, which owns the transport; only its TYPE is
// re-exported here, because `DataServerHarness.pair` names it in a public
// signature. A test that wires its own server rather than using the harness
// calls `makeDuplexConnectionPair` from `@hydranium/protocol/testing` directly.

export type { DuplexConnectionPair } from '@hydranium/protocol/testing/node';
export * from './data-server-harness.js';
