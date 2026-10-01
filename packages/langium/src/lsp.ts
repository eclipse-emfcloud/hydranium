/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * Chokepoint mirror of Langium's `langium/lsp` subpath — the LSP service
 * defaults (`DefaultCompletionProvider`, etc.). Pure passthrough; it exists
 * so framework packages and adopters reach every Langium subpath through
 * this package and inherit its version pin instead of owning one themselves.
 */
// oxlint-disable-next-line import/export -- misreads export * from an npm package: https://github.com/oxc-project/oxc/pull/26872
export * from 'langium/lsp';
