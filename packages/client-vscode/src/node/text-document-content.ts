/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import type { CancellationToken, TextDocument, TextDocumentChangeEvent, TextDocumentWillSaveEvent, TextEdit, Uri } from 'vscode';

const CONTENT_REQUEST = { method: 'workspace/textDocumentContent' };

/**
 * A language client middleware that answers no text for a document the server
 * holds no more, where the client's own provider throws on the server's null
 * answer. VS Code then opens no such document, and a view already open keeps
 * its last text.
 *
 * `client` is read on each request, since the middleware goes into the options
 * the client is built from. A failed request goes through the client's own
 * failure handling, as the client's provider does.
 */
export function textDocumentContentMiddleware(
   client: () => {
      readonly code2ProtocolConverter: { asUri(uri: Uri): string };
      sendRequest<R>(method: string, params: unknown, token: CancellationToken): Promise<R>;
      handleFailedRequest<T>(type: { method: string }, token: CancellationToken, error: unknown, defaultValue: T): T;
   }
): { provideTextDocumentContent(uri: Uri, token: CancellationToken): Promise<string | undefined> } {
   return {
      provideTextDocumentContent: (uri, token) => {
         const current = client();
         const params = { uri: current.code2ProtocolConverter.asUri(uri) };
         return current.sendRequest<{ text: string } | null>(CONTENT_REQUEST.method, params, token).then(
            result => (token.isCancellationRequested ? undefined : result?.text),
            (error: unknown) => current.handleFailedRequest(CONTENT_REQUEST, token, error, undefined)
         );
      }
   };
}

/**
 * Keeps documents supplied by a content provider out of language-client sync.
 * Include their schemes in the document selector to enable language features;
 * the server owns their text, so none of their sync hooks may call through.
 * A language change can close a document whose open was suppressed, and a
 * content refresh changes its editor buffer. Forwarding these hooks would
 * give the server a language-client holder or echo its own text back to it.
 * Read the initialization result on each hook so a restarted client uses the
 * content schemes advertised by its current server.
 */
export function textDocumentSyncMiddleware(
   client: () => {
      readonly initializeResult?: {
         readonly capabilities: {
            readonly workspace?: { readonly textDocumentContent?: { readonly schemes: readonly string[] } };
         };
      };
   }
): {
   didOpen(document: TextDocument, next: (document: TextDocument) => Promise<void>): Promise<void>;
   didChange(event: TextDocumentChangeEvent, next: (event: TextDocumentChangeEvent) => Promise<void>): Promise<void>;
   didClose(document: TextDocument, next: (document: TextDocument) => Promise<void>): Promise<void>;
   didSave(document: TextDocument, next: (document: TextDocument) => Promise<void>): Promise<void>;
   willSave(event: TextDocumentWillSaveEvent, next: (event: TextDocumentWillSaveEvent) => Promise<void>): Promise<void>;
   willSaveWaitUntil(
      event: TextDocumentWillSaveEvent,
      next: (event: TextDocumentWillSaveEvent) => Thenable<TextEdit[]>
   ): Thenable<TextEdit[]>;
} {
   const skip = (document: TextDocument): boolean =>
      client().initializeResult?.capabilities.workspace?.textDocumentContent?.schemes.includes(document.uri.scheme) ?? false;
   return {
      didOpen: (document, next) => (skip(document) ? Promise.resolve() : next(document)),
      didChange: (event, next) => (skip(event.document) ? Promise.resolve() : next(event)),
      didClose: (document, next) => (skip(document) ? Promise.resolve() : next(document)),
      didSave: (document, next) => (skip(document) ? Promise.resolve() : next(document)),
      willSave: (event, next) => (skip(event.document) ? Promise.resolve() : next(event)),
      willSaveWaitUntil: (event, next) => (skip(event.document) ? Promise.resolve([]) : next(event))
   };
}
