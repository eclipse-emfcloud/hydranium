/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { isResponseError, type SaveTextDocumentParams, SaveTextDocumentRequest } from '@hydranium/protocol';
import {
   combineWorkspaceFeatures,
   type Connection,
   type Disposable,
   type Features,
   ResponseError,
   type ServerCapabilities,
   type WorkspaceFeature
} from 'vscode-languageserver';
import { LANGUAGE_CLIENT_ID } from '../documents/client-ids.js';
import type { ServerSharedServices } from '../langium/module.js';

/**
 * Advertise {@link SaveTextDocumentRequest} in the `initialize` answer, as
 * `experimental[SaveTextDocumentRequest.method]`, LSP's place for a server
 * feature it does not define. Supply it where the connection is created, with
 * {@link listenToSaveTextDocument} on that connection: only a host whose files
 * the server holds answers the request, and a client takes the entry as the
 * promise that it does.
 */
export function withSaveTextDocumentCapability<T extends Features>(features: T): T {
   const advertise: WorkspaceFeature<object> = Base =>
      class extends Base {
         override fillServerCapabilities(capabilities: ServerCapabilities): void {
            super.fillServerCapabilities(capabilities);
            capabilities.experimental = { ...capabilities.experimental, [SaveTextDocumentRequest.method]: true };
         }
      };
   return { ...features, workspace: features.workspace ? combineWorkspaceFeatures(features.workspace, advertise) : advertise };
}

/**
 * Answer {@link SaveTextDocumentRequest} on `connection`: persist the store's
 * text once `TextDocuments.assertLanguageClientHolds` finds the editor's
 * buffer holds it. The gate and the manager's taking of the text are one
 * synchronous step, so no change can land between them.
 *
 * A refusal crosses the wire as the data head's do, its message rendered by
 * `MessageRenderer` and rebuilt on the connection's copy of `vscode-jsonrpc`,
 * which keeps the code only of its own copy's errors.
 */
export function listenToSaveTextDocument(connection: Connection, shared: ServerSharedServices): Disposable {
   return connection.onRequest(SaveTextDocumentRequest.method, async (params: SaveTextDocumentParams) => {
      const { uri, version } = params.textDocument;
      try {
         shared.workspace.TextDocuments.assertLanguageClientHolds(uri, version);
         await shared.workspace.AstDocumentManager.save(uri, LANGUAGE_CLIENT_ID);
      } catch (error: unknown) {
         throw isResponseError(error) ? new ResponseError(error.code, shared.MessageRenderer.renderError(error), error.data) : error;
      }
      return null;
   });
}
