/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * The one declaration `monaco-editor-core` does not ship.
 *
 * Its `typings` field points at `editor.api.d.ts`, which covers the editor API
 * and nothing else — so the worker bootstrap that
 * `src/page/monaco-editor-worker.ts` needs resolves to a `.js` file with no
 * types. `monaco-editor` hides this by shipping a ready-made `editor.worker.js`
 * entry; core leaves assembling one to the embedder.
 *
 * Declared rather than cast, so the call site stays typed and a signature change
 * upstream is a compile error here instead of a runtime one in a worker with no
 * console anyone is watching.
 */
declare module 'monaco-editor-core/esm/vs/editor/editor.worker.start.js' {
   /**
    * Boot the editor worker's RPC server and register `createClient`'s result as
    * its request handler.
    *
    * The editor worker's own operations (diff, minimal edits, links) are built
    * in, so the client an embedder supplies is empty unless it adds operations
    * of its own — which this page does not.
    *
    * Reassigns `globalThis.onmessage` to the real dispatcher, which is what makes
    * calling it from a one-shot bootstrap handler correct.
    */
   export function start(createClient: () => object): void;
}
