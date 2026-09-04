/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * Monaco's own editor worker, as a bundle entry of its own.
 *
 * **This is a THIRD worker and it hosts no head.** Monaco runs some of its
 * services off the main thread — link detection, the diff algorithm, and the
 * minimal-edit computation the suggest controller uses when it applies a
 * completion — and expects the embedder to say where that worker's script is.
 * Nothing about the language server passes through here; the LSP head lives in
 * `src/worker/order-flow-worker.ts` on a `MessagePort` and knows nothing about
 * Monaco.
 *
 * Left unsupplied, Monaco resolves a `vs/base/worker/...` URL that no bundle
 * emits, and the console error arrives on the first edit rather than at startup.
 *
 * # Why this file has a body at all
 *
 * `monaco-editor` ships a ready-made `editor.worker.js` entry;
 * `monaco-editor-core` does not, because assembling one is precisely what the
 * wrapper package exists to do. The six lines below are that entry, ported: wait
 * for a first message, then `start`, which calls `initialize` — and `initialize`
 * reassigns `globalThis.onmessage` to the real dispatcher before returning, so
 * this handler runs exactly once and every later message reaches the worker
 * server rather than this file.
 *
 * **The first message is deliberately DISCARDED**, matching upstream: the host
 * sends one purely to trigger this bootstrap, and the worker's real protocol
 * starts with the second. Handing it to `start` would be a protocol error.
 *
 * The deep specifier is the one concession `monaco-editor-core` costs, and it is
 * one rather than the ten that composing the editor's contributions by hand
 * would take.
 */

import { start } from 'monaco-editor-core/esm/vs/editor/editor.worker.start.js';

self.onmessage = (): void => {
   start(() => ({}));
};
