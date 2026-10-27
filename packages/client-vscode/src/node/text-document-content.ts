/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import type { CancellationToken, Uri } from 'vscode';

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
