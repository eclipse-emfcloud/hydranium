/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

// The Bookstore VS Code extension: the language client, started the way the
// servers extension starts it, a Show Model command reading a file through the
// data head, and a custom editor for each diagram. Node extension host only:
// the server is forked and its socket heads reached over TCP.

import { GlspVscodeConnector } from '@eclipse-glsp/vscode-integration';
import { findPort } from '@hydranium/client-vscode/node';
import { SocketDataPort } from '@hydranium/data-client-vscode/node';
import { HydraniumGlspVscodeServer } from '@hydranium/glsp-client-vscode/node';
import { ConsoleLogger, DataConnectionWithEvents, describeError, renderFrameworkMessage } from '@hydranium/protocol';
import {
   BOOKSTORE_DATA_SERVER_PORT_COMMAND,
   BOOKSTORE_GLSP_SERVER_PORT_COMMAND,
   type BookstoreElement
} from '@hydranium/bookstore-protocol';
import { commands, type ExtensionContext, window } from 'vscode';
import type { LanguageClient } from 'vscode-languageclient/node';
import { startBookstoreLanguageClient } from 'bookstore-vscode-servers/out/language-client.js';
import { BOOKSTORE_DIAGRAM_VIEW_TYPE, BookstoreDiagramEditorProvider } from './bookstore-diagram-editor.js';
import { showModelCommand } from './show-model-command.js';

let client: LanguageClient | undefined;

export async function activate(context: ExtensionContext): Promise<void> {
   const running = await startBookstoreLanguageClient(context);
   client = running;

   // The data head, read by the Show Model command. Nothing connects until it runs.
   const dataPort = new SocketDataPort({
      findPort: () => findPort(running, BOOKSTORE_DATA_SERVER_PORT_COMMAND),
      logger: new ConsoleLogger().with('data head'),
      // A failed read shown to the user, not only logged; the message carries the detail.
      reportError: (_error, reported) => void window.showErrorMessage(renderFrameworkMessage(reported))
   });
   const dataConnection = new DataConnectionWithEvents<BookstoreElement>(dataPort);
   context.subscriptions.push(dataConnection, dataPort, commands.registerCommand('bookstore.showModel', showModelCommand(dataConnection)));

   // The GLSP head, and the connector bridging it to every diagram webview. No
   // `messenger` option: the connector's own keeps messages flowing to a hidden tab.
   const glspServer = new HydraniumGlspVscodeServer({
      clientId: 'bookstore-glsp',
      clientName: 'Bookstore',
      findPort: () => findPort(running, BOOKSTORE_GLSP_SERVER_PORT_COMMAND),
      logger: new ConsoleLogger().with('GLSP head')
   });
   const glspConnector = new GlspVscodeConnector({ server: glspServer, logging: false });
   context.subscriptions.push(glspServer, glspConnector);
   // Not awaited, so a session that opens no diagram does not wait on the port.
   // `start()` resolves either way; a failure is reported off `onReady`.
   void glspServer.start();
   void glspServer.onReady.catch((error: unknown) => {
      void window.showErrorMessage(`Bookstore diagram unavailable: ${describeError(error)}`);
   });
   const bookstoreEditor = new BookstoreDiagramEditorProvider(glspConnector, context.extensionUri);
   context.subscriptions.push(
      window.registerCustomEditorProvider(BOOKSTORE_DIAGRAM_VIEW_TYPE, bookstoreEditor, {
         // A hidden tab keeps its diagram session rather than repeating the handshake.
         webviewOptions: { retainContextWhenHidden: true },
         // Two views of one document would be two GLSP clients racing on one model.
         supportsMultipleEditorsPerDocument: false
      })
   );
}

export async function deactivate(): Promise<void> {
   await client?.stop();
   client = undefined;
}
