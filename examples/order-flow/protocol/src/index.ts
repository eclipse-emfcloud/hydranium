/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * What the order-flow server and its clients both name: the language ids and
 * extensions, the socket heads' port commands, the `.process` diagram ids and
 * the transfer model.
 *
 * A client depends on this package instead of the server, so it never installs
 * Langium to reach a constant. The two `generated-hydranium` modules are
 * written by the server's `generate` and committed.
 */

export * from './generated-hydranium/languages';
export * from './generated-hydranium/transfer-model';
export * from './head-ports';
export * from './process-diagram-types';
