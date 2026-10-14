/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { type Locale, sendByMethodName } from '@hydranium/protocol';
import type { MessageConnection } from 'vscode-jsonrpc/browser';
import {
   ConfigurationRequest,
   InitializedNotification,
   InitializeRequest,
   LogMessageNotification,
   RegistrationRequest,
   UnregistrationRequest,
   type ClientCapabilities,
   type InitializeResult,
   type LogMessageParams
} from 'vscode-languageserver-protocol';

/** The one configuration section the server reads, and what it reads there. */
export interface LanguageClientConfiguration {
   /** The server's `lsp.configurationRoot`. A mismatch leaves every answer `null`, so the setting reads as unset. */
   readonly section: string;
   /** The section's whole subtree. The server replaces its cached section with what it is given, so a partial answer deletes the siblings it omits. */
   settings(): unknown;
}

export interface LanguageClientOptions {
   /** The workspace root, a URI, which is also the one workspace folder. */
   readonly rootUri: string;
   /** The folder's name, the root's last path segment by default. */
   readonly workspaceName?: string;
   /** The reading user's language, which only the page knows. Absent means the framework's English. */
   readonly locale?: Locale;
   /**
    * The client's capabilities, `workspace.applyEdit` and
    * `workspace.configuration` by default. `configuration` gates its request:
    * absent, the server asks for no section ever. `applyEdit` does not: the
    * server sends `workspace/applyEdit` to any client with the document open,
    * and a client with no handler answers it as an unknown method, which loses
    * the whole inbound direction. Declaring less than the handlers the host
    * registers is the one safe direction; declaring more produces answers it
    * cannot render.
    */
   readonly capabilities?: ClientCapabilities;
   /** Answered from the start, since the server reads it while the workspace comes up. */
   readonly configuration?: LanguageClientConfiguration;
   /** The server's log, every head of it; a page with no handler loses it. Registered before `listen`, so the first build's lines arrive too. */
   readonly onLogMessage?: (params: LogMessageParams) => void;
   /**
    * Called with the server's answer before `initialized` is sent: the window
    * in which a handler for the server's first notifications is registered
    * once the answer it needs is known. The server publishes nothing before
    * `initialized`, so nothing is missed.
    */
   readonly beforeInitialized?: (result: InitializeResult) => void;
}

/** The capabilities the server's inbound requests rely on, declared unless the host declares its own. */
const DEFAULT_CAPABILITIES: ClientCapabilities = { workspace: { applyEdit: true, configuration: true } };

/**
 * Run the page's end of the LSP handshake on `connection`, which must not be
 * listening yet, and resolve with the server's answer.
 *
 * Registers the answers to the server's own requests before `listen`, because
 * each is asked while the workspace comes up and an unanswered one is a
 * failure the page sees as an error and the server as a client with no
 * settings: capability registrations are acknowledged and kept nowhere, and a
 * configuration request is answered item by item, since the response is
 * positional and a dropped item mis-aligns every later answer. These
 * registrations replace any the host made before the call, since a
 * connection keeps one handler per method; a host serving more than one
 * section registers its own configuration handler in `beforeInitialized`.
 */
export async function initializeLanguageClient(connection: MessageConnection, options: LanguageClientOptions): Promise<InitializeResult> {
   // Before `listen`: a root that is no URI throws here, and a connection left
   // listening with no `initialize` sent would be one the host cannot reuse.
   const workspaceName = options.workspaceName ?? workspaceNameOf(options.rootUri);
   connection.onRequest(RegistrationRequest.type, () => undefined);
   connection.onRequest(UnregistrationRequest.type, () => undefined);
   const configuration = options.configuration;
   connection.onRequest(ConfigurationRequest.type, params =>
      params.items.map(item => (configuration !== undefined && item.section === configuration.section ? configuration.settings() : null))
   );
   if (options.onLogMessage) {
      connection.onNotification(LogMessageNotification.type, options.onLogMessage);
   }
   connection.listen();

   // By method name: these types come from `vscode-languageserver-protocol`'s
   // copy of `vscode-jsonrpc`, which need not be the connection's.
   const sender = sendByMethodName(connection);
   const result = await sender.sendRequest(InitializeRequest.type, {
      processId: null,
      rootUri: options.rootUri,
      locale: options.locale,
      capabilities: options.capabilities ?? DEFAULT_CAPABILITIES,
      workspaceFolders: [{ uri: options.rootUri, name: workspaceName }]
   });
   options.beforeInitialized?.(result);
   await sender.sendNotification(InitializedNotification.type, {});
   return result;
}

/** The root's last path segment, decoded, or the root itself for one with no path. */
function workspaceNameOf(rootUri: string): string {
   return decodeURIComponent(new URL(rootUri).pathname.replace(/\/+$/, '').split('/').pop() ?? '') || rootUri;
}
