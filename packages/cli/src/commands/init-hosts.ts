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
export const INIT_HOSTS = ['browser', 'vscode', 'theia-browser'] as const;

/** One host application — see {@link INIT_HOSTS}. */
export type InitHost = (typeof INIT_HOSTS)[number];

/**
 * The heads a host needs at least one of: those whose client edits and saves
 * the files. The browser page has no filesystem of its own, so it saves through
 * the LSP head's editor or the GLSP head's diagram. VS Code and Theia own the
 * files and reach the server through a language client, so they need the LSP
 * head. Every other head is optional, and a head the host does not know is left
 * unused.
 */
const EDITING_HEADS: Record<InitHost, readonly InitHead[]> = {
   browser: ['lsp', 'glsp'],
   vscode: ['lsp'],
   'theia-browser': ['lsp']
};

/** True for a string naming one of {@link INIT_HOSTS}. */
export function isInitHost(value: string): value is InitHost {
   return (INIT_HOSTS as readonly string[]).includes(value);
}

/** The heads {@link host} needs at least one of in the composition. */
export function editingHeads(host: InitHost): readonly InitHead[] {
   return EDITING_HEADS[host];
}
