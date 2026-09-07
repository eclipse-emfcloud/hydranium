/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

// Dependency-light on purpose: no Langium / vscode-* imports, so a Playwright
// test helper (which correlates server logs to a workspace) can reuse the exact
// same token derivation without pulling the language-server module graph. The
// env-var-name conventions it pairs with live in `@hydranium/protocol`.

/**
 * Derive the `{workspace}` placeholder token from a workspace folder URI or
 * filesystem path: its basename, with filename-unsafe characters replaced by
 * `_`. The server (file-tee) and a log-correlating test harness call this on
 * the same workspace path so they agree on the file name.
 */
export function toLogFileWorkspaceToken(uriOrPath: string): string {
   const trimmed = uriOrPath.replace(/[/\\]+$/, '');
   const lastSep = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
   const base = trimmed.slice(lastSep + 1);
   return base.replace(/[^A-Za-z0-9._-]/g, '_') || 'workspace';
}
