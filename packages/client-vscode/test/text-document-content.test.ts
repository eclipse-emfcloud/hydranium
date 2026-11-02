/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import type { CancellationToken, TextDocument, TextDocumentChangeEvent, TextDocumentWillSaveEvent, TextEdit, Uri } from 'vscode';
import { describe, expect, it } from 'vitest';
import { textDocumentContentMiddleware, textDocumentSyncMiddleware } from '../src/node/text-document-content';

const token: CancellationToken = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => undefined }) };
const uri = { toString: () => 'virtual:lib/a.one' } as Uri;

function middlewareAnswering(
   answer: { text: string } | null | Error,
   asked: unknown[] = []
): ReturnType<typeof textDocumentContentMiddleware> {
   const client = {
      code2ProtocolConverter: { asUri: (value: Uri) => value.toString() },
      sendRequest: <R>(method: string, params: unknown) => {
         asked.push({ method, params });
         return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer as R);
      },
      // As the client's own does for a cancelled request: the default value.
      handleFailedRequest: <T>(type: { method: string }, _token: CancellationToken, error: unknown, defaultValue: T) => {
         asked.push({ failed: type.method, error });
         return defaultValue;
      }
   };
   return textDocumentContentMiddleware(() => client);
}

describe('textDocumentContentMiddleware', () => {
   it('shows the text the server sends for the document', async () => {
      const asked: unknown[] = [];

      const text = await middlewareAnswering({ text: 'lib' }, asked).provideTextDocumentContent(uri, token);

      expect({ text, asked }).toEqual({
         text: 'lib',
         asked: [{ method: 'workspace/textDocumentContent', params: { uri: 'virtual:lib/a.one' } }]
      });
   });

   it('shows no text for a document the server holds no more, where the client would throw', async () => {
      await expect(middlewareAnswering(null).provideTextDocumentContent(uri, token)).resolves.toBeUndefined();
   });

   it('shows no text for a request cancelled while the server answered, as the client does', async () => {
      const cancelled: CancellationToken = { ...token, isCancellationRequested: true };

      await expect(middlewareAnswering({ text: 'lib' }).provideTextDocumentContent(uri, cancelled)).resolves.toBeUndefined();
   });

   it("hands a failed request to the client's own failure handling, as the client's provider does", async () => {
      const asked: unknown[] = [];
      const error = new Error('cancelled');

      const text = await middlewareAnswering(error, asked).provideTextDocumentContent(uri, token);

      expect({ text, failed: asked[1] }).toEqual({ text: undefined, failed: { failed: 'workspace/textDocumentContent', error } });
   });
});

describe('textDocumentSyncMiddleware', () => {
   it.each(['virtual', 'library', 'file'])('filters sync for configured content schemes with %s', async scheme => {
      const middleware = textDocumentSyncMiddleware(() => ({
         initializeResult: { capabilities: { workspace: { textDocumentContent: { schemes: ['virtual', 'library'] } } } }
      }));
      const document = { uri: { scheme } } as TextDocument;
      const change = { document } as TextDocumentChangeEvent;
      const save = { document } as TextDocumentWillSaveEvent;
      const calls: unknown[] = [];
      const next = async (value: unknown): Promise<void> => {
         calls.push(value);
      };
      await middleware.didOpen(document, next);
      await middleware.didChange(change, next);
      await middleware.didClose(document, next);
      await middleware.didSave(document, next);
      await middleware.willSave(save, next);
      const forwardedEdits = [{ newText: 'saved' } as TextEdit];
      const edits = await middleware.willSaveWaitUntil(save, async event => {
         calls.push(event);
         return forwardedEdits;
      });
      expect(edits).toEqual(scheme === 'file' ? forwardedEdits : []);
      expect(calls).toEqual(scheme === 'file' ? [document, change, document, document, save, save] : []);
   });
   it('reads current capabilities after initialization and restart', async () => {
      let schemes: string[] | undefined;
      const middleware = textDocumentSyncMiddleware(() => ({
         initializeResult: schemes ? { capabilities: { workspace: { textDocumentContent: { schemes } } } } : undefined
      }));
      const document = { uri: { scheme: 'library' } } as TextDocument;
      let sent = 0;
      const next = async (): Promise<void> => {
         sent++;
      };
      await middleware.didOpen(document, next);
      expect(sent).toBe(1);
      schemes = ['library'];
      await middleware.didOpen(document, next);
      expect(sent).toBe(1);
      schemes = ['other'];
      await middleware.didOpen(document, next);
      expect(sent).toBe(2);
   });
});
