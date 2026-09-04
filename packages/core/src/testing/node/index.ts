/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * `@hydranium/core/testing/node` — the test support that needs a Node runtime:
 * the scratch-workspace, golden-corpus and generated-workspace fixtures (all
 * three reach the real filesystem), the in-process LSP transport
 * (`vscode-jsonrpc/node` stream readers), the all-in-one LSP harness (a
 * `vscode-languageserver/node` `Connection`), and the subprocess tier, which
 * spawns a built entry as a child process.
 *
 * Separate from `./testing` so that barrel stays browser-neutral and can be
 * gated as such. Each module here names a capability a browser genuinely lacks,
 * so this is a real split rather than a packaging preference — the same
 * distinction the package surface draws between `.` and `./node`.
 */

export * from './generated-workspace.js';
export * from './golden-corpus.js';
export * from './lsp-harness.js';
export * from './lsp-server-connection.js';
export * from './scratch-workspace.js';
export * from './spawned-server.js';
