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
// `--services ./lib/node/services.js`. The head wires its own filesystem here.
//
// Behind the package's `./node` entry rather than its root because it reads
// the real filesystem: the root stays loadable in a browser worker, which has
// no `node:fs`.
//
// The contract is language-count-agnostic — a second grammar needs no edit here.

import { NodeFileSystem } from '@hydranium/core/node';
import { createBookstoreServices } from '../language-server/bookstore-module.js';

export function createServices(): ReturnType<typeof createBookstoreServices> {
   return createBookstoreServices({ ...NodeFileSystem });
}
