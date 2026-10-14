/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

// `monaco-editor-core` types its editor API only, so the worker entry
// `monaco-editor-worker.ts` imports is declared here.

declare module 'monaco-editor-core/esm/vs/editor/editor.worker.start.js' {
   /** Start the editor worker's dispatcher, with `createClient`'s result answering requests of the embedder's own. */
   export function start(createClient: () => object): void;
}
