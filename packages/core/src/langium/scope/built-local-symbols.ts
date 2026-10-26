/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import type { AstNode, LocalSymbols } from '@hydranium/langium';

/** The local symbols each build computed, by the root it computed them for. */
export const builtLocalSymbols = new WeakMap<AstNode, LocalSymbols>();
