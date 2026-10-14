/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

// The Monaco entry (`@hydranium/client-browser/monaco`). Behind a subpath because
// `monaco-editor-core` touches the DOM at load and has no Node entry, so the `.`
// barrel stays loadable by a host's Node tests and a page without Monaco.
export * from './monaco-lsp-client';
