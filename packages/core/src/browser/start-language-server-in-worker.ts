/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { createMessagePortTransport, type LatencyCollector, type TransferredMessagePort } from '@hydranium/protocol';
import { createConnection, ProposedFeatures, type Connection } from 'vscode-languageserver/browser';
import type { ServerSharedServices } from '../langium/module.js';
import { withHydraniumLspFeatures } from '../lsp/connection-features.js';
import { lspLatencyOptions } from '../lsp/lsp-latency.js';
import { listenToSaveTextDocument, withSaveTextDocumentCapability } from '../lsp/save-text-document.js';
import { startLanguageServer } from '../lsp/start-language-server.js';

export interface WorkerLanguageServerOptions {
   /** Records every request the head answers. One collector serves every head, so a report covers them all. */
   readonly latency?: LatencyCollector;
}

/**
 * Start the LSP head on the port the page transferred for it, and return the
 * shared tier `compose` built around its connection.
 *
 * `compose` is the adopter's services factory, called with the connection
 * exactly as a Node entry calls it with a stdio one; the filesystem it spreads
 * in must already be restored, since every read the head makes is synchronous
 * and the transport drops a message that arrives before `startLanguageServer`
 * listens. The page's end of the port closing ends only this head's
 * connection, not the worker the other heads share, so the language client's
 * documents are closed here, each reverting as its last close does.
 *
 * The worker holds the files, so the page cannot write them and `didSave`
 * reports nothing: the head answers and advertises `SaveTextDocumentRequest`.
 */
export function startLanguageServerInWorker<TShared extends ServerSharedServices>(
   port: TransferredMessagePort,
   compose: (connection: Connection) => TShared,
   options: WorkerLanguageServerOptions = {}
): TShared {
   // Both ends use `createMessagePortTransport`; see it for why.
   const transport = createMessagePortTransport(port);
   const connection = createConnection(
      withSaveTextDocumentCapability(withHydraniumLspFeatures(ProposedFeatures.all)),
      transport.reader,
      transport.writer,
      lspLatencyOptions(options.latency)
   );
   const shared = compose(connection);
   listenToSaveTextDocument(connection, shared);
   startLanguageServer(shared);
   transport.reader.onClose(() => void shared.workspace.TextDocuments.closeLanguageClientDocuments());
   return shared;
}
