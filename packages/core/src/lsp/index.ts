/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

export * from './completion/hydranium-completion-provider.js';
export * from './lsp-latency.js';
export * from './connection-features.js';
export * from './diagnostics-connection.js';
export * from './edit-requests-guard.js';
export * from './semantic-token-provider.js';
export * from './language-module.js';
export * from './shared-module.js';
export * from './hydranium-document-update-handler.js';
export * from './save-text-document.js';

/**
 * The LSP server entry point, so adopters get a unified import surface for the
 * head: framework overrides + the start function live behind one
 * `@hydranium/core/lsp` subpath, mirroring Langium's own `langium/lsp`
 * convention. Signature-compatible with Langium's `startLanguageServer`, plus
 * the composition check and the connection guards listed in its doc.
 */
export * from './start-language-server.js';
