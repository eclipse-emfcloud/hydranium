#!/usr/bin/env node
/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

// Standalone entry point: starts the Langium LSP head plus a socket data-server
// (model server) head in the same process, so both share one model store.
// Invocation: `node lib/main.js --stdio`, or the package's `order-flow-server`
// bin script.
//
// NOT the entry `hydranium-cli query` / `save` / `projects` / `watch` speak to:
// stdio here carries LSP, and the data head is a socket whose port is published
// over the LSP connection. Those subcommands spawn `data-server-main.js`.
//
// Everything here runs at module scope, so this file is an executable rather
// than a library entry — import `./index.js` instead to compose the language.
//
// Scaffolded by `hydranium-cli init` for a three-head, three-grammar
// composition. The data head's root type is the union of every grammar's
// transfer root, which is what one data server serving N grammars means.

import 'reflect-metadata';
import { ServerModule } from '@eclipse-glsp/server/node.js';
import { GlspClientLogger, HydraniumGlspAppModule } from '@hydranium/glsp-server';
import { startGlspServer } from '@hydranium/glsp-server/node';
import { NodeFileSystem, publishPortOnLspConnection, startSocketServer } from '@hydranium/core/node';
import { DataServer } from '@hydranium/data-server';
import { startLanguageServer } from '@hydranium/langium/lsp';
import { ProposedFeatures, createConnection } from 'vscode-languageserver/node';
import { OrderFlowProcessDiagramModule } from './glsp/order-flow-process-diagram-module.js';
import { ORDER_FLOW_DATA_SERVER_PORT_COMMAND, ORDER_FLOW_GLSP_PORT_COMMAND } from './head-ports.js';
// The TRANSFER roots, not the AST ones. The data head serialises to the
// persisted shape, where `Reference<T>` is `string`; the AST's is a Langium
// reference object with `.ref` / `.$refText`. Both satisfy `TransferElement`
// structurally, so naming the AST types here compiles fine and silently tells
// every typed client that `subject` is a resolvable object rather than a name.
import type { DomainModel, LayoutModel, ProcessModel } from './language-server/generated-hydranium/transfer-model.js';
import { createOrderFlowServices } from './language-server/order-flow-module.js';

const connection = createConnection(ProposedFeatures.all);
const { shared } = createOrderFlowServices({ connection, ...NodeFileSystem });
startLanguageServer(shared);

// Data-server head alongside LSP: binds an ephemeral port, published over the LSP
// connection for the host to discover. Each accepted client gets its own DataServer.
//
// Neither the bind nor the publish may be swallowed: either failure leaves the LSP
// head serving text edits while every data client waits on a port command that was
// never registered, and the launcher reports a bind failure only if given a logger.
const dataServer = startSocketServer({ port: 0, logTag: 'ModelServer', logger: shared.Logger }, dataConnection => {
   new DataServer<DomainModel | LayoutModel | ProcessModel>(dataConnection, shared);
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
      publishPortOnLspConnection(shared.lsp.Connection, ORDER_FLOW_DATA_SERVER_PORT_COMMAND, port);
   })
   .catch((error: unknown) => {
      const reason = error instanceof Error ? error.message : String(error);
      shared.Logger.error(`[ModelServer] Could not publish the data-server port: ${reason}`);
   });

// GLSP head, third on the same shared workspace. `.process` is the only grammar
// with a diagram; `.domain` is LSP-primary by design, which is the head
// asymmetry this example exists to show.
//
// The framework `HydraniumGlspAppModule` is used unsubclassed: the app
// container is one per process and cannot know which grammar a request
// concerns, so nothing per-language belongs here — the diagram module declares
// its language instead. The operation handlers reach language services through
// `modelState.languageServicesFor(node)`, which resolves the services of the
// language owning that node's document, so no per-language binding is needed
// here at all. Subclassing this module is only for adopter-wide injectables of
// your own.
//
// GLSP framework logs route through the LSP connection rather than stdout,
// which IS the LSP transport in stdio mode; writing there corrupts the
// protocol stream.
//
// No `logLevel` is passed, deliberately: the logger tracks the framework's
// process-wide threshold, so `HYDRANIUM_LOG_LEVEL` and the LSP log-level
// setting govern GLSP output along with everything else. Pass one only to make
// GLSP quieter than the rest of the server.
const glspServer = startGlspServer({
   createLogger: caller => new GlspClientLogger(shared, { component: caller }),
   serverModule: new ServerModule().configureDiagramModule(new OrderFlowProcessDiagramModule()),
   appModules: [new HydraniumGlspAppModule({ shared })],
   lspConnection: shared.lsp.Connection,
   portCommand: ORDER_FLOW_GLSP_PORT_COMMAND
});
void glspServer;
