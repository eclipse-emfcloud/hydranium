/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

// Internal to the package: its index does not re-export this module.

import { DocumentState, URI } from '@hydranium/langium';
import { type LangiumSharedServices } from '@hydranium/langium/lsp';
import { type Connection } from 'vscode-languageserver';
import { isClientGoneError } from '../util/connection-liveness.js';

/**
 * Ask the client to request a content document again once a build has parsed
 * an update of it, or once it is deleted, so one it shows does not go stale.
 * An update need not change the text, and the client compares. Langium
 * answers the content request but sends no refresh. Only a client that
 * declared `workspace.textDocumentContent` is asked.
 */
export function refreshContentDocuments(connection: Connection, services: LangiumSharedServices): void {
   const schemes = services.lsp.TextDocumentContentProvider?.schemes;
   if (!schemes || schemes.length === 0) {
      return;
   }
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
            sendRefresh(connection, uri.toString());
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
            sendRefresh(connection, uri);
         }
      }
   });
}

function sendRefresh(connection: Connection, uri: string): void {
   try {
      // A client that refused or left has nothing to request again.
      connection.workspace.textDocumentContent.refresh(uri).catch(() => undefined);
   } catch (error: unknown) {
      // A closed connection throws before it has a promise, and a throw here fails the build.
      if (!isClientGoneError(error)) {
         throw error;
      }
   }
}
