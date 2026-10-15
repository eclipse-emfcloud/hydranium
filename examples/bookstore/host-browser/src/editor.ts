/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

// The LSP part of the page: one Monaco editor over the LSP head, a switch
// between the workspace files, which the rest of the page can follow, and
// Save. The worker holds the files, so the page saves through the LSP head and
// the worker writes them to IndexedDB.

import { initializeLanguageClient, type WorkerHeads } from '@hydranium/client-browser';
import { MONACO_CLIENT_CAPABILITIES, MonacoLspClient } from '@hydranium/client-browser/monaco';
import { describeError } from '@hydranium/protocol';
import { ALL_LANGUAGES } from '@hydranium/bookstore-protocol';
import { PublishDiagnosticsNotification } from 'vscode-languageserver-protocol';
import { appendLog, setStatus } from './log.js';
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

/** The file the editor shows, for a part of the page that follows it. */
export interface ShownFile {
   /** The URI of the file shown now. */
   current(): string;
   /** Call `listener` with the URI of each file the editor switches to. */
   onDidChange(listener: (uri: string) => void): void;
}

/** Run the LSP handshake, then show the first workspace file in the editor. */
export async function startEditor(heads: WorkerHeads): Promise<ShownFile> {
   let client!: MonacoLspClient;
   await initializeLanguageClient(heads.lsp, {
      rootUri: WORKSPACE_ROOT_URI,
      capabilities: MONACO_CLIENT_CAPABILITIES,
      onLogMessage: params => appendLog(params.message),
      // Before `initialized`, since the server publishes from then on.
      beforeInitialized: result => {
         client = new MonacoLspClient(heads.lsp, result.capabilities, { languages: LANGUAGES });
         heads.lsp.onNotification(PublishDiagnosticsNotification.type, params => client.applyDiagnostics(params));
      }
   });

   // The text comes from the worker rather than the seed, since a saved edit
   // is laid over the seed there.
   const { workspace } = await heads.ready;
   if (workspace === undefined) {
      throw new Error('the worker sent no workspace files');
   }
   // Only the files a language claims: the client refuses to open any other.
   const paths = Object.keys(workspace.files)
      .filter(path => LANGUAGES.some(language => language.extensions.some(extension => path.endsWith(extension))))
      .sort();
   if (paths.length === 0) {
      throw new Error('no workspace file has a language extension');
   }
   const uriOf = (path: string): string => `${WORKSPACE_ROOT_URI}/${path}`;
   const modelOf = (path: string) => client.openDocument(uriOf(path), workspace.files[path]);

   const select = document.getElementById('file') as HTMLSelectElement;
   // The worker keys each file by its encoded path, as in its URI: shown decoded.
   select.append(...paths.map(path => new Option(decodeURIComponent(path), path)));
   const editor = client.createEditor(document.getElementById('editor') as HTMLElement, modelOf(paths[0]), {
      automaticLayout: true,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      wordWrap: 'on'
   });
   let shown = paths[0];
   const listeners: Array<(uri: string) => void> = [];
   const show = (path: string): void => {
      select.value = path;
      if (path !== shown) {
         shown = path;
         editor.setModel(modelOf(path));
         listeners.forEach(listener => listener(uriOf(path)));
      }
   };
   select.addEventListener('change', () => show(select.value));

   // Go to definition across files switches the editor to the target file.
   client.registerEditorOpener((uri, position) => {
      const path = paths.find(candidate => uriOf(candidate) === uri);
      if (path === undefined) {
         return false;
      }
      show(path);
      editor.setPosition(position);
      editor.revealPositionInCenter(position);
      return true;
   });

   const save = (): void => {
      client.saveAll().then(
         saved => setStatus(`saved ${saved.length} file(s)`),
         (error: unknown) => setStatus(`save failed: ${describeError(error)}`)
      );
   };
   (document.getElementById('save') as HTMLButtonElement).addEventListener('click', save);
   // Ctrl+S (Cmd+S) saves too, in place of the browser's "Save page as".
   window.addEventListener('keydown', event => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
         event.preventDefault();
         save();
      }
   });
   // Asks before a reload or a closed tab drops an unsaved edit.
   window.addEventListener('beforeunload', event => {
      if (client.dirtyDocuments().length > 0) {
         event.preventDefault();
      }
   });
   (document.getElementById('editor-pane') as HTMLElement).hidden = false;
   return { current: () => uriOf(shown), onDidChange: listener => listeners.push(listener) };
}
