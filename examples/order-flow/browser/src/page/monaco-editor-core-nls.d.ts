/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * `monaco-editor-core`'s locale bundles, which its `typings` field does not
 * cover — that points at `editor.api.d.ts`, the editor API alone.
 *
 * **Nothing is declared inside the module because there is nothing in it.** The
 * bundle assigns `globalThis._VSCODE_NLS_MESSAGES` and `_VSCODE_NLS_LANGUAGE`
 * and exports no binding, so an empty declaration is the accurate one: it makes
 * the specifier resolvable while leaving a would-be import of a named export a
 * compile error rather than an `undefined` at runtime.
 *
 * One declaration per shipped locale rather than a wildcard
 * `'monaco-editor-core/esm/nls.messages.*'`. A wildcard would type a
 * MISSPELLED language code as valid and turn "Monaco ships no catalogue for
 * this" into a 404 at the dynamic import — and the whole set is a fixed
 * thirteen, so an enumeration cannot fall behind silently. Only the languages
 * `order-flow-page.ts` offers are listed; adding a page language means adding
 * its line here, which is the reminder that the two lists are one decision.
 */
declare module 'monaco-editor-core/esm/nls.messages.de.js';
