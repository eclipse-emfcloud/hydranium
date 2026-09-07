/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

// Zero-arg service factory for the headless `hydranium-cli` tooling: the
// `reflect` / `lint-grammar` / `validate` subcommands import this via
// `--services ./lib/services.js`. The head wires its own filesystem here.
//
// The contract is language-count-agnostic — a second grammar needs no edit here.

import { NodeFileSystem } from '@hydranium/core/node';
import { createOrderFlowServices } from './language-server/order-flow-module.js';

export function createServices(): ReturnType<typeof createOrderFlowServices> {
   return createOrderFlowServices({ ...NodeFileSystem });
}
