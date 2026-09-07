/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

// Subpath barrel for `@hydranium/protocol/data` — typed bidirectional
// contract for the data-server protocol head, split into composable
// `*ServerProtocol` / `*ClientProtocol` fragments. Implementations live in
// `@hydranium/data-server`; typed proxies are produced by the
// direction-neutral `createRpcProxy` (in `../rpc`) with the data-server
// method-name lists + wire prefix exported here from
// `./data-protocol-methods.ts`.

export * from './data-protocol-methods';
export * from './data-server-protocol';
export * from './diagnostics';
export * from './events';
export * from './methods';
export * from './requests';
