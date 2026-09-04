/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * Public surface of the order-flow Theia shell.
 *
 * Only the environment-agnostic `common/` tier is re-exported here. The
 * `browser/` and `node/` tiers are reached by the paths Theia's extension
 * collector reads out of `theiaExtensions`, and they import `@theia/*` browser
 * and node entrypoints respectively — barrelling them together would drag the
 * frontend graph into the backend bundle and vice versa.
 */

export * from './common/order-flow-diagram-language';
export * from './common/order-flow-selection-uri';
