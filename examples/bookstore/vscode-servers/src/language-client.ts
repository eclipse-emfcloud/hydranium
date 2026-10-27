/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

// Starts the Bookstore server for VS Code, and for a Theia app that sideloads
// this extension: one launch, so both hand the server the same documents.

import { textDocumentContentMiddleware } from '@hydranium/client-vscode/node';
import { ALL_LANGUAGES } from '@hydranium/bookstore-protocol';
import { type ExtensionContext, workspace } from 'vscode';
import { LanguageClient, TransportKind } from 'vscode-languageclient/node';

/** Fork the server, start its language client and return it once started. */
export async function startBookstoreLanguageClient(context: ExtensionContext): Promise<LanguageClient> {
   // Resolved through the package, so it works from the workspace and from an
   // installed extension alike. Over IPC, which keeps the server's stdout free.
   const serverModule = require.resolve('@hydranium/bookstore-server/lib/main.js');
   const extensions = ALL_LANGUAGES.flatMap(language => language.fileExtensions).join(',');
   const client: LanguageClient = new LanguageClient(
      'bookstore',
      'Bookstore',
      { module: serverModule, transport: TransportKind.ipc },
      {
         documentSelector: ALL_LANGUAGES.map(({ languageId }) => ({ scheme: 'file', language: languageId })),
         // Changes on disk the editor does not hold, such as a file another tool writes.
         synchronize: { fileEvents: workspace.createFileSystemWatcher(`**/*{${extensions}}`) },
         // The text of a document only the server holds, such as a built-in library.
         middleware: textDocumentContentMiddleware(() => client)
      }
   );
   context.subscriptions.push(client);
   await client.start();

   return client;
}
