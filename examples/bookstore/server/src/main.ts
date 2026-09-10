#!/usr/bin/env node
/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

// Standalone entry point: starts the Langium LSP head, a socket data-server (model server) head and a GLSP head in the same
// process, so every head shares one model store.
// Invocation: `node lib/main.js --stdio`, or the package's `bookstore` bin
// script.
//
// NOT the entry `hydranium-cli query` / `save` / `projects` / `watch` speak to:
// stdio here carries LSP, and the data head is a socket whose port is published
// over the LSP connection. Those subcommands spawn `data-server-main.js`.
//
// Everything here runs at module scope, so this file is an executable rather
// than a library entry — import `./index.js` instead to compose the language.

import 'reflect-metadata';
import { ServerModule } from '@eclipse-glsp/server/node.js';
import { GlspClientLogger, HydraniumGlspAppModule } from '@hydranium/glsp-server';
import { startGlspServer } from '@hydranium/glsp-server/node';
import { NodeFileSystem, publishPortOnLspConnection, startSocketServer } from '@hydranium/core/node';
import { DataServer } from '@hydranium/data-server';
import { startLanguageServer } from '@hydranium/langium/lsp';
import { ProposedFeatures, createConnection } from 'vscode-languageserver/node';
import { BookstoreDiagramModule } from './glsp/bookstore/diagram-module.js';
// The TRANSFER root, not the AST one. The data head serialises to the
// persisted shape, where `Reference<T>` is a plain `string`; the AST's is a
// Langium reference object with `.ref` / `.$refText`. Both satisfy
// `TransferElement` structurally, so naming the AST type here compiles fine and
// silently tells every typed client that a reference is a resolvable object
// rather than a name.
import type { BookstoreModel } from './language-server/generated-hydranium/transfer-model.js';
import { createBookstoreServices } from './language-server/bookstore-module.js';

import { BOOKSTORE_DATA_SERVER_PORT_COMMAND, BOOKSTORE_GLSP_PORT_COMMAND } from './head-ports.js';

const connection = createConnection(ProposedFeatures.all);
const { shared } = createBookstoreServices({ connection, ...NodeFileSystem });
startLanguageServer(shared);

// Data-server head alongside LSP: binds an ephemeral port, published over the LSP
// connection for the host to discover. Each accepted client gets its own DataServer.
//
// Neither the bind nor the publish may be swallowed: either failure leaves the LSP
// head serving text edits while every data client waits on a port command that was
// never registered, and the launcher reports a bind failure only if given a logger.
const dataServer = startSocketServer({ port: 0, logTag: 'ModelServer', logger: shared.Logger }, dataConnection => {
   new DataServer<BookstoreModel>(dataConnection, shared);
   return { dispose: () => undefined };
});
dataServer.started
   .then(() => {
      const { port } = dataServer;
      if (port === undefined) {
         // `started` resolves only once the address is resolved, so this is
         // unreachable; a non-null assertion in its place would publish
         // `undefined`, which the host cannot tell from an unreachable port.
         throw new Error('the data head started without a resolved port');
      }
      publishPortOnLspConnection(shared.lsp.Connection, BOOKSTORE_DATA_SERVER_PORT_COMMAND, port);
   })
   .catch((error: unknown) => {
      const reason = error instanceof Error ? error.message : String(error);
      shared.Logger.error(`[ModelServer] Could not publish the data-server port: ${reason}`);
   });

// GLSP head on the same shared workspace. `HydraniumGlspAppModule` is used
// unsubclassed: the app container is one per process and cannot know which
// grammar a request concerns, so nothing per-language belongs there — each
// diagram module declares its own language instead.
//
// GLSP framework logs route through the LSP connection rather than stdout, which
// IS the LSP transport in stdio mode; writing there corrupts the protocol stream.
const glspServer = startGlspServer({
   // The GLSP log threshold lives on the logger, not beside it: the framework
   // replaces GLSP's own `Logger` binding, so a launcher-level `logLevel` would
   // be discarded. The logger tracks the framework's process-wide threshold, so
   // `HYDRANIUM_LOG_LEVEL` and the LSP log-level setting govern GLSP output too;
   // pass `logLevel` only to make GLSP quieter than the rest of the server.
   createLogger: caller => new GlspClientLogger(shared, { component: caller }),
   serverModule: new ServerModule().configureDiagramModule(new BookstoreDiagramModule()),
   appModules: [new HydraniumGlspAppModule({ shared })],
   lspConnection: shared.lsp.Connection,
   portCommand: BOOKSTORE_GLSP_PORT_COMMAND
});
void glspServer;
