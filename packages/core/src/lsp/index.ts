/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

export * from './completion/hydranium-completion-provider.js';
export * from './instrument-connection.js';
export * from './semantic-token-provider.js';
export * from './language-module.js';
export * from './shared-module.js';
export * from './hydranium-document-update-handler.js';

/**
 * The LSP server entry point, so adopters get a unified import surface for the
 * head: framework overrides + the start function live behind one
 * `@hydranium/core/lsp` subpath, mirroring Langium's own `langium/lsp`
 * convention. Signature-compatible with Langium's `startLanguageServer`, plus
 * a guard that the head's shared module was composed.
 */
export * from './start-language-server.js';
