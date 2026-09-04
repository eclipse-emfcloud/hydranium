/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

// Subpath barrel for `@hydranium/protocol/testing/node` — the test transports
// that need a Node runtime: a crossed `PassThrough` pair and the in-process
// `MessageConnection` bridge over it.
//
// Separate from `./testing` because a `PassThrough` is in `DuplexStreamPair`'s
// exported type and `StreamMessageReader` comes from `vscode-jsonrpc/node`, so
// neither can be made portable — and keeping them in the neutral barrel taints
// every subpath that re-exports it, which is what made three of this repo's
// `./testing` entries unbundleable for a browser while having no Node code of
// their own.

export * from './duplex-connection';
export * from './duplex-stream';
