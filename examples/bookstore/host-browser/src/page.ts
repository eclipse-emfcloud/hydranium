/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

// The page: it starts the worker, hands each head a channel of its own, and
// fills the pane of each head the server runs, one after the other.

import { connectWorkerHeads } from '@hydranium/client-browser';
import { ConsoleLogger, describeError } from '@hydranium/protocol';
import { ALL_LANGUAGES } from '@hydranium/bookstore-protocol';
import { showDataStatus } from './data-status.js';
import { mountDiagram, settleDiagramEdits } from './diagram.js';
import { armEditorSave, startEditor } from './editor.js';
import { appendLog, setStatus } from './log.js';
import { startShownFile } from './shown-file.js';
import { WORKSPACE_ROOT_URI } from './workspace.js';

/** Where the worker bundle is served, substituted by `esbuild.mjs`. */
declare const __WORKER_BUNDLE_URL__: string;

async function main(): Promise<void> {
   // The page's end of each head's connection logs to the browser console.
   const logger = new ConsoleLogger();
   const heads = connectWorkerHeads(new Worker(__WORKER_BUNDLE_URL__), { logger });
   heads.onWorkerError(report => appendLog(`worker error during ${report.phase}: ${report.message}`));
   setStatus('starting…');
   const shownFile = await startShownFile(heads, ALL_LANGUAGES);
   const editor = await startEditor(heads, shownFile);
   let shownDiagram: Awaited<ReturnType<typeof mountDiagram>> | undefined = undefined;
   armEditorSave(editor, () => settleDiagramEdits(shownDiagram?.()));
   await showDataStatus(heads.data, `${WORKSPACE_ROOT_URI}/nodes.bookstore`);
   shownDiagram = await mountDiagram(heads.glsp, shownFile, logger, settleDiagramEdits);
   setStatus('ready');
}

main().catch((error: unknown) => setStatus(`failed: ${describeError(error)}`));
