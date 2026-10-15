/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

// The Bookstore VS Code extension: the language client, started the way the
// servers extension starts it, and a custom editor for each diagram. Node
// extension host only: the server is forked and its socket heads reached over
// TCP.

import { GlspVscodeConnector } from '@eclipse-glsp/vscode-integration';
import { findPort } from '@hydranium/client-vscode/node';
import { HydraniumGlspVscodeServer } from '@hydranium/glsp-client-vscode/node';
import { ConsoleLogger, describeError } from '@hydranium/protocol';
import { BOOKSTORE_GLSP_SERVER_PORT_COMMAND } from '@hydranium/bookstore-protocol';
import { type ExtensionContext, window } from 'vscode';
import type { LanguageClient } from 'vscode-languageclient/node';
import { startBookstoreLanguageClient } from 'bookstore-vscode-servers/out/language-client.js';
import { BOOKSTORE_DIAGRAM_VIEW_TYPE, BookstoreDiagramEditorProvider } from './bookstore-diagram-editor.js';

let client: LanguageClient | undefined;

export async function activate(context: ExtensionContext): Promise<void> {
   const running = await startBookstoreLanguageClient(context);
   client = running;

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
