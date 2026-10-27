/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { DocumentState, URI } from '@hydranium/langium';
import { type LangiumSharedServices } from '@hydranium/langium/lsp';
import { describeErrorWithStack, type Logger } from '@hydranium/protocol';
import { type Connection } from 'vscode-languageserver';
import { type ServerSharedServicesMinimal } from '../langium/shared-services.js';
import { isClientGoneError } from '../util/connection-liveness.js';

/**
 * Ask the client to request a content document again once a build has parsed
 * an update of it, or once it is deleted, so one it shows does not go stale.
 * An update need not change the text, and the client compares. Langium
 * answers the content request but sends no refresh. Only a client that
 * declared `workspace.textDocumentContent` is asked. A refresh the client
 * fails is logged, since its editor keeps the old text and neither side
 * reports it otherwise. `startLanguageServer` calls it, so call it only for a
 * start composed by hand.
 */
export function refreshContentDocuments(
   connection: Connection,
   services: LangiumSharedServices & Partial<Pick<ServerSharedServicesMinimal, 'Logger'>>
): void {
   const schemes = services.lsp.TextDocumentContentProvider?.schemes;
   if (!schemes || schemes.length === 0) {
      return;
   }
   // Every Hydranium composition fills the slot. Langium's own has none.
   const logger = services.Logger?.for('ContentRefresh');
   let supported = false;
   services.lsp.LanguageServer.onInitialize(params => {
      supported = params.capabilities.workspace?.textDocumentContent !== undefined;
   });
   // Kept until a build has parsed them, which a cancelled or other build may not have.
   const changed = new Set<string>();
   services.workspace.DocumentBuilder.onUpdate((uris, deleted) => {
      if (supported) {
         uris.filter(uri => schemes.includes(uri.scheme)).forEach(uri => changed.add(uri.toString()));
         // No build parses a deleted one, and the client's request finds it gone.
         for (const uri of deleted.filter(uri => schemes.includes(uri.scheme))) {
            changed.delete(uri.toString());
            sendRefresh(connection, logger, uri.toString());
         }
      }
   });
   services.workspace.DocumentBuilder.onBuildPhase(DocumentState.Parsed, () => {
      for (const uri of changed) {
         const document = services.workspace.LangiumDocuments.getDocument(URI.parse(uri));
         if (document !== undefined && document.state < DocumentState.Parsed) {
            continue;
         }
         changed.delete(uri);
         if (document !== undefined) {
            sendRefresh(connection, logger, uri);
         }
      }
   });
}

function sendRefresh(connection: Connection, logger: Logger | undefined, uri: string): void {
   try {
      connection.workspace.textDocumentContent.refresh(uri).catch((error: unknown) => {
         // A client that left has nothing to request again.
         if (!isClientGoneError(error)) {
            logger?.error(`The client failed to refresh ${uri} and may show its old text. ${describeErrorWithStack(error)}`);
         }
      });
   } catch (error: unknown) {
      // A closed connection throws before it has a promise, and a throw here fails the build.
      if (!isClientGoneError(error)) {
         throw error;
      }
   }
}
