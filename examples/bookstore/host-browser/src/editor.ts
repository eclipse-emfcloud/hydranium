/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

// The LSP part of the page: one Monaco editor over the LSP head, showing the
// file the page shows, and Save. The worker holds the files, so the page saves
// through the LSP head and the worker writes them to IndexedDB.

import { initializeLanguageClient, type WorkerHeads } from '@hydranium/client-browser';
import { MONACO_CLIENT_CAPABILITIES, MonacoLspClient } from '@hydranium/client-browser/monaco';
import { describeError } from '@hydranium/protocol';
import { ALL_LANGUAGES } from '@hydranium/bookstore-protocol';
import { PublishDiagnosticsNotification } from 'vscode-languageserver-protocol';
import { appendLog, setStatus } from './log.js';
import type { ShownFile } from './shown-file.js';
import { WORKSPACE_ROOT_URI } from './workspace.js';

/** Where Monaco's own worker bundle is served, substituted by `esbuild.mjs`. */
declare const __MONACO_WORKER_BUNDLE_URL__: string;

// Before any editor exists: Monaco otherwise looks for a worker script no
// bundle emits, and fails on the first edit.
self.MonacoEnvironment = { getWorker: () => new Worker(__MONACO_WORKER_BUNDLE_URL__) };

/** Each language as Monaco registers it, from the ids and extensions the server generates. */
const LANGUAGES = ALL_LANGUAGES.map(language => ({
   id: language.languageId,
   extensions: [...language.fileExtensions]
}));

/**
 * Run the LSP handshake, then show the page's shown file in the editor,
 * following each switch, and hand back the client {@link armEditorSave} saves
 * through.
 */
export async function startEditor(heads: WorkerHeads, shownFile: ShownFile): Promise<MonacoLspClient> {
   let client!: MonacoLspClient;
   await initializeLanguageClient(heads.lsp, {
      rootUri: WORKSPACE_ROOT_URI,
      capabilities: MONACO_CLIENT_CAPABILITIES,
      onLogMessage: params => appendLog(params.message),
      // Before `initialized`, since the server publishes from then on.
      beforeInitialized: result => {
         client = new MonacoLspClient(heads.lsp, result.capabilities, {
            languages: LANGUAGES,
            clientCapabilities: MONACO_CLIENT_CAPABILITIES
         });
         heads.lsp.onNotification(PublishDiagnosticsNotification.type, params => client.applyDiagnostics(params));
      }
   });

   const modelOf = (uri: string) => client.openDocument(uri, shownFile.files.get(uri) as string);
   const editor = client.createEditor(document.getElementById('editor') as HTMLElement, modelOf(shownFile.current()), {
      automaticLayout: true,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      wordWrap: 'on'
   });
   shownFile.onDidChange(uri => editor.setModel(modelOf(uri)));

   // Go to definition across files switches the editor to the target file.
   client.registerEditorOpener((uri, position) => {
      if (!shownFile.files.has(uri)) {
         return false;
      }
      shownFile.show(uri);
      editor.setPosition(position);
      editor.revealPositionInCenter(position);
      return true;
   });

   // Asks before a reload or a closed tab drops an unsaved edit.
   window.addEventListener('beforeunload', event => {
      if (client.dirtyDocuments().length > 0) {
         event.preventDefault();
      }
   });
   (document.getElementById('editor-pane') as HTMLElement).hidden = false;
   return client;
}

/**
 * Arm the page's Save and Ctrl+S, which save every file the editor holds
 * unsaved once `beforeSave` has settled: an edit made elsewhere, such as in the
 * diagram, shows in the editor only once the server has answered it. When
 * `beforeSave` throws, nothing is saved and the status says why.
 */
export function armEditorSave(client: MonacoLspClient, beforeSave: () => Promise<void> = () => Promise.resolve()): void {
   const save = (): void => {
      // The wait can last up to its bound on a server that stopped answering.
      setStatus('saving…');
      beforeSave()
         .then(() => client.saveAll())
         .then(
            saved => setStatus(`saved ${saved.length} file(s)`),
            (error: unknown) => setStatus(`save failed: ${describeError(error)}`)
         );
   };
   const saveButton = document.getElementById('save') as HTMLButtonElement;
   saveButton.addEventListener('click', save);
   // Ctrl+S (Cmd+S) saves too, in place of the browser's "Save page as".
   window.addEventListener('keydown', event => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
         event.preventDefault();
         save();
      }
   });
   saveButton.hidden = false;
}
