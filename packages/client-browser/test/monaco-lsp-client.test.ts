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

import { createMessagePortTransport, NoopLogger, type TextState, textHash } from '@hydranium/protocol';
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
   type WorkspaceEdit
} from 'vscode-languageserver-protocol';
import { type DocumentPersister, MONACO_CLIENT_CAPABILITIES, MonacoLspClient, saveDirtyDocuments } from '../src/monaco';
import { anotherCopyConnection } from './another-copy-connection.js';
import * as monacoDouble from './monaco-editor-core-double.js';

vi.mock('monaco-editor-core', () => import('./monaco-editor-core-double.js'));

const toDispose: { dispose(): void }[] = [];

afterEach(() => {
   for (const disposable of toDispose.reverse()) {
      disposable.dispose();
   }
   toDispose.length = 0;
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

      it('closes on the server and opens afresh when the host disposed the model itself', async () => {
         const ends = makeEnds();
         const client = makeClient(ends);
         client.openDocument('file:///a.one', 'one');
         modelOf('file:///a.one').dispose();

         const reopened = client.openDocument('file:///a.one', 'two');
         modelOf('file:///a.one').edit([{ range: range(1, 1, 1, 1), text: 'x' }]);
         await ends.flush();

         expect(reopened.getValue()).toBe('xtwo');
         expect(ends.closes.map(close => close.textDocument.uri)).toEqual(['file:///a.one']);
         expect(ends.opens.map(open => open.textDocument.text)).toEqual(['one', 'two']);
         expect(ends.changes.map(change => change.textDocument.uri)).toEqual(['file:///a.one']);
      });

      it('refuses a model that replaced one the host disposed, after closing the URI on the server', async () => {
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

         client.closeDocument('file:///a.one');

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

      it('reads, writes and marks nothing on a model the host disposed while the client still holds it', async () => {
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
         expect(monacoDouble.markers.get('lsp file:///a.one')).toBeUndefined();
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
   });
});

describe('saveDirtyDocuments', () => {
   interface SessionDouble extends DocumentPersister {
      readonly opened: string[];
      readonly closed: string[];
      readonly persisted: string[];
      failing?: string;
      /** The text the server holds per URI; the model's own unless set, as for a `didChange` it has handled. */
      readonly serverText: Map<string, string>;
   }

   function makeSession(): SessionDouble {
      const session: SessionDouble = {
         opened: [],
         closed: [],
         persisted: [],
         serverText: new Map(),
         async withOpenDocument(args, fn) {
            session.opened.push(args.uri);
            const text: TextState = {
               version: 1,
               hash: textHash(session.serverText.get(args.uri) ?? modelOf(args.uri).getValue()),
               dirty: true
            };
            try {
               return await fn({ text });
            } finally {
               session.closed.push(args.uri);
            }
         },
         async persistDocument(args) {
            if (args.uri === session.failing) {
               throw new Error('quota');
            }
            session.persisted.push(`${args.uri}@${String(args.baseVersion)}`);
         }
      };
      return session;
   }

   function makeDirtyClient(ends: Ends): MonacoLspClient {
      const client = new MonacoLspClient(ends.page, CAPABILITIES, { languages: LANGUAGES });
      toDispose.push(client);
      for (const uri of ['file:///a.one', 'file:///b.two', 'file:///c.two']) {
         client.openDocument(uri, 'text');
         modelOf(uri).edit([{ range: range(1, 1, 1, 1), text: '!' }]);
      }
      return client;
   }

   it('persists each dirty document through the session, marks it saved and returns what it saved', async () => {
      const ends = makeEnds();
      const client = makeDirtyClient(ends);
      const session = makeSession();

      const saved = await saveDirtyDocuments(client, session);

      expect(saved).toEqual([
         { uri: 'file:///a.one', text: '!text', version: 2, model: modelOf('file:///a.one') },
         { uri: 'file:///b.two', text: '!text', version: 2, model: modelOf('file:///b.two') },
         { uri: 'file:///c.two', text: '!text', version: 2, model: modelOf('file:///c.two') }
      ]);
      expect(session.persisted).toEqual(['file:///a.one@any', 'file:///b.two@any', 'file:///c.two@any']);
      expect(session.closed).toEqual(session.opened);
      expect(client.dirtyDocuments()).toEqual([]);
   });

   it('saves only the named URIs', async () => {
      const ends = makeEnds();
      const client = makeDirtyClient(ends);
      const session = makeSession();

      const saved = await saveDirtyDocuments(client, session, ['file:///b.two']);

      expect(saved.map(document => document.uri)).toEqual(['file:///b.two']);
      expect(client.dirtyDocuments().map(document => document.uri)).toEqual(['file:///a.one', 'file:///c.two']);
   });

   it('leaves the documents a failing persist never reached dirty', async () => {
      const ends = makeEnds();
      const client = makeDirtyClient(ends);
      const session = makeSession();
      session.failing = 'file:///b.two';

      await expect(saveDirtyDocuments(client, session)).rejects.toThrow('quota');

      expect(client.dirtyDocuments().map(document => document.uri)).toEqual(['file:///b.two', 'file:///c.two']);
   });

   it('reads each buffer just before its own open, so a keystroke during an earlier save does not fail it', async () => {
      const ends = makeEnds();
      const client = makeDirtyClient(ends);
      const session = makeSession();
      const open = session.withOpenDocument.bind(session);
      session.withOpenDocument = async (args, fn) => {
         if (args.uri === 'file:///a.one') {
            modelOf('file:///b.two').edit([{ range: range(1, 1, 1, 1), text: '?' }]);
         }
         return open(args, fn);
      };

      const saved = await saveDirtyDocuments(client, session);

      expect(saved.map(document => document.text)).toEqual(['!text', '?!text', '!text']);
      expect(client.dirtyDocuments()).toEqual([]);
   });

   it("saves a named URI given in the host's form, not only in Monaco's", async () => {
      const ends = makeEnds();
      const client = makeDirtyClient(ends);
      client.openDocument('file:///w/my file.one', 'text');
      modelOf('file:///w/my%20file.one').edit([{ range: range(1, 1, 1, 1), text: '!' }]);
      const session = makeSession();

      const saved = await saveDirtyDocuments(client, session, ['file:///w/my file.one']);

      expect(saved.map(document => document.uri)).toEqual(['file:///w/my%20file.one']);
      expect(client.dirtyDocuments().map(document => document.uri)).toEqual(['file:///a.one', 'file:///b.two', 'file:///c.two']);
   });

   it("refuses a document whose server text is not the buffer's, naming it, and leaves it dirty", async () => {
      const ends = makeEnds();
      const client = makeDirtyClient(ends);
      const session = makeSession();
      session.serverText.set('file:///b.two', 'text');

      await expect(saveDirtyDocuments(client, session)).rejects.toThrow(/file:\/\/\/b\.two/);

      expect(session.persisted).toEqual(['file:///a.one@any']);
      expect(client.dirtyDocuments().map(document => document.uri)).toEqual(['file:///b.two', 'file:///c.two']);
   });

   it('saves nothing when nothing is dirty', async () => {
      const ends = makeEnds();
      const client = new MonacoLspClient(ends.page, CAPABILITIES, { languages: LANGUAGES });
      toDispose.push(client);
      client.openDocument('file:///a.one', 'text');
      const session = makeSession();

      expect(await saveDirtyDocuments(client, session)).toEqual([]);
      expect(session.opened).toEqual([]);
   });
});
