/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * Public surface of the order-flow example server. Hosts and tests compose
 * the three languages — `.domain`, `.process` and `.layout` — through
 * `createOrderFlowServices` and read the combined AST from
 * `./language-server/ast.js`.
 *
 * The language-server seams a host is expected to subclass or re-bind are
 * exported here, so composition and extension both go through this one entry.
 * `./testing` is deliberately absent: test support is reached through its own
 * subpath, keeping the production barrel test-free.
 */

export * from './head-ports.js';
export * from './language-server/ast.js';
export * from './language-server/domain-serializer.js';
export * from './language-server/layout-scope-provider.js';
export * from './language-server/layout-serializer.js';
export * from './language-server/order-flow-ast-builder.js';
export * from './language-server/order-flow-ast-extension.js';
export * from './language-server/order-flow-integrity.js';
export * from './language-server/order-flow-module.js';
export * from './language-server/order-flow-project-manager.js';
export * from './language-server/order-flow-scope-computation.js';
export * from './language-server/order-flow-stdlib.js';
export * from './language-server/process-scope-provider.js';
export * from './language-server/process-serializer.js';
