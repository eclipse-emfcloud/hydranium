/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { type URI } from '@hydranium/langium';
import { type LangiumSharedServices } from '@hydranium/langium/lsp';
import {
   type Connection,
   type Disposable,
   type HandlerResult,
   LSPErrorCodes,
   ResponseError,
   type WorkspaceEdit
} from 'vscode-languageserver';
import { LANGUAGE_CLIENT_ID } from '../documents/client-ids.js';
import { HydraniumTextDocuments } from '../documents/hydranium-text-documents.js';
import { type ServerSharedServicesMinimal } from '../langium/shared-services.js';

const wrappedConnections = new WeakSet<object>();

type Register<P, A extends unknown[], R, E> = (handler: (params: P, ...rest: A) => HandlerResult<R, E>) => Disposable;

/**
 * Refuse with `ContentModified` a request whose answer edits documents, when
 * the editor of the request's document is behind the store as it arrives, or
 * when a document the answer edits changed while it was computed, by another
 * client, by a rebuild of a closed document or by its release, or its editor
 * is then behind.
 *
 * The editor applies the edits by position to the text it holds, and sent the
 * request's position in it, so an answer computed on other text rewrites the
 * wrong characters. The check runs on the answer, since the documents a rename
 * or code action edits are only known there, and on the connection, so an
 * adopter's provider for these requests is covered. Edits that arrive by a
 * resolve request, a file operation, `willSaveWaitUntil`, an inlay hint or a
 * command's `workspace/applyEdit` are not.
 *
 * Read-only answers are not refused, since a refusal would blank them. An
 * editor ahead of the store does not exist, as its changes reach the store
 * before any request it sends after them.
 */
export function guardEditRequests(connection: Connection, services: LangiumSharedServices): void {
   const store = services.workspace.TextDocuments;
   if (wrappedConnections.has(connection) || !(store instanceof HydraniumTextDocuments)) {
      return;
   }
   wrappedConnections.add(connection);
   // A Hydranium store implies the Hydranium shared services.
   const keyOf = (uri: URI | string): string =>
      (services as LangiumSharedServices & ServerSharedServicesMinimal).workspace.DocumentUriPolicy.canonicalUri(uri);
   const versions = (): ReadonlyMap<string, number> => new Map(store.all().map(document => [document.uri, document.version]));
   // A closed document records no author per version, so a rebuild of it
   // while an answer is computed is what refuses the answer. A release clears
   // the authors, so a reopen would attribute another client's change to the
   // editor, and refuses it as well.
   const watching = new Set<{ readonly rebuilt: Set<string>; readonly released: Set<string> }>();
   services.workspace.DocumentBuilder.onUpdate((changed, deleted) => {
      if (watching.size === 0) {
         return;
      }
      const keys = [...changed, ...deleted].map(keyOf);
      for (const watched of watching) {
         keys.forEach(key => watched.rebuilt.add(key));
      }
   });
   store.onDidReleaseDocument(event => {
      for (const watched of watching) {
         watched.released.add(event.uri);
      }
   });
   // The editor's own changes are not counted: it discards or re-filters an
   // answer that predates them, and counting them would blank completion
   // while the user types.
   const changedByAnother = (uri: string, from: number | undefined, to: number): boolean => {
      if (from === undefined) {
         return true;
      }
      for (let version = from + 1; version <= to; version++) {
         if (store.getAuthor(uri, version) !== LANGUAGE_CLIENT_ID) {
            return true;
         }
      }
      return false;
   };
   const refused = <E>(): ResponseError<E> =>
      new ResponseError<E>(LSPErrorCodes.ContentModified, 'The editor does not hold the text the answer was computed on');
   // The request's position is in the editor's text, which an answer
   // computed on the store's would be applied past.
   const behind = (uri: string): boolean => store.isLanguageClientBehind(uri, store.version(uri));
   /** Watches the documents an answer may edit while it is computed; dispose it after. */
   const watch = (): { changed(uris: Iterable<string>): boolean; dispose(): void } => {
      const computedOn = versions();
      const watched = { rebuilt: new Set<string>(), released: new Set<string>() };
      watching.add(watched);
      return {
         changed: uris =>
            [...new Set(uris)].some(uri => {
               const document = store.get(uri);
               const key = keyOf(uri);
               const changed =
                  watched.released.has(key) ||
                  (document === undefined
                     ? watched.rebuilt.has(key)
                     : changedByAnother(uri, computedOn.get(document.uri), document.version));
               return changed || behind(uri);
            }),
         dispose: () => watching.delete(watched)
      };
   };
   const guard =
      <P extends { readonly textDocument: { readonly uri: string } }, A extends unknown[], R, E>(
         register: Register<P, A, R, E>,
         edited: (result: R | null | undefined | void) => Iterable<string> = () => []
      ): Register<P, A, R, E> =>
      handler =>
         register(async (params, ...rest) => {
            const uri = params.textDocument.uri;
            if (behind(uri)) {
               return refused<E>();
            }
            const answer = watch();
            try {
               const result = await handler(params, ...rest);
               return result instanceof ResponseError || !answer.changed([uri, ...edited(result)]) ? result : refused<E>();
            } finally {
               answer.dispose();
            }
         });

   connection.onCompletion = guard(connection.onCompletion.bind(connection));
   connection.onDocumentFormatting = guard(connection.onDocumentFormatting.bind(connection));
   connection.onDocumentRangeFormatting = guard(connection.onDocumentRangeFormatting.bind(connection));
   connection.onDocumentOnTypeFormatting = guard(connection.onDocumentOnTypeFormatting.bind(connection));
   connection.onRenameRequest = guard(connection.onRenameRequest.bind(connection), editedUris);
   connection.onCodeAction = guard(connection.onCodeAction.bind(connection), actions =>
      (actions ?? []).flatMap(action => ('edit' in action && action.edit ? [...editedUris(action.edit)] : []))
   );
}

function* editedUris(edit: WorkspaceEdit | null | undefined | void): Iterable<string> {
   yield* Object.keys(edit?.changes ?? {});
   for (const change of edit?.documentChanges ?? []) {
      if ('textDocument' in change) {
         yield change.textDocument.uri;
      }
   }
}
