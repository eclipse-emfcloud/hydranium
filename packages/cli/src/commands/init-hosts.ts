/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * The host applications `init` can emit around the server: each holds the
 * clients of the heads it runs, in a sibling package of its own.
 */

import type { InitHead } from './init.js';

/** The hosts a scaffold can emit, in the order a workspace lists them. */
export const INIT_HOSTS = ['browser'] as const;

/** One host application — see {@link INIT_HOSTS}. */
export type InitHost = (typeof INIT_HOSTS)[number];

/**
 * The heads a host cannot run without. The browser page saves through the LSP
 * head, since it has no filesystem of its own; every other head is optional,
 * and a head the host does not know is left unused.
 */
const REQUIRED_HEADS: Record<InitHost, readonly InitHead[]> = {
   browser: ['lsp']
};

/** True for a string naming one of {@link INIT_HOSTS}. */
export function isInitHost(value: string): value is InitHost {
   return (INIT_HOSTS as readonly string[]).includes(value);
}

/** The heads {@link host} needs in the composition. */
export function requiredHeads(host: InitHost): readonly InitHead[] {
   return REQUIRED_HEADS[host];
}
