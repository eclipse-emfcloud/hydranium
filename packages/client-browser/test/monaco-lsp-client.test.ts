/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * The Monaco LSP client against a server-shaped far end over a port pair,
 * headless, over a double of Monaco's model store: what reaches the server
 * for each buffer change, what the client answers when the server writes,
 * and what it tells Monaco.
 */

import {
   CONFLICT_ERROR_CODE,
   createMessagePortTransport,
   isConflictError,
   NoopLogger,
   type SaveTextDocumentParams,
   SaveTextDocumentRequest
} from '@hydranium/protocol';
import { waitFor } from '@hydranium/protocol/testing';
import type * as monaco from 'monaco-editor-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
   type CancellationToken,
   CancellationTokenSource,
   ConnectionErrors,
   createMessageConnection,
   type MessageConnection
} from 'vscode-jsonrpc/browser';
import {
   ApplyWorkspaceEditRequest,
   type ApplyWorkspaceEditResult,
   type CompletionItem,
   CompletionItemKind,
   CompletionItemTag,
   CompletionRequest,
   CompletionTriggerKind,
   DefinitionRequest,
   DiagnosticSeverity,
   DiagnosticTag,
   DidChangeTextDocumentNotification,
   type DidChangeTextDocumentParams,
   DidCloseTextDocumentNotification,
   type DidCloseTextDocumentParams,
   DidOpenTextDocumentNotification,
   type DidOpenTextDocumentParams,
   DocumentHighlightKind,
   DocumentHighlightRequest,
   ErrorCodes,
   type Hover,
   HoverRequest,
   InsertTextFormat,
   InsertTextMode,
   LSPErrorCodes,
   type Location,
   type LocationLink,
   PublishDiagnosticsNotification,
   ResponseError,
   SemanticTokensRequest,
   type ServerCapabilities,
   type TextDocumentContentParams,
   TextDocumentContentRefreshRequest,
   TextDocumentContentRequest,
   type WorkspaceEdit
} from 'vscode-languageserver-protocol';
import { MONACO_CLIENT_CAPABILITIES, MonacoLspClient } from '../src/monaco';
import { anotherCopyConnection } from './another-copy-connection.js';
import * as monacoDouble from './monaco-editor-core-double.js';

vi.mock('monaco-editor-core', () => import('./monaco-editor-core-double.js'));

const toDispose: { dispose(): void }[] = [];

afterEach(() => {
   for (const disposable of toDispose.reverse()) {
      disposable.dispose();
   }
   toDispose.length = 0;
   // Monaco reports a dispose listener's throw instead of rethrowing it, so a
   // test would pass over one unless it is checked here.
   expect(monacoDouble.unexpectedErrors).toEqual([]);
});

beforeEach(() => {
   monacoDouble.reset();
});

const LANGUAGES: monaco.languages.ILanguageExtensionPoint[] = [
   { id: 'type-one', extensions: ['.one'] },
   { id: 'type-two', extensions: ['.two', '.second'] }
];

const CAPABILITIES: ServerCapabilities = {
   completionProvider: { triggerCharacters: ['.'] },
   semanticTokensProvider: { legend: { tokenTypes: ['class', 'property'], tokenModifiers: [] } }
};

interface Ends {
   readonly page: MessageConnection;
   readonly server: MessageConnection;
   readonly opens: DidOpenTextDocumentParams[];
   readonly changes: DidChangeTextDocumentParams[];
   readonly closes: DidCloseTextDocumentParams[];
   /** Resolves once every notification sent before it has been handled: one port delivers in order. */
   flush(): Promise<void>;
}

/** The page's connection and the server's, over one port pair; the server listens and records the document notifications. */
function makeEnds(): Ends {
   const channel = new MessageChannel();
   const pageTransport = createMessagePortTransport(channel.port1);
   const serverTransport = createMessagePortTransport(channel.port2);
   const page = createMessageConnection(pageTransport.reader, pageTransport.writer, new NoopLogger());
   const server = createMessageConnection(serverTransport.reader, serverTransport.writer, new NoopLogger());
   toDispose.push(page, server);
   const opens: DidOpenTextDocumentParams[] = [];
   const changes: DidChangeTextDocumentParams[] = [];
   const closes: DidCloseTextDocumentParams[] = [];
   server.onNotification(DidOpenTextDocumentNotification.type, params => {
      opens.push(params);
   });
   server.onNotification(DidChangeTextDocumentNotification.type, params => {
      changes.push(params);
   });
   server.onNotification(DidCloseTextDocumentNotification.type, params => {
      closes.push(params);
   });
   server.onRequest('flush', () => null);
   server.listen();
   page.listen();
   return { page, server, opens, changes, closes, flush: async () => void (await page.sendRequest('flush')) };
}

function makeClient(ends: Ends, options: Partial<ConstructorParameters<typeof MonacoLspClient>[2]> = {}): MonacoLspClient {
   const client = new MonacoLspClient(ends.page, CAPABILITIES, { languages: LANGUAGES, ...options });
   toDispose.push(client);
   return client;
}

/** A client whose server holds the text of `virtual:` documents. */
function makeContentClient(ends: Ends): MonacoLspClient {
   const client = new MonacoLspClient(
      ends.page,
      { workspace: { textDocumentContent: { schemes: ['virtual'] } } },
      { languages: LANGUAGES, clientCapabilities: MONACO_CLIENT_CAPABILITIES }
   );
   toDispose.push(client);
   return client;
}

function modelOf(uri: string): monacoDouble.TextModelDouble {
   const model = monacoDouble.models.get(uri);
   if (model === undefined) {
      throw new Error(`no model for ${uri}`);
   }
   return model;
}

function providerOf<T>(kind: string, languageId: string): T {
   const entry = monacoDouble.providers.find(candidate => candidate.kind === kind && candidate.languageId === languageId);
   if (entry === undefined) {
      throw new Error(`no ${kind} provider for ${languageId}`);
   }
   return entry.provider as T;
}

/** A Monaco position by its two numbers; the providers take the class, and read only these. */
const position = (lineNumber: number, column: number): monaco.Position => ({ lineNumber, column }) as monaco.Position;

const range = (startLine: number, startColumn: number, endLine: number, endColumn: number): monaco.IRange => ({
   startLineNumber: startLine,
   startColumn,
   endLineNumber: endLine,
   endColumn
});

/** What Monaco recognises as a cancellation and drops without reporting it. */
const MONACO_CANCELLATION = { name: 'Canceled', message: 'Canceled' };

/** Every provider's answer for `model` at its start, settled. */
function askEveryProvider(model: monaco.editor.ITextModel): Promise<PromiseSettledResult<unknown>[]> {
   const token = {} as monaco.CancellationToken;
   return Promise.allSettled([
      providerOf<monaco.languages.DocumentSemanticTokensProvider>('semanticTokens', 'type-one').provideDocumentSemanticTokens(
         model,
         null,
         token
      ),
      providerOf<monaco.languages.CompletionItemProvider>('completion', 'type-one').provideCompletionItems(
         model,
         position(1, 1),
         {} as monaco.languages.CompletionContext,
         token
      ),
      providerOf<monaco.languages.HoverProvider>('hover', 'type-one').provideHover(model, position(1, 1), token),
      providerOf<monaco.languages.DefinitionProvider>('definition', 'type-one').provideDefinition(model, position(1, 1), token),
      providerOf<monaco.languages.DocumentHighlightProvider>('documentHighlight', 'type-one').provideDocumentHighlights(
         model,
         position(1, 1),
         token
      )
   ]);
}

/** A settled answer as its rejection's name and message, or `'fulfilled'`. */
function reasonOf(result: PromiseSettledResult<unknown>): { name: unknown; message: unknown } | 'fulfilled' {
   if (result.status === 'fulfilled') {
      return 'fulfilled';
   }
   const reason: unknown = result.reason;
   return reason instanceof Error ? { name: reason.name, message: reason.message } : { name: undefined, message: reason };
}

describe('MonacoLspClient', () => {
   describe('opening', () => {
      it('registers every language with Monaco and sends didOpen with the id its extension names', async () => {
         const ends = makeEnds();
         const client = makeClient(ends);

         const model = client.openDocument('file:///a.second', 'one two');
         await ends.flush();

         expect(monacoDouble.registeredLanguages).toEqual(LANGUAGES);
         expect(model.getLanguageId()).toBe('type-two');
         expect(ends.opens).toEqual([{ textDocument: { uri: 'file:///a.second', languageId: 'type-two', version: 1, text: 'one two' } }]);
      });

      it('opens a URI once, so a second open returns the model and sends no second didOpen', async () => {
         const ends = makeEnds();
         const client = makeClient(ends);

         const first = client.openDocument('file:///a.one', 'one');
         modelOf('file:///a.one').edit([{ range: range(1, 4, 1, 4), text: ' more' }]);
         const second = client.openDocument('file:///a.one', 'stale snapshot');
         await ends.flush();

         expect(second).toBe(first);
         expect(ends.opens).toHaveLength(1);
         expect(second.getValue()).toBe('one more');
      });

      it("sends Monaco's form of the URI, so a provider request names the document didOpen opened", async () => {
         const ends = makeEnds();
         const client = makeClient(ends);

         const model = client.openDocument('file:///w/my file.one', 'one');
         modelOf(model.uri.toString()).edit([{ range: range(1, 1, 1, 1), text: 'x' }]);
         await ends.flush();

         expect(model.uri.toString()).toBe('file:///w/my%20file.one');
         expect(ends.opens.map(open => open.textDocument.uri)).toEqual(['file:///w/my%20file.one']);
         expect(ends.changes.map(change => change.textDocument.uri)).toEqual(['file:///w/my%20file.one']);
         expect(client.dirtyDocuments().map(document => document.uri)).toEqual(['file:///w/my%20file.one']);

         client.closeDocument('file:///w/my file.one');
         await ends.flush();
         expect(ends.closes.map(close => close.textDocument.uri)).toEqual(['file:///w/my%20file.one']);
      });

      it("sends the model's text, so a BOM or mixed line endings do not split the buffer from the server", async () => {
         const ends = makeEnds();
         const client = makeClient(ends);

         const model = client.openDocument('file:///a.one', '\uFEFFa\r\nb\nc');
         await ends.flush();

         expect(model.getValue()).toBe('a\nb\nc');
         expect(ends.opens.map(open => open.textDocument.text)).toEqual(['a\nb\nc']);
      });

      it('refuses a model this client did not open, with nothing sent', async () => {
         const ends = makeEnds();
         const client = makeClient(ends);
         monacoDouble.editor.createModel('theirs', 'type-one', monacoDouble.Uri.parse('file:///a.one'));

         expect(() => client.openDocument('file:///a.one', 'one')).toThrow(/file:\/\/\/a\.one/);
         await ends.flush();

         expect(ends.opens).toEqual([]);
         expect(modelOf('file:///a.one').getValue()).toBe('theirs');
      });

      it('closes on the server as the host disposes the model itself, and opens the URI afresh after', async () => {
         const ends = makeEnds();
         const client = makeClient(ends);
         client.openDocument('file:///a.one', 'one');
         modelOf('file:///a.one').dispose();
         await ends.flush();
         expect(ends.closes.map(close => close.textDocument.uri)).toEqual(['file:///a.one']);
         expect(client.dirtyDocuments()).toEqual([]);

         const reopened = client.openDocument('file:///a.one', 'two');
         modelOf('file:///a.one').edit([{ range: range(1, 1, 1, 1), text: 'x' }]);
         await ends.flush();

         expect(reopened.getValue()).toBe('xtwo');
         expect(ends.closes.map(close => close.textDocument.uri)).toEqual(['file:///a.one']);
         expect(ends.opens.map(open => open.textDocument.text)).toEqual(['one', 'two']);
         expect(ends.changes.map(change => change.textDocument.uri)).toEqual(['file:///a.one']);
      });

      it('refuses a model that replaced one the host disposed and closed', async () => {
         const ends = makeEnds();
         const client = makeClient(ends);
         client.openDocument('file:///a.one', 'one');
         modelOf('file:///a.one').dispose();
         monacoDouble.editor.createModel('theirs', 'type-one', monacoDouble.Uri.parse('file:///a.one'));

         expect(() => client.openDocument('file:///a.one', 'two')).toThrow(/file:\/\/\/a\.one/);
         await ends.flush();

         expect(ends.closes.map(close => close.textDocument.uri)).toEqual(['file:///a.one']);
         expect(ends.opens).toHaveLength(1);
         expect(client.dirtyDocuments()).toEqual([]);
      });

      it('routes a URI with a query or a fragment by the extension of its path', async () => {
         const ends = makeEnds();
         const client = makeClient(ends);

         const queried = client.openDocument('file:///a.one?revision=2', 'one');
         const fragment = client.openDocument('file:///b.two#top', 'two');
         await ends.flush();

         expect(queried.getLanguageId()).toBe('type-one');
         expect(fragment.getLanguageId()).toBe('type-two');
         expect(ends.opens.map(open => open.textDocument.languageId)).toEqual(['type-one', 'type-two']);
      });

      it("refuses a URI no language's extensions name, with nothing sent", async () => {
         const ends = makeEnds();
         const client = makeClient(ends);

         expect(() => client.openDocument('file:///a.three', 'x')).toThrow(/file:\/\/\/a\.three/);
         await ends.flush();

         expect(ends.opens).toEqual([]);
         expect(monacoDouble.models.size).toBe(0);
      });

      it('sends each content change as a didChange with 0-based ranges, back to front', async () => {
         const ends = makeEnds();
         const client = makeClient(ends);
         client.openDocument('file:///a.one', 'ab\ncd');

         modelOf('file:///a.one').edit([
            { range: range(1, 2, 1, 2), text: 'X' },
            { range: range(2, 3, 2, 3), text: 'Y' }
         ]);
         await ends.flush();

         expect(ends.changes).toEqual([
            {
               textDocument: { uri: 'file:///a.one', version: 2 },
               contentChanges: [
                  { range: { start: { line: 1, character: 2 }, end: { line: 1, character: 2 } }, rangeLength: 0, text: 'Y' },
                  { range: { start: { line: 0, character: 1 }, end: { line: 0, character: 1 } }, rangeLength: 0, text: 'X' }
               ]
            }
         ]);
      });
   });

   describe('closing', () => {
      it('sends didClose, disposes the model and lets the URI open again', async () => {
         const ends = makeEnds();
         const client = makeClient(ends);
         const model = modelOf(client.openDocument('file:///a.one', 'one').uri.toString());
         model.edit([{ range: range(1, 1, 1, 1), text: 'x' }]);

         client.closeDocument('file:///a.one');
         await ends.flush();

         expect(ends.closes).toEqual([{ textDocument: { uri: 'file:///a.one' } }]);
         expect(model.disposed).toBe(true);
         expect(client.dirtyDocuments()).toEqual([]);

         client.openDocument('file:///a.one', 'again');
         await ends.flush();
         expect(ends.opens.map(open => open.textDocument.text)).toEqual(['one', 'again']);
      });

      it('clears the markers it set, so a reopened document does not start with stale squiggles', () => {
         const ends = makeEnds();
         const client = makeClient(ends);
         client.openDocument('file:///a.one', 'one');
         client.applyDiagnostics({
            uri: 'file:///a.one',
            diagnostics: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, message: 'm' }]
         });

         client.closeDocument('file:///a.one');

         expect(monacoDouble.markers.get('lsp file:///a.one')).toEqual([]);
      });

      it('clears the markers of a model the host disposed itself, which Monaco keeps for a file URI', () => {
         const ends = makeEnds();
         const client = makeClient(ends);
         client.openDocument('file:///a.one', 'one');
         client.applyDiagnostics({
            uri: 'file:///a.one',
            diagnostics: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, message: 'm' }]
         });
         modelOf('file:///a.one').dispose();

         expect(monacoDouble.markers.get('lsp file:///a.one')).toEqual([]);
      });

      it('closes a URI that is not open without sending anything', async () => {
         const ends = makeEnds();
         const client = makeClient(ends);

         client.closeDocument('file:///a.one');
         await ends.flush();

         expect(ends.closes).toEqual([]);
      });

      it('dispose closes every open document and disposes every registration', async () => {
         const ends = makeEnds();
         const client = makeClient(ends);
         client.openDocument('file:///a.one', 'one');
         client.openDocument('file:///b.two', 'two');
         client.registerEditorOpener(() => true);
         expect(monacoDouble.providers.length).toBeGreaterThan(0);
         expect(monacoDouble.openers).toHaveLength(1);

         client.dispose();
         await ends.flush();

         expect(ends.closes.map(close => close.textDocument.uri)).toEqual(['file:///a.one', 'file:///b.two']);
         expect(monacoDouble.models.size).toBe(0);
         expect(monacoDouble.providers).toEqual([]);
         expect(monacoDouble.openers).toEqual([]);
      });

      it('refuses to open a document once disposed, sending nothing and creating no model', async () => {
         const ends = makeEnds();
         const client = makeClient(ends);
         client.dispose();

         expect(() => client.openDocument('file:///a.one', 'one')).toThrow('Cannot open file:///a.one: the client is disposed');
         await ends.flush();

         expect({ opens: ends.opens, models: monacoDouble.models.size }).toEqual({ opens: [], models: 0 });
      });

      it('dispose on a connection already closed still disposes every model and registration', () => {
         const ends = makeEnds();
         const client = makeClient(ends);
         client.openDocument('file:///a.one', 'one');
         client.openDocument('file:///b.two', 'two');
         client.registerEditorOpener(() => true);
         ends.page.dispose();

         expect(() => client.dispose()).not.toThrow();

         expect(monacoDouble.models.size).toBe(0);
         expect(monacoDouble.providers).toEqual([]);
         expect(monacoDouble.openers).toEqual([]);
         expect(client.dirtyDocuments()).toEqual([]);
      });

      it('dispose after the connection of another vscode-jsonrpc copy closed still releases everything', () => {
         // Another copy's ConnectionError is a different class with the same code.
         const foreign = Object.assign(new Error('Connection is closed.'), { code: ConnectionErrors.Closed });
         let closed = false;
         const stub: Partial<MessageConnection> = {
            onRequest: () => ({ dispose: (): void => undefined }),
            sendNotification: (): Promise<void> => {
               if (closed) {
                  throw foreign;
               }
               return Promise.resolve();
            }
         };
         const connection = stub as MessageConnection;
         const client = new MonacoLspClient(connection, CAPABILITIES, { languages: LANGUAGES });
         client.openDocument('file:///a.one', 'one');
         client.openDocument('file:///b.two', 'two');
         client.registerEditorOpener(() => true);
         closed = true;

         expect(() => client.dispose()).not.toThrow();

         expect(monacoDouble.models.size).toBe(0);
         expect(monacoDouble.openers).toEqual([]);
      });

      it('answers workspace/applyEdit as an unknown method after dispose', async () => {
         const ends = makeEnds();
         const client = makeClient(ends);
         client.dispose();

         const answer = ends.server.sendRequest(ApplyWorkspaceEditRequest.type, { edit: {} });

         await expect(answer).rejects.toMatchObject({ code: ErrorCodes.MethodNotFound });
      });
   });

   describe('connection', () => {
      it('syncs and asks over a connection of another vscode-jsonrpc copy, sending by method name', async () => {
         const ends = makeEnds();
         ends.server.onRequest(HoverRequest.type, () => ({ contents: 'hovered' }));
         const client = new MonacoLspClient(anotherCopyConnection(ends.page), CAPABILITIES, { languages: LANGUAGES });
         toDispose.push(client);

         const model = client.openDocument('file:///a.one', 'one');
         modelOf('file:///a.one').edit([{ range: range(1, 1, 1, 1), text: 'x' }]);
         const hover = await providerOf<monaco.languages.HoverProvider>('hover', 'type-one').provideHover(
            model,
            position(1, 1),
            {} as monaco.CancellationToken
         );
         client.closeDocument('file:///a.one');
         await ends.flush();

         expect(hover?.contents).toEqual([{ value: 'hovered' }]);
         expect(ends.opens.map(open => open.textDocument.text)).toEqual(['one']);
         expect(ends.changes.map(change => change.textDocument.version)).toEqual([2]);
         expect(ends.closes.map(close => close.textDocument.uri)).toEqual(['file:///a.one']);
      });

      it('reads, writes and marks nothing on a model the host disposed itself', async () => {
         const ends = makeEnds();
         const client = makeClient(ends);
         client.openDocument('file:///a.one', 'one');
         modelOf('file:///a.one').edit([{ range: range(1, 1, 1, 1), text: 'x' }]);
         modelOf('file:///a.one').dispose();

         const dirty = client.dirtyDocuments();
         const answer = await ends.server.sendRequest(ApplyWorkspaceEditRequest.type, {
            edit: {
               changes: { 'file:///a.one': [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, newText: 'y' }] }
            }
         });
         client.applyDiagnostics({
            uri: 'file:///a.one',
            diagnostics: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, message: 'late' }]
         });

         expect(dirty).toEqual([]);
         expect(answer).toEqual({ applied: false, failureReason: 'No editor open for file:///a.one' });
         expect(monacoDouble.markers.get('lsp file:///a.one')).toEqual([]);
      });

      it('opens a document once the connection is closed, and keeps its buffer tracked', () => {
         const ends = makeEnds();
         const client = makeClient(ends);
         ends.page.dispose();

         expect(() => client.openDocument('file:///a.one', 'one')).not.toThrow();
         modelOf('file:///a.one').edit([{ range: range(1, 1, 1, 1), text: 'x' }]);

         expect(client.dirtyDocuments().map(document => document.text)).toEqual(['xone']);
      });

      it('registers nothing when construction fails on a closed connection', () => {
         const ends = makeEnds();
         ends.page.dispose();

         expect(() => new MonacoLspClient(ends.page, CAPABILITIES, { languages: LANGUAGES })).toThrow();

         expect(monacoDouble.providers).toEqual([]);
      });

      it('keeps the buffer editable and dirty once the connection is closed', () => {
         const ends = makeEnds();
         const client = makeClient(ends);
         client.openDocument('file:///a.one', 'one');
         ends.page.dispose();

         expect(() => modelOf('file:///a.one').edit([{ range: range(1, 1, 1, 1), text: 'x' }])).not.toThrow();

         expect(client.dirtyDocuments().map(document => document.text)).toEqual(['xone']);
      });

      it('leaves no rejection unhandled when a notification fails to write', async () => {
         const unhandled: unknown[] = [];
         const record = (reason: unknown): void => {
            unhandled.push(reason);
         };
         process.on('unhandledRejection', record);
         try {
            const stub: Partial<MessageConnection> = {
               onRequest: () => ({ dispose: (): void => undefined }),
               sendNotification: (): Promise<void> => Promise.reject(new Error('write failed'))
            };
            const client = new MonacoLspClient(stub as MessageConnection, CAPABILITIES, { languages: LANGUAGES });
            client.openDocument('file:///a.one', 'one');
            modelOf('file:///a.one').edit([{ range: range(1, 1, 1, 1), text: 'x' }]);
            client.closeDocument('file:///a.one');
            client.dispose();
            await new Promise(resolve => setTimeout(resolve, 0));

            expect(unhandled).toEqual([]);
         } finally {
            process.off('unhandledRejection', record);
         }
      });
   });

   describe('workspace/applyEdit', () => {
      const edit = (uri: string, version: number | null, newText: string, at = range(1, 1, 1, 1)): WorkspaceEdit => ({
         documentChanges: [
            {
               textDocument: { uri, version },
               edits: [
                  {
                     range: {
                        start: { line: at.startLineNumber - 1, character: at.startColumn - 1 },
                        end: { line: at.endLineNumber - 1, character: at.endColumn - 1 }
                     },
                     newText
                  }
               ]
            }
         ]
      });

      async function apply(ends: Ends, workspaceEdit: WorkspaceEdit): Promise<ApplyWorkspaceEditResult> {
         return ends.server.sendRequest(ApplyWorkspaceEditRequest.type, { edit: workspaceEdit });
      }

      it('applies a versioned edit as one undoable operation and echoes it as didChange', async () => {
         const ends = makeEnds();
         const client = makeClient(ends);
         client.openDocument('file:///a.one', 'one');

         const result = await apply(ends, edit('file:///a.one', 1, 'X', range(1, 2, 1, 3)));
         await ends.flush();

         expect(result).toEqual({ applied: true });
         const model = modelOf('file:///a.one');
         expect(model.getValue()).toBe('oXe');
         expect(model.pushed).toEqual([[{ range: range(1, 2, 1, 3), text: 'X' }]]);
         expect(ends.changes).toEqual([
            {
               textDocument: { uri: 'file:///a.one', version: 2 },
               contentChanges: [{ range: { start: { line: 0, character: 1 }, end: { line: 0, character: 2 } }, rangeLength: 1, text: 'X' }]
            }
         ]);
      });

      it('closes the undo element before and after a server edit, so it never joins the typing around it', async () => {
         const ends = makeEnds();
         const client = makeClient(ends);
         client.openDocument('file:///a.one', 'one');

         await apply(ends, edit('file:///a.one', 1, 'X', range(1, 2, 1, 3)));

         expect(modelOf('file:///a.one').stackCalls).toEqual(['pushStackElement', 'pushEditOperations', 'pushStackElement']);
      });

      it('refuses an edit addressed at a version the buffer has outrun, naming both', async () => {
         const ends = makeEnds();
         const client = makeClient(ends);
         client.openDocument('file:///a.one', 'one');
         modelOf('file:///a.one').edit([{ range: range(1, 1, 1, 1), text: 'x' }]);

         const result = await apply(ends, edit('file:///a.one', 1, 'X'));

         expect(result).toEqual({ applied: false, failureReason: 'Stale edit for file:///a.one: addressed at version 1, buffer is at 2' });
         expect(modelOf('file:///a.one').getValue()).toBe('xone');
      });

      it('refuses an edit for a URI no model holds', async () => {
         const ends = makeEnds();
         makeClient(ends);

         const result = await apply(ends, edit('file:///a.one', null, 'X'));

         expect(result).toEqual({ applied: false, failureReason: 'No editor open for file:///a.one' });
      });

      it('refuses an edit for a model another client holds', async () => {
         const ends = makeEnds();
         makeClient(ends);
         monacoDouble.editor.createModel('theirs', 'type-one', monacoDouble.Uri.parse('file:///a.one'));

         const result = await apply(ends, edit('file:///a.one', null, 'X'));

         expect(result).toEqual({ applied: false, failureReason: 'No editor open for file:///a.one' });
         expect(modelOf('file:///a.one').getValue()).toBe('theirs');
      });

      it('refuses a resource operation by its kind', async () => {
         const ends = makeEnds();
         makeClient(ends);

         const result = await apply(ends, { documentChanges: [{ kind: 'create', uri: 'file:///b.one' }] });

         expect(result).toEqual({ applied: false, failureReason: 'Resource operations are not supported by this client: create' });
      });

      it('refuses a snippet edit', async () => {
         const ends = makeEnds();
         const client = makeClient(ends);
         client.openDocument('file:///a.one', 'one');

         const result = await apply(ends, {
            documentChanges: [
               {
                  textDocument: { uri: 'file:///a.one', version: 1 },
                  edits: [
                     {
                        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
                        snippet: { kind: 'snippet', value: '$1' }
                     }
                  ]
               }
            ]
         });

         expect(result).toEqual({ applied: false, failureReason: 'Snippet edits are not supported by this client: file:///a.one' });
         expect(modelOf('file:///a.one').getValue()).toBe('one');
      });

      it('applies the changes map form, which carries no version', async () => {
         const ends = makeEnds();
         const client = makeClient(ends);
         client.openDocument('file:///a.one', 'one');
         modelOf('file:///a.one').edit([{ range: range(1, 1, 1, 1), text: 'x' }]);

         const result = await apply(ends, {
            changes: { 'file:///a.one': [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, newText: 'X' }] }
         });

         expect(result).toEqual({ applied: true });
         expect(modelOf('file:///a.one').getValue()).toBe('Xone');
      });

      it('applies documentChanges alone when an edit carries both forms', async () => {
         const ends = makeEnds();
         const client = makeClient(ends);
         client.openDocument('file:///a.one', 'one');

         const result = await apply(ends, {
            ...edit('file:///a.one', 1, 'X'),
            changes: { 'file:///a.one': [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, newText: 'Y' }] }
         });

         expect(result).toEqual({ applied: true });
         expect(modelOf('file:///a.one').getValue()).toBe('Xone');
         expect(modelOf('file:///a.one').pushed).toHaveLength(1);
      });

      it('applies nothing when one document of several is refused', async () => {
         const ends = makeEnds();
         const client = makeClient(ends);
         client.openDocument('file:///a.one', 'one');

         const result = await apply(ends, {
            documentChanges: [...edit('file:///a.one', 1, 'X').documentChanges!, ...edit('file:///missing.one', null, 'Y').documentChanges!]
         });

         expect(result).toEqual({ applied: false, failureReason: 'No editor open for file:///missing.one' });
         expect(modelOf('file:///a.one').getValue()).toBe('one');
         expect(modelOf('file:///a.one').pushed).toEqual([]);
      });

      it.each([
         ['at the same version', 1],
         ['at the version after the first', 2]
      ])('refuses an edit naming one document twice, %s, in either URI form', async (_name, secondVersion) => {
         const ends = makeEnds();
         const client = makeClient(ends);
         client.openDocument('file:///w/my file.one', 'one');

         const result = await apply(ends, {
            documentChanges: [
               ...edit('file:///w/my file.one', 1, 'X').documentChanges!,
               ...edit('file:///w/my%20file.one', secondVersion, 'Y', range(1, 2, 1, 2)).documentChanges!
            ]
         });

         expect(result).toEqual({
            applied: false,
            failureReason: 'An edit names file:///w/my%20file.one more than once'
         });
         expect(modelOf('file:///w/my%20file.one').pushed).toEqual([]);
      });
   });

   describe('diagnostics', () => {
      it('sets markers under the owner with 1-based ranges, and an absent severity as an error', () => {
         const ends = makeEnds();
         const client = makeClient(ends);
         client.openDocument('file:///a.one', 'one');

         client.applyDiagnostics({
            uri: 'file:///a.one',
            diagnostics: [
               {
                  range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
                  message: 'plain',
                  severity: DiagnosticSeverity.Warning,
                  code: 7
               },
               { range: { start: { line: 1, character: 1 }, end: { line: 1, character: 2 } }, message: { kind: 'markdown', value: 'rich' } }
            ]
         });

         expect(monacoDouble.markers.get('lsp file:///a.one')).toEqual([
            { ...range(1, 1, 1, 4), message: 'plain', severity: monacoDouble.MarkerSeverity.Warning, source: undefined, code: '7' },
            { ...range(2, 2, 2, 3), message: 'rich', severity: monacoDouble.MarkerSeverity.Error, source: undefined, code: undefined }
         ]);
      });

      it('forwards the unnecessary and deprecated tags and the related locations', () => {
         const ends = makeEnds();
         const client = makeClient(ends);
         client.openDocument('file:///a.one', 'one');

         client.applyDiagnostics({
            uri: 'file:///a.one',
            diagnostics: [
               {
                  range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
                  message: 'unused',
                  tags: [DiagnosticTag.Unnecessary, DiagnosticTag.Deprecated],
                  relatedInformation: [
                     {
                        location: { uri: 'file:///b.two', range: { start: { line: 1, character: 2 }, end: { line: 1, character: 5 } } },
                        message: 'declared here'
                     }
                  ]
               }
            ]
         });

         expect(monacoDouble.markers.get('lsp file:///a.one')).toEqual([
            {
               ...range(1, 1, 1, 4),
               message: 'unused',
               severity: monacoDouble.MarkerSeverity.Error,
               source: undefined,
               code: undefined,
               tags: [monacoDouble.MarkerTag.Unnecessary, monacoDouble.MarkerTag.Deprecated],
               relatedInformation: [{ resource: monacoDouble.Uri.parse('file:///b.two'), message: 'declared here', ...range(2, 3, 2, 6) }]
            }
         ]);
      });

      it('makes a code with a description a link to it', () => {
         const ends = makeEnds();
         const client = makeClient(ends);
         client.openDocument('file:///a.one', 'one');

         client.applyDiagnostics({
            uri: 'file:///a.one',
            diagnostics: [
               {
                  range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
                  message: 'linked',
                  code: 'E1',
                  codeDescription: { href: 'https://example.org/E1' }
               }
            ]
         });

         expect(monacoDouble.markers.get('lsp file:///a.one')?.[0]?.code).toEqual({
            value: 'E1',
            target: monacoDouble.Uri.parse('https://example.org/E1')
         });
      });

      it('ignores a model another client holds', () => {
         const ends = makeEnds();
         const client = makeClient(ends);
         monacoDouble.editor.createModel('theirs', 'type-one', monacoDouble.Uri.parse('file:///a.one'));

         client.applyDiagnostics({ uri: 'file:///a.one', diagnostics: [] });

         expect(monacoDouble.markers.size).toBe(0);
      });

      it('ignores a URI with no model', () => {
         const ends = makeEnds();
         const client = makeClient(ends);

         client.applyDiagnostics({ uri: 'file:///a.one', diagnostics: [] });

         expect(monacoDouble.markers.size).toBe(0);
      });

      it('takes the marker owner from the options', () => {
         const ends = makeEnds();
         const client = makeClient(ends, { markerOwner: 'mine' });
         client.openDocument('file:///a.one', 'one');

         client.applyDiagnostics({ uri: 'file:///a.one', diagnostics: [] });

         expect([...monacoDouble.markers.keys()]).toEqual(['mine file:///a.one']);
      });

      it('does not subscribe to publishDiagnostics itself, so the host fans out from one handler', async () => {
         const ends = makeEnds();
         const seen: string[] = [];
         ends.page.onNotification(PublishDiagnosticsNotification.type, params => {
            seen.push(params.uri);
         });
         makeClient(ends);

         await ends.server.sendNotification(PublishDiagnosticsNotification.type, { uri: 'file:///a.one', diagnostics: [] });
         await ends.flush();

         expect(seen).toEqual(['file:///a.one']);
      });
   });

   describe('dirty documents', () => {
      it('lists a document whose buffer moved, with the text and the version it was read at', () => {
         const ends = makeEnds();
         const client = makeClient(ends);
         client.openDocument('file:///a.one', 'one');
         client.openDocument('file:///b.two', 'two');
         modelOf('file:///a.one').edit([{ range: range(1, 4, 1, 4), text: '!' }]);

         expect(client.dirtyDocuments()).toEqual([{ uri: 'file:///a.one', text: 'one!', version: 2, model: modelOf('file:///a.one') }]);
      });

      it('reads one document by its URI in either form, and nothing for one that is saved or not open', () => {
         const ends = makeEnds();
         const client = makeClient(ends);
         client.openDocument('file:///w/my file.one', 'one');
         client.openDocument('file:///b.two', 'two');
         modelOf('file:///w/my%20file.one').edit([{ range: range(1, 4, 1, 4), text: '!' }]);

         expect(client.dirtyDocument('file:///w/my file.one')).toEqual({
            uri: 'file:///w/my%20file.one',
            text: 'one!',
            version: 2,
            model: modelOf('file:///w/my%20file.one')
         });
         expect(client.dirtyDocument('file:///b.two')).toBeUndefined();
         expect(client.dirtyDocument('file:///c.one')).toBeUndefined();
      });

      it('is not dirty on open, nor after an undo returns the buffer to its saved version', () => {
         const ends = makeEnds();
         const client = makeClient(ends);
         client.openDocument('file:///a.one', 'one');
         expect(client.dirtyDocuments()).toEqual([]);

         modelOf('file:///a.one').edit([{ range: range(1, 4, 1, 4), text: '!' }]);
         modelOf('file:///a.one').undo();

         expect(client.dirtyDocuments()).toEqual([]);
      });

      it('keeps a document dirty when markSaved names an older version than the buffer', () => {
         const ends = makeEnds();
         const client = makeClient(ends);
         client.openDocument('file:///a.one', 'one');
         modelOf('file:///a.one').edit([{ range: range(1, 4, 1, 4), text: '!' }]);
         const [read] = client.dirtyDocuments();
         modelOf('file:///a.one').edit([{ range: range(1, 5, 1, 5), text: '?' }]);

         client.markSaved(read!);

         expect(client.dirtyDocuments()).toEqual([{ uri: 'file:///a.one', text: 'one!?', version: 3, model: modelOf('file:///a.one') }]);
         client.markSaved(client.dirtyDocuments()[0]!);
         expect(client.dirtyDocuments()).toEqual([]);
      });

      it('ignores markSaved for a record of a model since closed, so a reopened document at the same version stays dirty', () => {
         const ends = makeEnds();
         const client = makeClient(ends);
         client.openDocument('file:///a.one', 'one');
         modelOf('file:///a.one').edit([{ range: range(1, 4, 1, 4), text: '!' }]);
         const [stale] = client.dirtyDocuments();
         client.closeDocument('file:///a.one');
         client.openDocument('file:///a.one', 'one');
         modelOf('file:///a.one').edit([{ range: range(1, 4, 1, 4), text: '?' }]);
         expect(client.dirtyDocuments()[0]!.version).toBe(stale!.version);

         client.markSaved(stale!);

         expect(client.dirtyDocuments().map(document => document.text)).toEqual(['one?']);
      });
   });

   describe('providers', () => {
      it("registers a semantic token provider per language only with the server's legend, answering a Uint32Array", async () => {
         const ends = makeEnds();
         ends.server.onRequest(SemanticTokensRequest.type, () => ({ data: [0, 0, 3, 0, 0], resultId: 'r1' }));
         const client = makeClient(ends);
         const model = client.openDocument('file:///a.one', 'one');
         const provider = providerOf<monaco.languages.DocumentSemanticTokensProvider>('semanticTokens', 'type-one');
         providerOf<monaco.languages.DocumentSemanticTokensProvider>('semanticTokens', 'type-two');

         const tokens = await provider.provideDocumentSemanticTokens(model, null, {} as monaco.CancellationToken);

         expect(provider.getLegend()).toEqual(CAPABILITIES.semanticTokensProvider!.legend);
         expect(tokens).toEqual({ data: new Uint32Array([0, 0, 3, 0, 0]), resultId: 'r1' });
         expect((tokens as monaco.languages.SemanticTokens).data).toBeInstanceOf(Uint32Array);
      });

      it('registers no semantic token provider without a legend', () => {
         const ends = makeEnds();
         const client = new MonacoLspClient(ends.page, {}, { languages: LANGUAGES });
         toDispose.push(client);

         expect(monacoDouble.providers.filter(entry => entry.kind === 'semanticTokens')).toEqual([]);
      });

      it('maps completion kinds by name, falls back to the typed word, and forwards both ranges of an insert-replace edit', async () => {
         const ends = makeEnds();
         const items: CompletionItem[] = [
            { label: 'Class', kind: CompletionItemKind.Class, detail: 'd', sortText: 's', filterText: 'f' },
            { label: 'plain' },
            {
               label: 'snip',
               insertTextFormat: InsertTextFormat.Snippet,
               textEdit: {
                  newText: 'sn$1',
                  insert: { start: { line: 0, character: 0 }, end: { line: 0, character: 2 } },
                  replace: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }
               },
               additionalTextEdits: [{ range: { start: { line: 1, character: 0 }, end: { line: 1, character: 0 } }, newText: 'import' }]
            }
         ];
         ends.server.onRequest(CompletionRequest.type, () => ({ isIncomplete: true, items }));
         const client = makeClient(ends);
         const model = client.openDocument('file:///a.one', 'ab.cd\n');
         const provider = providerOf<monaco.languages.CompletionItemProvider>('completion', 'type-one');

         const list = await provider.provideCompletionItems(
            model,
            position(1, 6),
            {} as monaco.languages.CompletionContext,
            {} as monaco.CancellationToken
         );

         expect(provider.triggerCharacters).toEqual(['.']);
         expect(list).toEqual({
            incomplete: true,
            suggestions: [
               {
                  label: 'Class',
                  kind: monacoDouble.languages.CompletionItemKind.Class,
                  insertText: 'Class',
                  insertTextRules: undefined,
                  range: range(1, 4, 1, 6),
                  detail: 'd',
                  documentation: undefined,
                  sortText: 's',
                  filterText: 'f',
                  additionalTextEdits: undefined
               },
               {
                  label: 'plain',
                  kind: monacoDouble.languages.CompletionItemKind.Text,
                  insertText: 'plain',
                  insertTextRules: undefined,
                  range: range(1, 4, 1, 6),
                  detail: undefined,
                  documentation: undefined,
                  sortText: undefined,
                  filterText: undefined,
                  additionalTextEdits: undefined
               },
               {
                  label: 'snip',
                  kind: monacoDouble.languages.CompletionItemKind.Text,
                  insertText: 'sn$1',
                  insertTextRules: monacoDouble.languages.CompletionItemInsertTextRule.InsertAsSnippet,
                  range: { insert: range(1, 1, 1, 3), replace: range(1, 1, 1, 4) },
                  detail: undefined,
                  documentation: undefined,
                  sortText: undefined,
                  filterText: undefined,
                  additionalTextEdits: [{ range: range(2, 1, 2, 1), text: 'import' }]
               }
            ]
         });
      });

      it('reads a definition as a location or a link, with 1-based ranges', async () => {
         const ends = makeEnds();
         const location: Location = { uri: 'file:///b.two', range: { start: { line: 1, character: 2 }, end: { line: 1, character: 5 } } };
         const link: LocationLink = {
            targetUri: 'file:///b.two',
            targetRange: { start: { line: 0, character: 0 }, end: { line: 3, character: 1 } },
            targetSelectionRange: { start: { line: 0, character: 7 }, end: { line: 0, character: 10 } },
            originSelectionRange: { start: { line: 4, character: 4 }, end: { line: 4, character: 7 } }
         };
         let answer: Location | LocationLink[] = location;
         ends.server.onRequest(DefinitionRequest.type, () => answer);
         const client = makeClient(ends);
         const model = client.openDocument('file:///a.one', 'one');
         const provider = providerOf<monaco.languages.DefinitionProvider>('definition', 'type-one');
         const ask = (): Promise<monaco.languages.Definition | monaco.languages.LocationLink[] | null | undefined> =>
            Promise.resolve(provider.provideDefinition(model, position(1, 1), {} as monaco.CancellationToken));

         const fromLocation = await ask();
         answer = [link];
         const fromLink = await ask();

         expect(fromLocation).toEqual([{ uri: monacoDouble.Uri.parse('file:///b.two'), range: range(2, 3, 2, 6) }]);
         expect(fromLink).toEqual([
            {
               uri: monacoDouble.Uri.parse('file:///b.two'),
               range: range(1, 1, 4, 2),
               targetSelectionRange: range(1, 8, 1, 11),
               originSelectionRange: range(5, 5, 5, 8)
            }
         ]);
      });

      it('reads the text of a document the server holds, and asks only for its schemes', async () => {
         const ends = makeEnds();
         const asked: string[] = [];
         // By method, since the protocol's type has no null, which Langium sends for a document it does not hold.
         ends.server.onRequest(TextDocumentContentRequest.method, (params: TextDocumentContentParams) => {
            asked.push(params.uri);
            return params.uri.endsWith('gone.one') ? null : { text: 'lib' };
         });
         const client = new MonacoLspClient(
            ends.page,
            { workspace: { textDocumentContent: { schemes: ['virtual'] } } },
            { languages: LANGUAGES, clientCapabilities: MONACO_CLIENT_CAPABILITIES }
         );
         toDispose.push(client);

         const held = await client.requestDocumentContent('virtual:lib/a.one');
         const gone = await client.requestDocumentContent('virtual:lib/gone.one');
         const notHeld = await client.requestDocumentContent('file:///a.one');

         expect({ held, gone, notHeld, asked }).toEqual({
            held: 'lib',
            gone: null,
            notHeld: undefined,
            asked: ['virtual:lib/a.one', 'virtual:lib/gone.one']
         });
      });

      it('renders hover contents of every shape as markdown', async () => {
         const ends = makeEnds();
         let contents: Hover['contents'] = { kind: 'markdown', value: 'rich' };
         ends.server.onRequest(HoverRequest.type, () => ({
            contents,
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }
         }));
         const client = makeClient(ends);
         const model = client.openDocument('file:///a.one', 'one');
         const provider = providerOf<monaco.languages.HoverProvider>('hover', 'type-one');
         const ask = (): Promise<monaco.languages.Hover | null | undefined> =>
            Promise.resolve(provider.provideHover(model, position(1, 1), {} as monaco.CancellationToken));

         const markup = await ask();
         contents = ['plain', { language: 'type-one', value: 'code' }];
         const mixed = await ask();

         expect(markup).toEqual({ contents: [{ value: 'rich' }], range: range(1, 1, 1, 4) });
         expect(mixed).toEqual({ contents: [{ value: 'plain' }, { value: '```type-one\ncode\n```' }], range: range(1, 1, 1, 4) });
      });

      it("shows plaintext markup as text, escaped in a hover and as a plain string in a completion's documentation", async () => {
         const ends = makeEnds();
         ends.server.onRequest(HoverRequest.type, (): Hover => ({ contents: { kind: 'plaintext', value: 'a*b*c\n> List<T>' } }));
         ends.server.onRequest(CompletionRequest.type, (): CompletionItem[] => [
            { label: 'x', documentation: { kind: 'plaintext', value: 'a*b*c' } }
         ]);
         const client = makeClient(ends);
         const model = client.openDocument('file:///a.one', 'one');
         const hoverProvider = providerOf<monaco.languages.HoverProvider>('hover', 'type-one');
         const completionProvider = providerOf<monaco.languages.CompletionItemProvider>('completion', 'type-one');

         const hover = await hoverProvider.provideHover(model, position(1, 1), {} as monaco.CancellationToken);
         const list = await completionProvider.provideCompletionItems(
            model,
            position(1, 1),
            {} as monaco.languages.CompletionContext,
            {} as monaco.CancellationToken
         );

         expect(hover?.contents).toEqual([{ value: 'a\\*b\\*c\n\n\\>&nbsp;List<T\\>' }]);
         expect(list?.suggestions.map(suggestion => suggestion.documentation)).toEqual(['a*b*c']);
      });

      it('forwards the tags, preselect, commit characters, label details, command and insert mode Langium copies onto an item', async () => {
         const ends = makeEnds();
         const items: CompletionItem[] = [
            {
               label: 'old',
               labelDetails: { detail: '(x)', description: 'Bar' },
               tags: [CompletionItemTag.Deprecated],
               preselect: true,
               commitCharacters: ['.'],
               command: { title: 'Next', command: 'editor.action.triggerSuggest', arguments: [1] },
               insertText: 'a\n\tb$1',
               insertTextFormat: InsertTextFormat.Snippet,
               insertTextMode: InsertTextMode.asIs
            },
            { label: 'legacy', deprecated: true, insertTextMode: InsertTextMode.adjustIndentation }
         ];
         ends.server.onRequest(CompletionRequest.type, () => items);
         const client = makeClient(ends);
         const model = client.openDocument('file:///a.one', 'one');

         const list = await providerOf<monaco.languages.CompletionItemProvider>('completion', 'type-one').provideCompletionItems(
            model,
            position(1, 1),
            {} as monaco.languages.CompletionContext,
            {} as monaco.CancellationToken
         );

         const rules = monacoDouble.languages.CompletionItemInsertTextRule;
         expect(list?.suggestions[0]).toMatchObject({
            label: { label: 'old', detail: '(x)', description: 'Bar' },
            tags: [monacoDouble.languages.CompletionItemTag.Deprecated],
            preselect: true,
            commitCharacters: ['.'],
            command: { id: 'editor.action.triggerSuggest', title: 'Next', arguments: [1] },
            insertTextRules: rules.InsertAsSnippet | rules.KeepWhitespace
         });
         expect(list?.suggestions[1]).toMatchObject({
            label: 'legacy',
            tags: [monacoDouble.languages.CompletionItemTag.Deprecated],
            insertTextRules: undefined
         });
      });

      it("names the document in Monaco's URI form and the position 0-based in every provider request", async () => {
         const ends = makeEnds();
         const asked: Record<string, unknown> = {};
         const record =
            (kind: string) =>
            (params: { textDocument: { uri: string }; position?: unknown }): null => {
               asked[kind] = { uri: params.textDocument.uri, position: params.position };
               return null;
            };
         ends.server.onRequest(SemanticTokensRequest.type, record('semanticTokens'));
         ends.server.onRequest(CompletionRequest.type, record('completion'));
         ends.server.onRequest(HoverRequest.type, record('hover'));
         ends.server.onRequest(DefinitionRequest.type, record('definition'));
         ends.server.onRequest(DocumentHighlightRequest.type, record('documentHighlight'));
         const client = makeClient(ends);
         const model = client.openDocument('file:///w/my file.one', 'one\ntwo three');
         const token = {} as monaco.CancellationToken;

         await providerOf<monaco.languages.DocumentSemanticTokensProvider>('semanticTokens', 'type-one').provideDocumentSemanticTokens(
            model,
            null,
            token
         );
         await providerOf<monaco.languages.CompletionItemProvider>('completion', 'type-one').provideCompletionItems(
            model,
            position(2, 5),
            {} as monaco.languages.CompletionContext,
            token
         );
         await providerOf<monaco.languages.HoverProvider>('hover', 'type-one').provideHover(model, position(2, 5), token);
         await providerOf<monaco.languages.DefinitionProvider>('definition', 'type-one').provideDefinition(model, position(2, 5), token);
         await providerOf<monaco.languages.DocumentHighlightProvider>('documentHighlight', 'type-one').provideDocumentHighlights(
            model,
            position(2, 5),
            token
         );

         const at = { uri: 'file:///w/my%20file.one', position: { line: 1, character: 4 } };
         expect(asked).toEqual({
            semanticTokens: { uri: 'file:///w/my%20file.one', position: undefined },
            completion: at,
            hover: at,
            definition: at,
            documentHighlight: at
         });
      });

      it("sends the completion trigger in LSP's numbering, which starts at one where Monaco's starts at zero", async () => {
         const ends = makeEnds();
         const contexts: unknown[] = [];
         ends.server.onRequest(CompletionRequest.type, params => {
            contexts.push(params.context);
            return [];
         });
         const client = makeClient(ends);
         const model = client.openDocument('file:///a.one', 'one');
         const provider = providerOf<monaco.languages.CompletionItemProvider>('completion', 'type-one');
         const kinds = monacoDouble.languages.CompletionTriggerKind;

         for (const context of [
            { triggerKind: kinds.Invoke },
            { triggerKind: kinds.TriggerCharacter, triggerCharacter: '.' },
            { triggerKind: kinds.TriggerForIncompleteCompletions }
         ]) {
            await provider.provideCompletionItems(model, position(1, 1), context, {} as monaco.CancellationToken);
         }

         expect(contexts).toEqual([
            { triggerKind: CompletionTriggerKind.Invoked },
            { triggerKind: CompletionTriggerKind.TriggerCharacter, triggerCharacter: '.' },
            { triggerKind: CompletionTriggerKind.TriggerForIncompleteCompletions }
         ]);
      });

      it('maps document highlight kinds across the offset, an absent kind as text', async () => {
         const ends = makeEnds();
         ends.server.onRequest(DocumentHighlightRequest.type, () => [
            { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, kind: DocumentHighlightKind.Write },
            { range: { start: { line: 0, character: 2 }, end: { line: 0, character: 3 } } }
         ]);
         const client = makeClient(ends);
         const model = client.openDocument('file:///a.one', 'one');
         const provider = providerOf<monaco.languages.DocumentHighlightProvider>('documentHighlight', 'type-one');

         const highlights = await provider.provideDocumentHighlights(model, position(1, 1), {} as monaco.CancellationToken);

         expect(highlights).toEqual([
            { range: range(1, 1, 1, 2), kind: monacoDouble.languages.DocumentHighlightKind.Write },
            { range: range(1, 3, 1, 4), kind: monacoDouble.languages.DocumentHighlightKind.Text }
         ]);
      });
   });

   describe('ownership', () => {
      it('answers nothing for a model another client holds, and asks the server nothing', async () => {
         const ends = makeEnds();
         const asked: string[] = [];
         const record = (kind: string) => (): null => {
            asked.push(kind);
            return null;
         };
         ends.server.onRequest(SemanticTokensRequest.type, record('semanticTokens'));
         ends.server.onRequest(CompletionRequest.type, record('completion'));
         ends.server.onRequest(HoverRequest.type, record('hover'));
         ends.server.onRequest(DefinitionRequest.type, record('definition'));
         ends.server.onRequest(DocumentHighlightRequest.type, record('documentHighlight'));
         makeClient(ends);
         const theirs = monacoDouble.editor.createModel('theirs', 'type-one', monacoDouble.Uri.parse('file:///a.one'));
         const token = {} as monaco.CancellationToken;

         const answers = await Promise.all([
            providerOf<monaco.languages.DocumentSemanticTokensProvider>('semanticTokens', 'type-one').provideDocumentSemanticTokens(
               theirs,
               null,
               token
            ),
            providerOf<monaco.languages.CompletionItemProvider>('completion', 'type-one').provideCompletionItems(
               theirs,
               position(1, 1),
               {} as monaco.languages.CompletionContext,
               token
            ),
            providerOf<monaco.languages.HoverProvider>('hover', 'type-one').provideHover(theirs, position(1, 1), token),
            providerOf<monaco.languages.DefinitionProvider>('definition', 'type-one').provideDefinition(theirs, position(1, 1), token),
            providerOf<monaco.languages.DocumentHighlightProvider>('documentHighlight', 'type-one').provideDocumentHighlights(
               theirs,
               position(1, 1),
               token
            )
         ]);
         await ends.flush();

         expect(asked).toEqual([]);
         expect(answers).toEqual([null, { suggestions: [] }, null, null, null]);
      });

      it('answers for a content model, which the server never hears opened or closed', async () => {
         const ends = makeEnds();
         ends.server.onRequest(TextDocumentContentRequest.type, () => ({ text: 'lib' }));
         ends.server.onRequest(HoverRequest.type, () => ({ contents: 'served' }));
         const client = makeContentClient(ends);

         const model = await client.openContentDocument('virtual:lib/a.one');
         const hover = await providerOf<monaco.languages.HoverProvider>('hover', 'type-one').provideHover(
            model!,
            position(1, 1),
            {} as monaco.CancellationToken
         );
         const again = await client.openContentDocument('virtual:lib/a.one');
         const text = model?.getValue();
         const language = model?.getLanguageId();
         client.closeDocument('virtual:lib/a.one');
         await ends.flush();

         expect({ text, language, hover: hover?.contents, same: again === model, disposed: model?.isDisposed() }).toEqual({
            text: 'lib',
            language: 'type-one',
            hover: [{ value: 'served' }],
            same: true,
            disposed: true
         });
         expect({ opens: ends.opens, closes: ends.closes }).toEqual({ opens: [], closes: [] });
      });

      it('sends one request for opens of a content document that race, and creates no model once disposed', async () => {
         const ends = makeEnds();
         const answers: Array<() => void> = [];
         ends.server.onRequest(
            TextDocumentContentRequest.type,
            () => new Promise<{ text: string }>(resolve => answers.push(() => resolve({ text: 'lib' })))
         );
         const client = makeContentClient(ends);

         const first = client.openContentDocument('virtual:lib/a.one');
         const second = client.openContentDocument('virtual:lib/a.one');
         const late = client.openContentDocument('virtual:lib/b.one');
         await expect.poll(() => answers.length).toBe(2);
         answers[0]!();
         const raced = await Promise.all([first, second]);
         client.dispose();
         answers[1]!();

         expect({ same: raced[0] === raced[1], late: await late }).toEqual({ same: true, late: undefined });
         expect(monacoDouble.models.has('virtual:lib/b.one')).toBe(false);
      });

      it('opens nothing for a content document closed before the server answered', async () => {
         const ends = makeEnds();
         const answers: Array<() => void> = [];
         ends.server.onRequest(
            TextDocumentContentRequest.type,
            () => new Promise<{ text: string }>(resolve => answers.push(() => resolve({ text: 'lib' })))
         );
         const client = makeContentClient(ends);

         const closed = client.openContentDocument('virtual:lib/a.one');
         await expect.poll(() => answers.length).toBe(1);
         client.closeDocument('virtual:lib/a.one');
         answers[0]!();

         expect(await closed).toBeUndefined();
         expect(monacoDouble.models.has('virtual:lib/a.one')).toBe(false);
      });

      it('refuses to sync a document it holds as a content document, and the other way round, naming why', async () => {
         const ends = makeEnds();
         ends.server.onRequest(TextDocumentContentRequest.type, () => ({ text: 'lib' }));
         const client = makeContentClient(ends);
         await client.openContentDocument('virtual:lib/a.one');
         client.openDocument('virtual:lib/b.one', 'synced');

         expect(() => client.openDocument('virtual:lib/a.one', 'synced')).toThrow(
            'virtual:lib/a.one is open in this client as a content document'
         );
         await expect(client.openContentDocument('virtual:lib/b.one')).rejects.toThrow(
            'virtual:lib/b.one is open in this client as a document it syncs'
         );
      });

      it('marks a content document with what the server published before and while its model is open, until it closes', async () => {
         const ends = makeEnds();
         ends.server.onRequest(TextDocumentContentRequest.type, () => ({ text: 'lib' }));
         const client = makeContentClient(ends);
         const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } };
         const messages = (): string[] | undefined => monacoDouble.markers.get('lsp virtual:lib/a.one')?.map(marker => marker.message);

         client.applyDiagnostics({ uri: 'virtual:lib/a.one', diagnostics: [{ range, message: 'before' }] });
         await client.openContentDocument('virtual:lib/a.one');
         const beforeOpen = messages();
         client.applyDiagnostics({ uri: 'virtual:lib/a.one', diagnostics: [{ range, message: 'while' }] });
         const whileOpen = messages();
         client.closeDocument('virtual:lib/a.one');

         expect({ beforeOpen, whileOpen, closed: messages() }).toEqual({ beforeOpen: ['before'], whileOpen: ['while'], closed: [] });
      });

      it('keeps the diagnostics of a closed content document for a reopen on the same text only', async () => {
         const ends = makeEnds();
         let text = 'lib';
         ends.server.onRequest(TextDocumentContentRequest.type, () => ({ text }));
         const client = makeContentClient(ends);
         const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } };
         const messages = (): string[] | undefined => monacoDouble.markers.get('lsp virtual:lib/a.one')?.map(marker => marker.message);

         await client.openContentDocument('virtual:lib/a.one');
         client.applyDiagnostics({ uri: 'virtual:lib/a.one', diagnostics: [{ range, message: 'kept' }] });
         client.closeDocument('virtual:lib/a.one');
         await client.openContentDocument('virtual:lib/a.one');
         const sameText = messages();
         client.closeDocument('virtual:lib/a.one');
         text = 'changed';
         await client.openContentDocument('virtual:lib/a.one');

         expect({ sameText, changedText: messages() }).toEqual({ sameText: ['kept'], changedText: [] });
      });

      it('draws the diagnostics of a closed content document after a refresh only on the text they were for', async () => {
         const ends = makeEnds();
         let text = 'lib';
         ends.server.onRequest(TextDocumentContentRequest.type, () => ({ text }));
         const client = makeContentClient(ends);
         const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } };
         const messages = (): string[] | undefined => monacoDouble.markers.get('lsp virtual:lib/a.one')?.map(marker => marker.message);
         await client.openContentDocument('virtual:lib/a.one');
         client.applyDiagnostics({ uri: 'virtual:lib/a.one', diagnostics: [{ range, message: 'kept' }] });
         client.closeDocument('virtual:lib/a.one');
         text = 'changed';
         await client.openContentDocument('virtual:lib/a.one');

         text = 'newer';
         await ends.server.sendRequest(TextDocumentContentRefreshRequest.type, { uri: 'virtual:lib/a.one' });
         const otherText = messages();
         text = 'lib';
         await ends.server.sendRequest(TextDocumentContentRefreshRequest.type, { uri: 'virtual:lib/a.one' });

         expect({ otherText, sameText: messages() }).toEqual({ otherText: [], sameText: ['kept'] });
      });

      it('keeps the diagnostics published during a refresh for a reopen on the refreshed text', async () => {
         const ends = makeEnds();
         const answers: Array<(text: string) => void> = [];
         ends.server.onRequest(
            TextDocumentContentRequest.type,
            () => new Promise<{ text: string }>(resolve => answers.push(text => resolve({ text })))
         );
         const client = makeContentClient(ends);
         const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } };
         const opening = client.openContentDocument('virtual:lib/a.one');
         await expect.poll(() => answers.length).toBe(1);
         answers[0]!('lib');
         await opening;
         const refreshing = ends.server.sendRequest(TextDocumentContentRefreshRequest.type, { uri: 'virtual:lib/a.one' });
         await expect.poll(() => answers.length).toBe(2);

         client.applyDiagnostics({ uri: 'virtual:lib/a.one', diagnostics: [{ range, message: 'for the new text' }] });
         client.closeDocument('virtual:lib/a.one');
         answers[1]!('lib new');
         await refreshing;
         const reopening = client.openContentDocument('virtual:lib/a.one');
         await expect.poll(() => answers.length).toBe(3);
         answers[2]!('lib new');
         await reopening;

         expect(monacoDouble.markers.get('lsp virtual:lib/a.one')?.map(marker => marker.message)).toEqual(['for the new text']);
      });

      it('draws the diagnostics published for the refreshed text before it arrived, once the refresh puts it in the model', async () => {
         const ends = makeEnds();
         const answers: Array<(text: string) => void> = [];
         ends.server.onRequest(
            TextDocumentContentRequest.type,
            () => new Promise<{ text: string }>(resolve => answers.push(text => resolve({ text })))
         );
         const client = makeContentClient(ends);
         const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } };
         const opening = client.openContentDocument('virtual:lib/a.one');
         await expect.poll(() => answers.length).toBe(1);
         answers[0]!('lib');
         await opening;
         const refreshing = ends.server.sendRequest(TextDocumentContentRefreshRequest.type, { uri: 'virtual:lib/a.one' });
         await expect.poll(() => answers.length).toBe(2);

         client.applyDiagnostics({ uri: 'virtual:lib/a.one', diagnostics: [{ range, message: 'for the new text' }] });
         answers[1]!('lib new');
         await refreshing;

         const drawn = monacoDouble.models.get('virtual:lib/a.one')?.drawnMarkers.get('lsp');
         expect(drawn?.map(marker => marker.message)).toEqual(['for the new text']);
      });

      it('opens no content document for a host that passed no capabilities, since it may have declared none', async () => {
         const ends = makeEnds();
         const asked: string[] = [];
         ends.server.onRequest(TextDocumentContentRequest.type, params => {
            asked.push(params.uri);
            return { text: 'lib' };
         });
         const client = new MonacoLspClient(
            ends.page,
            { workspace: { textDocumentContent: { schemes: ['virtual'] } } },
            { languages: LANGUAGES }
         );
         toDispose.push(client);

         expect({ model: await client.openContentDocument('virtual:lib/a.one'), asked }).toEqual({ model: undefined, asked: [] });
      });

      it('opens no content document for a host that declared no content support, which the server would never refresh', async () => {
         const ends = makeEnds();
         const asked: string[] = [];
         ends.server.onRequest(TextDocumentContentRequest.type, params => {
            asked.push(params.uri);
            return { text: 'lib' };
         });
         const client = new MonacoLspClient(
            ends.page,
            { workspace: { textDocumentContent: { schemes: ['virtual'] } } },
            { languages: LANGUAGES, clientCapabilities: { workspace: { applyEdit: true } } }
         );
         toDispose.push(client);

         expect({ model: await client.openContentDocument('virtual:lib/a.one'), asked }).toEqual({ model: undefined, asked: [] });
      });

      it('closes a content document the server no longer holds, on its refresh', async () => {
         const ends = makeEnds();
         let deleted = false;
         ends.server.onRequest(TextDocumentContentRequest.method, () => (deleted ? null : { text: 'lib' }));
         const client = makeContentClient(ends);
         const model = await client.openContentDocument('virtual:lib/a.one');

         deleted = true;
         await ends.server.sendRequest(TextDocumentContentRefreshRequest.type, { uri: 'virtual:lib/a.one' });

         expect({ disposed: model?.isDisposed(), reopened: await client.openContentDocument('virtual:lib/a.one') }).toEqual({
            disposed: true,
            reopened: undefined
         });
      });

      it('drops the diagnostics of a content document closed after a failed refresh, for a reopen on changed text', async () => {
         const ends = makeEnds();
         let text: string | undefined = 'lib';
         ends.server.onRequest(TextDocumentContentRequest.type, () => {
            if (text === undefined) {
               throw new Error('no text');
            }
            return { text };
         });
         const client = makeContentClient(ends);
         const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } };
         await client.openContentDocument('virtual:lib/a.one');
         client.applyDiagnostics({ uri: 'virtual:lib/a.one', diagnostics: [{ range, message: 'for the old text' }] });
         text = undefined;
         await expect(ends.server.sendRequest(TextDocumentContentRefreshRequest.type, { uri: 'virtual:lib/a.one' })).rejects.toThrow(
            'no text'
         );

         client.closeDocument('virtual:lib/a.one');
         text = 'changed';
         await client.openContentDocument('virtual:lib/a.one');

         expect(monacoDouble.markers.get('lsp virtual:lib/a.one')?.map(marker => marker.message)).toEqual([]);
      });

      it.each([
         ['a BOM', '\uFEFFlib'],
         ['mixed line ends', 'a\r\nb\nc']
      ])('keeps the diagnostics of a content document whose text has %s for a reopen on the same text', async (_shape, text) => {
         const ends = makeEnds();
         ends.server.onRequest(TextDocumentContentRequest.type, () => ({ text }));
         const client = makeContentClient(ends);
         const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } };

         await client.openContentDocument('virtual:lib/a.one');
         client.applyDiagnostics({ uri: 'virtual:lib/a.one', diagnostics: [{ range, message: 'kept' }] });
         client.closeDocument('virtual:lib/a.one');
         await client.openContentDocument('virtual:lib/a.one');

         expect(monacoDouble.markers.get('lsp virtual:lib/a.one')?.map(marker => marker.message)).toEqual(['kept']);
      });

      it('keeps the diagnostics of a content document whose model the host disposed, for a reopen on the same text', async () => {
         const ends = makeEnds();
         ends.server.onRequest(TextDocumentContentRequest.type, () => ({ text: 'lib' }));
         const client = makeContentClient(ends);
         const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } };

         const model = await client.openContentDocument('virtual:lib/a.one');
         client.applyDiagnostics({ uri: 'virtual:lib/a.one', diagnostics: [{ range, message: 'kept' }] });
         model!.dispose();
         const afterDispose = monacoDouble.markers.get('lsp virtual:lib/a.one')?.map(marker => marker.message);
         client.closeDocument('virtual:lib/a.one');
         const reopened = await client.openContentDocument('virtual:lib/a.one');

         expect({
            afterDispose,
            fresh: reopened !== model,
            reopened: monacoDouble.markers.get('lsp virtual:lib/a.one')?.map(marker => marker.message)
         }).toEqual({ afterDispose: [], fresh: true, reopened: ['kept'] });
      });

      it('forgets the diagnostics it kept for content documents once disposed', async () => {
         class Exposed extends MonacoLspClient {
            get kept(): number {
               return this.contentDiagnostics.size;
            }
         }
         const ends = makeEnds();
         const client = new Exposed(
            ends.page,
            { workspace: { textDocumentContent: { schemes: ['virtual'] } } },
            { languages: LANGUAGES, clientCapabilities: MONACO_CLIENT_CAPABILITIES }
         );
         const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } };
         client.applyDiagnostics({ uri: 'virtual:lib/a.one', diagnostics: [{ range, message: 'kept' }] });
         const before = client.kept;

         client.dispose();

         expect({ before, after: client.kept }).toEqual({ before: 1, after: 0 });
      });

      it('keeps no diagnostics a content document gets once disposed', () => {
         class Exposed extends MonacoLspClient {
            get kept(): number {
               return this.contentDiagnostics.size;
            }
         }
         const ends = makeEnds();
         const client = new Exposed(
            ends.page,
            { workspace: { textDocumentContent: { schemes: ['virtual'] } } },
            { languages: LANGUAGES, clientCapabilities: MONACO_CLIENT_CAPABILITIES }
         );
         client.dispose();
         const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } };

         client.applyDiagnostics({ uri: 'virtual:lib/a.one', diagnostics: [{ range, message: 'late' }] });

         expect(client.kept).toBe(0);
      });

      it('puts the text the server holds after a refresh into the model, waiting for an open still under way', async () => {
         const ends = makeEnds();
         let text = 'first';
         const answers: Array<() => void> = [];
         ends.server.onRequest(
            TextDocumentContentRequest.type,
            () => new Promise<{ text: string }>(resolve => answers.push(() => resolve({ text })))
         );
         const client = makeContentClient(ends);

         const opening = client.openContentDocument('virtual:lib/a.one');
         await expect.poll(() => answers.length).toBe(1);
         text = 'second';
         const refreshing = ends.server.sendRequest(TextDocumentContentRefreshRequest.type, { uri: 'virtual:lib/a.one' });
         answers[0]!();
         const model = await opening;
         await expect.poll(() => answers.length).toBe(2);
         answers[1]!();
         await refreshing;

         expect(model?.getValue()).toBe('second');
      });

      it('leaves a content model alone on a refresh whose text has not changed, BOM and line ends included', async () => {
         const ends = makeEnds();
         ends.server.onRequest(TextDocumentContentRequest.type, () => ({ text: '﻿entity A\r\n' }));
         const client = makeContentClient(ends);
         const model = await client.openContentDocument('virtual:lib/a.one');
         const before = model?.getVersionId();

         await ends.server.sendRequest(TextDocumentContentRefreshRequest.type, { uri: 'virtual:lib/a.one' });

         expect(model?.getVersionId()).toBe(before);
      });

      it('keeps the text of a content document whose refresh fails, and answers the refresh with the failure', async () => {
         const ends = makeEnds();
         let fail = false;
         ends.server.onRequest(TextDocumentContentRequest.type, () => {
            if (fail) {
               throw new Error('no text');
            }
            return { text: 'lib' };
         });
         const client = makeContentClient(ends);
         const model = await client.openContentDocument('virtual:lib/a.one');
         fail = true;

         const refreshing = ends.server.sendRequest(TextDocumentContentRefreshRequest.type, { uri: 'virtual:lib/a.one' });

         await expect(refreshing).rejects.toThrow('no text');
         expect(model?.getValue()).toBe('lib');
      });

      it('leaves a content document closed while its refresh waits for the server', async () => {
         const ends = makeEnds();
         const answers: Array<() => void> = [];
         ends.server.onRequest(
            TextDocumentContentRequest.type,
            () => new Promise<{ text: string }>(resolve => answers.push(() => resolve({ text: `lib ${answers.length}` })))
         );
         const client = makeContentClient(ends);
         const opening = client.openContentDocument('virtual:lib/a.one');
         await expect.poll(() => answers.length).toBe(1);
         answers[0]!();
         const model = await opening;
         const refreshing = ends.server.sendRequest(TextDocumentContentRefreshRequest.type, { uri: 'virtual:lib/a.one' });
         await expect.poll(() => answers.length).toBe(2);

         client.closeDocument('virtual:lib/a.one');
         answers[1]!();

         await expect(refreshing).resolves.toBeNull();
         expect(model?.isDisposed()).toBe(true);
      });

      describe('with two refreshes under way', () => {
         interface Answer {
            readonly resolve: (text: string) => void;
            readonly reject: (error: Error) => void;
         }

         async function setUp(): Promise<{
            client: ReturnType<typeof makeContentClient>;
            answers: Answer[];
            model: monaco.editor.ITextModel | undefined;
            refresh: () => Promise<unknown>;
         }> {
            const ends = makeEnds();
            const answers: Answer[] = [];
            ends.server.onRequest(
               TextDocumentContentRequest.type,
               () => new Promise<{ text: string }>((resolve, reject) => answers.push({ resolve: text => resolve({ text }), reject }))
            );
            const client = makeContentClient(ends);
            const opening = client.openContentDocument('virtual:lib/a.one');
            await expect.poll(() => answers.length).toBe(1);
            answers[0]!.resolve('lib');
            const model = await opening;
            const refresh = (): Promise<unknown> =>
               ends.server.sendRequest(TextDocumentContentRefreshRequest.type, { uri: 'virtual:lib/a.one' });
            return { client, answers, model, refresh };
         }

         it('keeps the newer text when the older answer arrives last', async () => {
            const { answers, model, refresh } = await setUp();
            const older = refresh();
            await expect.poll(() => answers.length).toBe(2);
            const newer = refresh();
            await expect.poll(() => answers.length).toBe(3);

            answers[2]!.resolve('lib new');
            await newer;
            answers[1]!.resolve('lib old');
            await older;

            expect(model?.getValue()).toBe('lib new');
         });

         it('takes the older text when the newer request fails', async () => {
            const { answers, model, refresh } = await setUp();
            const older = refresh();
            await expect.poll(() => answers.length).toBe(2);
            const newer = refresh();
            await expect.poll(() => answers.length).toBe(3);

            answers[2]!.reject(new Error('no text'));
            await expect(newer).rejects.toThrow('no text');
            answers[1]!.resolve('lib old');
            await older;

            expect(model?.getValue()).toBe('lib old');
         });

         it('leaves a model reopened meanwhile to the answer of its own open', async () => {
            const { client, answers, refresh } = await setUp();
            const older = refresh();
            await expect.poll(() => answers.length).toBe(2);
            client.closeDocument('virtual:lib/a.one');
            const reopening = client.openContentDocument('virtual:lib/a.one');
            await expect.poll(() => answers.length).toBe(3);
            answers[2]!.resolve('lib reopened');
            const reopened = await reopening;

            answers[1]!.resolve('lib old');
            await older;

            expect(reopened?.getValue()).toBe('lib reopened');
         });
      });

      it('requests nothing for a refresh of a content document it has no model for', async () => {
         const ends = makeEnds();
         let requests = 0;
         ends.server.onRequest(TextDocumentContentRequest.type, () => {
            requests++;
            return { text: 'lib' };
         });
         const client = makeContentClient(ends);
         await client.openContentDocument('virtual:lib/a.one');
         client.closeDocument('virtual:lib/a.one');

         await ends.server.sendRequest(TextDocumentContentRefreshRequest.type, { uri: 'virtual:lib/a.one' });
         await ends.server.sendRequest(TextDocumentContentRefreshRequest.type, { uri: 'virtual:lib/b.one' });

         expect(requests).toBe(1);
      });

      it("leaves the host's refresh handler in place for a server that holds no content documents", async () => {
         const ends = makeEnds();
         const refreshed: string[] = [];
         ends.page.onRequest(TextDocumentContentRefreshRequest.type, params => {
            refreshed.push(params.uri);
         });
         makeClient(ends);

         await ends.server.sendRequest(TextDocumentContentRefreshRequest.type, { uri: 'virtual:lib/a.one' });

         expect(refreshed).toEqual(['virtual:lib/a.one']);
      });

      it('opens nothing, and rejects nothing, for a content request the server gave up', async () => {
         const ends = makeEnds();
         ends.server.onRequest(TextDocumentContentRequest.type, () => {
            throw new ResponseError(LSPErrorCodes.ContentModified, 'changed meanwhile');
         });
         const client = makeContentClient(ends);

         expect(await client.openContentDocument('virtual:lib/a.one')).toBeUndefined();
      });

      it('closes a synced document opened over a content model the host disposed', async () => {
         const ends = makeEnds();
         ends.server.onRequest(TextDocumentContentRequest.type, () => ({ text: 'lib' }));
         const client = makeContentClient(ends);
         (await client.openContentDocument('virtual:lib/a.one'))!.dispose();
         const synced = client.openDocument('virtual:lib/a.one', 'synced');

         client.closeDocument('virtual:lib/a.one');
         await ends.flush();

         expect({ closes: ends.closes.map(close => close.textDocument.uri), disposed: synced.isDisposed() }).toEqual({
            closes: ['virtual:lib/a.one'],
            disposed: true
         });
      });

      it('asks the server for nothing once disposed, for an open or a request of the text', async () => {
         const ends = makeEnds();
         let requests = 0;
         ends.server.onRequest(TextDocumentContentRequest.type, () => {
            requests++;
            return { text: 'lib' };
         });
         const client = makeContentClient(ends);
         client.dispose();

         const model = await client.openContentDocument('virtual:lib/a.one');
         const text = await client.requestDocumentContent('virtual:lib/a.one');
         await ends.flush();

         expect({ model, text, requests }).toEqual({ model: undefined, text: undefined, requests: 0 });
      });

      it('opens a content document whose synced model the host disposed, closing it on the server first', async () => {
         const ends = makeEnds();
         ends.server.onRequest(TextDocumentContentRequest.type, () => ({ text: 'lib' }));
         const client = makeContentClient(ends);
         client.openDocument('virtual:lib/a.one', 'synced').dispose();

         const model = await client.openContentDocument('virtual:lib/a.one');
         await ends.flush();

         expect({ text: model?.getValue(), closes: ends.closes.map(close => close.textDocument.uri) }).toEqual({
            text: 'lib',
            closes: ['virtual:lib/a.one']
         });
      });

      it('opens a content document again after an open the server failed', async () => {
         const ends = makeEnds();
         let requests = 0;
         ends.server.onRequest(TextDocumentContentRequest.type, () => {
            requests++;
            if (requests === 1) {
               throw new Error('not yet');
            }
            return { text: 'lib' };
         });
         const client = makeContentClient(ends);

         await expect(client.openContentDocument('virtual:lib/a.one')).rejects.toThrow('not yet');
         const model = await client.openContentDocument('virtual:lib/a.one');

         expect({ text: model?.getValue(), requests }).toEqual({ text: 'lib', requests: 2 });
      });

      it('opens a content document closed and opened again before the server answered on the second answer alone', async () => {
         const ends = makeEnds();
         const answers: Array<() => void> = [];
         ends.server.onRequest(
            TextDocumentContentRequest.type,
            () => new Promise<{ text: string }>(resolve => answers.push(() => resolve({ text: `answer ${answers.length}` })))
         );
         const client = makeContentClient(ends);

         const closed = client.openContentDocument('virtual:lib/a.one');
         await expect.poll(() => answers.length).toBe(1);
         client.closeDocument('virtual:lib/a.one');
         const reopened = client.openContentDocument('virtual:lib/a.one');
         await expect.poll(() => answers.length).toBe(2);
         answers[0]!();
         answers[1]!();

         expect({ closed: await closed, text: (await reopened)?.getValue() }).toEqual({ closed: undefined, text: 'answer 2' });
      });

      it("leaves a navigation from an editor on another client's model to the next opener", () => {
         const ends = makeEnds();
         const client = makeClient(ends);
         const opened: string[] = [];
         client.registerEditorOpener(uri => {
            opened.push(uri);
            return true;
         });
         const theirs = monacoDouble.editor.createModel('theirs', 'type-one', monacoDouble.Uri.parse('file:///a.one'));
         const source = monacoDouble.editor.create({} as HTMLElement, { model: theirs });

         const handled = monacoDouble.openers[0]!.openCodeEditor(source, monacoDouble.Uri.parse('file:///b.two'), undefined);

         expect(handled).toBe(false);
         expect(opened).toEqual([]);
      });
   });

   describe('cancellation', () => {
      it("forwards Monaco's token, so a cancelled request reaches the server as $/cancelRequest", async () => {
         const ends = makeEnds();
         const cancelled: string[] = [];
         const untilCancelled =
            (kind: string) =>
            (_params: unknown, token: CancellationToken): Promise<null> =>
               new Promise(resolve => {
                  token.onCancellationRequested(() => {
                     cancelled.push(kind);
                     resolve(null);
                  });
               });
         ends.server.onRequest(SemanticTokensRequest.type, untilCancelled('semanticTokens'));
         ends.server.onRequest(CompletionRequest.type, untilCancelled('completion'));
         ends.server.onRequest(HoverRequest.type, untilCancelled('hover'));
         ends.server.onRequest(DefinitionRequest.type, untilCancelled('definition'));
         ends.server.onRequest(DocumentHighlightRequest.type, untilCancelled('documentHighlight'));
         const client = makeClient(ends);
         const model = client.openDocument('file:///a.one', 'one');
         const source = new CancellationTokenSource();
         const token: monaco.CancellationToken = source.token;
         const context = {} as monaco.languages.CompletionContext;

         const pending = Promise.allSettled([
            providerOf<monaco.languages.DocumentSemanticTokensProvider>('semanticTokens', 'type-one').provideDocumentSemanticTokens(
               model,
               null,
               token
            ),
            providerOf<monaco.languages.CompletionItemProvider>('completion', 'type-one').provideCompletionItems(
               model,
               position(1, 1),
               context,
               token
            ),
            providerOf<monaco.languages.HoverProvider>('hover', 'type-one').provideHover(model, position(1, 1), token),
            providerOf<monaco.languages.DefinitionProvider>('definition', 'type-one').provideDefinition(model, position(1, 1), token),
            providerOf<monaco.languages.DocumentHighlightProvider>('documentHighlight', 'type-one').provideDocumentHighlights(
               model,
               position(1, 1),
               token
            )
         ]);
         source.cancel();
         await pending;

         expect(cancelled.sort()).toEqual(['completion', 'definition', 'documentHighlight', 'hover', 'semanticTokens']);
      });

      it.each([
         ['RequestCancelled', LSPErrorCodes.RequestCancelled],
         ['ServerCancelled', LSPErrorCodes.ServerCancelled],
         ['ContentModified', LSPErrorCodes.ContentModified]
      ])("rejects with Monaco's cancellation when the server answers %s, so Monaco drops it silently", async (_name, code) => {
         const ends = makeEnds();
         const abandoned = (): never => {
            throw new ResponseError(code, 'abandoned');
         };
         ends.server.onRequest(SemanticTokensRequest.type, abandoned);
         ends.server.onRequest(CompletionRequest.type, abandoned);
         ends.server.onRequest(HoverRequest.type, abandoned);
         ends.server.onRequest(DefinitionRequest.type, abandoned);
         ends.server.onRequest(DocumentHighlightRequest.type, abandoned);
         const client = makeClient(ends);
         const model = client.openDocument('file:///a.one', 'one');

         const results = await askEveryProvider(model);

         expect(results.map(reasonOf)).toEqual(Array(5).fill(MONACO_CANCELLATION));
      });

      it("rejects with Monaco's cancellation once the connection is closed, a request pending then included", async () => {
         const ends = makeEnds();
         ends.server.onRequest(HoverRequest.type, () => new Promise<null>(() => undefined));
         const client = makeClient(ends);
         const model = client.openDocument('file:///a.one', 'one');
         const pending = providerOf<monaco.languages.HoverProvider>('hover', 'type-one').provideHover(
            model,
            position(1, 1),
            {} as monaco.CancellationToken
         );
         await ends.flush();

         ends.page.dispose();
         const afterClose = await askEveryProvider(model);

         await expect(pending).rejects.toMatchObject(MONACO_CANCELLATION);
         expect(afterClose.map(reasonOf)).toEqual(Array(5).fill(MONACO_CANCELLATION));
      });

      it('leaves any other failed request to Monaco', async () => {
         const ends = makeEnds();
         ends.server.onRequest(HoverRequest.type, () => {
            throw new ResponseError(ErrorCodes.InternalError, 'broken');
         });
         const client = makeClient(ends);
         const model = client.openDocument('file:///a.one', 'one');

         const hover = providerOf<monaco.languages.HoverProvider>('hover', 'type-one').provideHover(
            model,
            position(1, 1),
            {} as monaco.CancellationToken
         );

         await expect(hover).rejects.toMatchObject({ code: ErrorCodes.InternalError, message: 'broken' });
      });
   });

   describe('capabilities', () => {
      it('declares the forms the client renders, the two workspace answers included', () => {
         expect(MONACO_CLIENT_CAPABILITIES).toMatchObject({
            workspace: { applyEdit: true, configuration: true, workspaceEdit: { documentChanges: true } },
            textDocument: {
               completion: {
                  contextSupport: true,
                  completionItem: {
                     snippetSupport: true,
                     insertReplaceSupport: true,
                     labelDetailsSupport: true,
                     commitCharactersSupport: true,
                     preselectSupport: true,
                     deprecatedSupport: true,
                     tagSupport: { valueSet: [CompletionItemTag.Deprecated] },
                     documentationFormat: ['markdown', 'plaintext']
                  }
               },
               hover: { contentFormat: ['markdown', 'plaintext'] },
               definition: { linkSupport: true },
               publishDiagnostics: {
                  relatedInformation: true,
                  codeDescriptionSupport: true,
                  tagSupport: { valueSet: [DiagnosticTag.Unnecessary, DiagnosticTag.Deprecated] }
               },
               semanticTokens: { requests: { full: true }, formats: ['relative'] }
            }
         });
      });

      it('leaves multi-line semantic tokens undeclared, which Monaco cannot render, so Langium splits them per line', () => {
         expect(MONACO_CLIENT_CAPABILITIES.textDocument?.semanticTokens?.multilineTokenSupport).toBeUndefined();
      });

      it('refuses a change in place at any depth, so one host cannot alter what another declares', () => {
         const textDocument = MONACO_CLIENT_CAPABILITIES.textDocument;
         const hover = textDocument?.hover;
         const tags = textDocument?.publishDiagnostics?.tagSupport?.valueSet;

         expect(() => {
            MONACO_CLIENT_CAPABILITIES.workspace = {};
         }).toThrow(TypeError);
         expect(() => {
            if (hover !== undefined) {
               hover.contentFormat = [];
            }
         }).toThrow(TypeError);
         expect(() => tags?.push(DiagnosticTag.Deprecated)).toThrow(TypeError);
      });
   });

   describe('editors', () => {
      it("stops listening to every editor's events once disposed", () => {
         const ends = makeEnds();
         const client = makeContentClient(ends);
         monacoDouble.editor.create({} as HTMLElement, {});
         const watched = monacoDouble.editors[0]!.listenerCount;

         client.dispose();

         expect({ watched, after: monacoDouble.editors[0]!.listenerCount }).toEqual({ watched: 2, after: 0 });
      });

      it('forgets an editor the host disposed', () => {
         class Exposed extends MonacoLspClient {
            get watched(): number {
               return this.watchedEditors.size;
            }
         }
         const client = new Exposed(
            makeEnds().page,
            { workspace: { textDocumentContent: { schemes: ['virtual'] } } },
            { languages: LANGUAGES, clientCapabilities: MONACO_CLIENT_CAPABILITIES }
         );
         toDispose.push(client);
         const created = monacoDouble.editor.create({} as HTMLElement, {});
         const before = client.watched;

         created.dispose();

         expect({ before, after: client.watched }).toEqual({ before: 1, after: 0 });
      });

      it('leaves every editor alone in a client without content support, which shows no content model', () => {
         const editor = monacoDouble.editor.create({} as HTMLElement, {});
         const update = editor.updateOptions;
         makeClient(makeEnds());
         monacoDouble.editor.create({} as HTMLElement, {});

         expect({
            wrapped: editor.updateOptions !== update,
            listeners: monacoDouble.editors.map(created => created.listenerCount)
         }).toEqual({ wrapped: false, listeners: [0, 0] });
      });

      it("creates an editor with the four correctness settings under the host's options", () => {
         const ends = makeEnds();
         const client = makeClient(ends);
         const model = client.openDocument('file:///a.one', 'one');

         const created = client.createEditor({} as HTMLElement, model, { theme: 'mine', minimap: { enabled: false } });

         expect(created.getModel()).toBe(model);
         expect(monacoDouble.editors[0]!.options).toEqual({
            fixedOverflowWidgets: true,
            wordBasedSuggestions: 'off',
            suggest: { insertMode: 'replace' },
            'semanticHighlighting.enabled': true,
            theme: 'mine',
            minimap: { enabled: false },
            model
         });
      });

      it("merges the host's suggest settings with the replace insert mode rather than replacing them", () => {
         const ends = makeEnds();
         const client = makeClient(ends);
         const model = client.openDocument('file:///a.one', 'one');

         client.createEditor({} as HTMLElement, model, { suggest: { showWords: false } });

         expect(monacoDouble.editors[0]!.options.suggest).toEqual({ insertMode: 'replace', showWords: false });
      });

      it('routes a target in another document to the opener, at the range start, and leaves the source editor to Monaco', () => {
         const ends = makeEnds();
         const client = makeClient(ends);
         const source = client.createEditor({} as HTMLElement, client.openDocument('file:///a.one', 'one'));
         const opened: [string, monaco.IPosition][] = [];
         client.registerEditorOpener((uri, position) => {
            opened.push([uri, position]);
            return true;
         });
         const opener = monacoDouble.openers[0]!;

         const other = opener.openCodeEditor(source, monacoDouble.Uri.parse('file:///b.two'), range(3, 4, 3, 9));
         const byPosition = opener.openCodeEditor(source, monacoDouble.Uri.parse('file:///c.two'), { lineNumber: 2, column: 2 });
         const bare = opener.openCodeEditor(source, monacoDouble.Uri.parse('file:///d.two'), undefined);
         const own = opener.openCodeEditor(source, monacoDouble.Uri.parse('file:///a.one'), range(1, 1, 1, 1));

         expect([other, byPosition, bare, own]).toEqual([true, true, true, false]);
         expect(opened).toEqual([
            ['file:///b.two', { lineNumber: 3, column: 4 }],
            ['file:///c.two', { lineNumber: 2, column: 2 }],
            ['file:///d.two', { lineNumber: 1, column: 1 }]
         ]);
      });

      it('answers false for an opener that throws or rejects, so Monaco tries the next opener', async () => {
         const ends = makeEnds();
         const client = makeClient(ends);
         const source = client.createEditor({} as HTMLElement, client.openDocument('file:///a.one', 'one'));
         const failure = new Error('no editor');
         const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
         try {
            client.registerEditorOpener(uri => {
               if (uri === 'file:///b.two') {
                  throw failure;
               }
               return Promise.reject(failure);
            });
            const opener = monacoDouble.openers[0]!;

            const thrown = opener.openCodeEditor(source, monacoDouble.Uri.parse('file:///b.two'), undefined);
            const rejected = await opener.openCodeEditor(source, monacoDouble.Uri.parse('file:///c.two'), undefined);

            expect({ thrown, rejected }).toEqual({ thrown: false, rejected: false });
            expect(logged.mock.calls).toEqual([
               ['Could not open file:///b.two', failure],
               ['Could not open file:///c.two', failure]
            ]);
         } finally {
            logged.mockRestore();
         }
      });

      it("keeps an editor read-only across two clients' content models, and gives back its own setting after", async () => {
         const first = makeEnds();
         const second = makeEnds();
         first.server.onRequest(TextDocumentContentRequest.type, () => ({ text: 'first' }));
         second.server.onRequest(TextDocumentContentRequest.type, () => ({ text: 'second' }));
         const firstClient = makeContentClient(first);
         const secondClient = makeContentClient(second);
         const firstModel = (await firstClient.openContentDocument('virtual:lib/a.one'))!;
         const secondModel = (await secondClient.openContentDocument('virtual:lib/b.one'))!;
         const own = firstClient.openDocument('file:///a.one', 'one');
         const shared = monacoDouble.editor.create({} as HTMLElement, { model: secondModel });

         shared.setModel(firstModel);
         const onFirstAfterSecond = monacoDouble.editors[0]!.readOnly;
         shared.setModel(own);

         expect({ onFirstAfterSecond, onOwn: monacoDouble.editors[0]!.readOnly }).toEqual({ onFirstAfterSecond: true, onOwn: false });
      });

      it('keeps every editor read-only while it shows a content model, and gives back its own setting after', async () => {
         const ends = makeEnds();
         ends.server.onRequest(TextDocumentContentRequest.type, () => ({ text: 'lib' }));
         const earlier = monacoDouble.editor.create({} as HTMLElement, {});
         const client = makeContentClient(ends);
         const own = client.openDocument('file:///a.one', 'one');
         const model = (await client.openContentDocument('virtual:lib/a.one'))!;
         const created = monacoDouble.editor.create({} as HTMLElement, { model });
         const locked = monacoDouble.editor.create({} as HTMLElement, { readOnly: true });
         earlier.setModel(model);
         locked.setModel(model);
         const [earlierDouble, createdDouble, lockedDouble] = monacoDouble.editors;
         const whileShown = [earlierDouble!.readOnly, createdDouble!.readOnly, lockedDouble!.readOnly];

         created.setModel(own);
         locked.setModel(own);
         client.closeDocument('virtual:lib/a.one');

         expect({ whileShown, after: [earlierDouble!.readOnly, createdDouble!.readOnly, lockedDouble!.readOnly] }).toEqual({
            whileShown: [true, true, true],
            after: [false, false, true]
         });
      });

      it('disposes a content model an editor shows when the client is disposed, and gives the editor its setting back', async () => {
         const ends = makeEnds();
         ends.server.onRequest(TextDocumentContentRequest.type, () => ({ text: 'lib' }));
         const client = makeContentClient(ends);
         const model = (await client.openContentDocument('virtual:lib/a.one'))!;
         monacoDouble.editor.create({} as HTMLElement, { model });

         client.dispose();

         expect({ disposed: model.isDisposed(), readOnly: monacoDouble.editors[0]!.readOnly }).toEqual({ disposed: true, readOnly: false });
      });

      it("keeps an editor read-only when its host turns that off while it shows a content model, and gives the host's setting back after", async () => {
         const first = makeEnds();
         const second = makeEnds();
         first.server.onRequest(TextDocumentContentRequest.type, () => ({ text: 'lib' }));
         second.server.onRequest(TextDocumentContentRequest.type, () => ({ text: 'lib' }));
         const client = makeContentClient(first);
         makeContentClient(second);
         const own = client.openDocument('file:///a.one', 'one');
         const model = (await client.openContentDocument('virtual:lib/a.one'))!;
         const editor = monacoDouble.editor.create({} as HTMLElement, { model, readOnly: true });

         editor.updateOptions({ readOnly: false });
         const whileShown = monacoDouble.editors[0]!.readOnly;
         editor.setModel(own);

         expect({ whileShown, after: monacoDouble.editors[0]!.readOnly }).toEqual({ whileShown: true, after: false });
      });

      it('gives back a readOnly the host turned on while the editor showed a content model', async () => {
         const ends = makeEnds();
         ends.server.onRequest(TextDocumentContentRequest.type, () => ({ text: 'lib' }));
         const client = makeContentClient(ends);
         const own = client.openDocument('file:///a.one', 'one');
         const model = (await client.openContentDocument('virtual:lib/a.one'))!;
         const editor = monacoDouble.editor.create({} as HTMLElement, { model });

         editor.updateOptions({ readOnly: true });
         editor.setModel(own);

         expect(monacoDouble.editors[0]!.readOnly).toBe(true);
      });
   });
});

describe('MonacoLspClient save over the LSP head', () => {
   const SAVING: ServerCapabilities = { ...CAPABILITIES, experimental: { [SaveTextDocumentRequest.method]: true } };

   interface SaveServer {
      /** Each save request as `uri@version`, with the changes the server had heard of when it arrived. */
      readonly requests: { readonly save: string; readonly changesHeard: number }[];
      /** Answers the server holds back until the test releases them, by `uri@version`. */
      readonly held: Map<string, () => void>;
      /** URIs the server refuses with a conflict. */
      readonly refusing: Set<string>;
      hold: boolean;
   }

   function makeSaveServer(ends: Ends): SaveServer {
      const server: SaveServer = { requests: [], held: new Map(), refusing: new Set(), hold: false };
      ends.server.onRequest(SaveTextDocumentRequest.method, (params: SaveTextDocumentParams) => {
         const { uri, version } = params.textDocument;
         server.requests.push({ save: `${uri}@${version}`, changesHeard: ends.changes.length });
         const answer = (): null => {
            if (server.refusing.has(uri)) {
               // As the server's refusal crosses the wire: a bare error with the code and data.
               throw new ResponseError(CONFLICT_ERROR_CODE, `refused ${uri}`, { uri, baseVersion: version, actualVersion: version + 1 });
            }
            return null;
         };
         return server.hold
            ? new Promise<null>((resolve, reject) =>
                 server.held.set(`${uri}@${version}`, () => {
                    try {
                       resolve(answer());
                    } catch (error: unknown) {
                       reject(error);
                    }
                 })
              )
            : answer();
      });
      return server;
   }

   function makeSavingClient(ends: Ends, capabilities = SAVING): MonacoLspClient {
      const client = new MonacoLspClient(ends.page, capabilities, { languages: LANGUAGES });
      toDispose.push(client);
      for (const uri of ['file:///a.one', 'file:///b.two']) {
         client.openDocument(uri, 'text');
         modelOf(uri).edit([{ range: range(1, 1, 1, 1), text: '!' }]);
      }
      return client;
   }

   const dirtyUris = (client: MonacoLspClient): string[] => client.dirtyDocuments().map(document => document.uri);

   it('sends the save after the changes it covers, at the buffer version, and marks the document saved', async () => {
      const ends = makeEnds();
      const server = makeSaveServer(ends);
      const client = makeSavingClient(ends);

      const saved = await client.save('file:///b.two');

      expect(saved).toEqual({ uri: 'file:///b.two', text: '!text', version: 2, model: modelOf('file:///b.two') });
      expect(server.requests).toEqual([{ save: 'file:///b.two@2', changesHeard: 2 }]);
      expect(dirtyUris(client)).toEqual(['file:///a.one']);
   });

   it('sends the version the didChanges declared, which an undo steps on, not the one dirty tracking steps back', async () => {
      const ends = makeEnds();
      const server = makeSaveServer(ends);
      const client = makeSavingClient(ends);
      modelOf('file:///a.one').edit([{ range: range(1, 1, 1, 1), text: '?' }]);
      modelOf('file:///a.one').undo();

      await client.save('file:///a.one');

      expect(server.requests.map(request => request.save)).toEqual([`file:///a.one@${ends.changes.at(-1)!.textDocument.version}`]);
   });

   it("saves a URI given in the host's form", async () => {
      const ends = makeEnds();
      const server = makeSaveServer(ends);
      const client = makeSavingClient(ends);
      client.openDocument('file:///w/my file.one', 'text');
      modelOf('file:///w/my%20file.one').edit([{ range: range(1, 1, 1, 1), text: '!' }]);

      await client.save('file:///w/my file.one');

      expect(server.requests.map(request => request.save)).toEqual(['file:///w/my%20file.one@2']);
   });

   it('sends nothing for a document that is not dirty', async () => {
      const ends = makeEnds();
      const server = makeSaveServer(ends);
      const client = makeSavingClient(ends);
      client.openDocument('file:///c.two', 'text');

      expect(await client.save('file:///c.two')).toBeUndefined();
      await ends.flush();
      expect(server.requests).toEqual([]);
   });

   it('keeps a document dirty when a keystroke lands while its save is in flight', async () => {
      const ends = makeEnds();
      const server = makeSaveServer(ends);
      server.hold = true;
      const client = makeSavingClient(ends);

      const saving = client.save('file:///a.one');
      await waitFor(() => server.held.has('file:///a.one@2'));
      modelOf('file:///a.one').edit([{ range: range(1, 1, 1, 1), text: '?' }]);
      server.held.get('file:///a.one@2')!();
      await saving;

      expect(dirtyUris(client)).toEqual(['file:///a.one', 'file:///b.two']);
   });

   it('keeps a newer save marked when an older save of the document is answered after it', async () => {
      const ends = makeEnds();
      const server = makeSaveServer(ends);
      server.hold = true;
      const client = makeSavingClient(ends);
      const older = client.save('file:///a.one');
      await waitFor(() => server.held.has('file:///a.one@2'));
      modelOf('file:///a.one').edit([{ range: range(1, 1, 1, 1), text: '?' }]);
      const newer = client.save('file:///a.one');
      await waitFor(() => server.held.has('file:///a.one@3'));

      // As a coalesced save answers: the newer save first, then the one it wrote for.
      server.held.get('file:///a.one@3')!();
      await newer;
      server.held.get('file:///a.one@2')!();
      await older;

      expect(dirtyUris(client)).toEqual(['file:///b.two']);
   });

   it('records nothing for a document whose model the host disposed while its save was in flight', async () => {
      class SaveRecords extends MonacoLspClient {
         get marked(): ReadonlyMap<string, number> {
            return this.markedSaves;
         }
      }
      const ends = makeEnds();
      const server = makeSaveServer(ends);
      server.hold = true;
      const client = new SaveRecords(ends.page, SAVING, { languages: LANGUAGES });
      toDispose.push(client);
      client.openDocument('file:///a.one', 'text');
      modelOf('file:///a.one').edit([{ range: range(1, 1, 1, 1), text: '!' }]);

      const saving = client.save('file:///a.one');
      await waitFor(() => server.held.has('file:///a.one@2'));
      modelOf('file:///a.one').dispose();
      server.held.get('file:///a.one@2')!();
      await saving;

      expect([...client.marked.keys()]).toEqual([]);
   });

   it('rejects with the refusal and leaves the document dirty', async () => {
      const ends = makeEnds();
      const server = makeSaveServer(ends);
      server.refusing.add('file:///a.one');
      const client = makeSavingClient(ends);

      const refused = await client.save('file:///a.one').catch((error: unknown) => error);

      expect(refused).toMatchObject({ code: CONFLICT_ERROR_CODE, message: 'refused file:///a.one' });
      expect(isConflictError(refused) && refused.actualVersion).toBe(3);
      expect(dirtyUris(client)).toEqual(['file:///a.one', 'file:///b.two']);
   });

   it('throws, sending nothing, when the server does not advertise the request', async () => {
      const ends = makeEnds();
      const server = makeSaveServer(ends);
      const client = makeSavingClient(ends, CAPABILITIES);

      await expect(client.save('file:///a.one')).rejects.toThrow(SaveTextDocumentRequest.method);
      await expect(client.saveAll()).rejects.toThrow(SaveTextDocumentRequest.method);
      await ends.flush();
      expect(server.requests).toEqual([]);
   });

   it('saves every dirty document at once, marking each on its own answer', async () => {
      const ends = makeEnds();
      const server = makeSaveServer(ends);
      server.hold = true;
      const client = makeSavingClient(ends);

      const saving = client.saveAll();
      await waitFor(() => server.held.size === 2);
      server.held.get('file:///b.two@2')!();
      await waitFor(() => dirtyUris(client).length === 1);
      expect(dirtyUris(client)).toEqual(['file:///a.one']);
      server.held.get('file:///a.one@2')!();

      expect((await saving).map(document => document.uri)).toEqual(['file:///a.one', 'file:///b.two']);
      expect(dirtyUris(client)).toEqual([]);
   });

   it('rejects a save of all with the first refusal once every answer is in, keeping the documents that saved', async () => {
      const ends = makeEnds();
      const server = makeSaveServer(ends);
      server.hold = true;
      server.refusing.add('file:///a.one');
      const client = makeSavingClient(ends);

      const saving = client.saveAll().catch((error: unknown) => error);
      await waitFor(() => server.held.size === 2);
      server.held.get('file:///a.one@2')!();
      await ends.flush();
      expect(dirtyUris(client)).toEqual(['file:///a.one', 'file:///b.two']);
      server.held.get('file:///b.two@2')!();

      expect(await saving).toMatchObject({ code: CONFLICT_ERROR_CODE, message: 'refused file:///a.one' });
      expect(dirtyUris(client)).toEqual(['file:///a.one']);
   });
});
