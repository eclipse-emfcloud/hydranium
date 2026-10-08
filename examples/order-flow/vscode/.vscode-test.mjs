/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

// The extension-host tier. It opens a copy of the fixture workspace, because
// the server's integrity repairs write through to the folder it is handed.

import { captureServerLog } from '@hydranium/core/testing/playwright';
import { makeScratchWorkspace } from '@hydranium/core/testing/node';
import { defineConfig } from '@vscode/test-cli';
import { resolve } from 'node:path';
import { VSCODE_VERSION } from './test/vscode-version.mts';

const workspace = makeScratchWorkspace({ seed: resolve(import.meta.dirname, '../workspace'), prefix: 'order-flow-vscode-host-' });
process.on('exit', () => workspace.dispose());

// The language server is forked by the extension host and inherits its
// environment, so this is what reaches it. A failing spec's server side is in
// `test-results/host/server-logs`, which CI uploads.
const serverLog = captureServerLog({ dir: resolve(import.meta.dirname, 'test-results/host/server-logs') });

export default defineConfig({
   files: 'out/host-test/test/host/**/*.test.js',
   version: VSCODE_VERSION,
   workspaceFolder: workspace.root,
   // Other installed extensions would share the host and its activation events;
   // the extension under development loads regardless.
   launchArgs: ['--disable-extensions'],
   env: serverLog.env,
   mocha: {
      // The runner's default is `tdd`, which defines `suite` / `test` rather
      // than the `describe` / `it` the specs and `@types/mocha` globals use.
      ui: 'bdd',
      // Activation forks the language server, which builds the workspace before
      // the first diagnostics or port answer.
      timeout: 60_000,
      reporter: resolve(import.meta.dirname, 'out/host-test/test/host/reporter.js'),
      reporterOptions: { output: resolve(import.meta.dirname, 'test-results/host/junit.xml'), suiteName: 'order-flow-vscode host' }
   }
});
