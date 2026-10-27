/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * Requests whose answer is an edit, over the REAL transport, while the push of
 * another client's write is on its way to the editor.
 *
 * The harness answers a push as applied and echoes nothing, so the editor
 * keeps its old text until the test sends the echo. An edit computed on the
 * written text would be applied to that old text.
 */

import { HydraniumWorkspaceLock, serverSharedFactory } from '@hydranium/core';
import { startLanguageServer } from '@hydranium/core/lsp';
import { DefaultFileSystemProvider } from '@hydranium/core/node';
import {
   makeLspServerConnection,
   makeScratchWorkspace,
   type LspServerConnection,
   type ScratchWorkspace
} from '@hydranium/core/testing/node';
import { URI } from '@hydranium/langium';
import { Deferred } from '@hydranium/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { LSPErrorCodes, type CodeAction, type WorkspaceEdit } from 'vscode-languageserver';
import {
   createOrderFlowServices,
   type OrderFlowOptions,
   type OrderFlowServices,
   type OrderFlowSharedServices
} from '../src/language-server/order-flow-module.js';

const PROCESS_URI = 'file:///edit-requests-push.process';
const DOMAIN_URI = 'file:///edit-requests-push.domain';

const DOMAIN = `entity Crate {
   a : string
}
`;

const DOMAIN_WRITTEN = `entity Crate {
   a : string
   b : string
}
`;

const OPENED = `process Handling for Crate {
   task Inspect
}
`;

// Inserted above `Inspect` and left unformatted, so a format has an edit to make.
const WRITTEN = `process Handling for Crate {
   task Ship
         task    Inspect
}
`;

// Each request here is answered in well under a second; a bound names the one
// that is not, where the test's own timeout would only report the test.
const ANSWER_TIMEOUT_MS = 3_000;

let transport: LspServerConnection | undefined;
let workspace: ScratchWorkspace | undefined;
let describeDocuments: () => string = () => 'no server';

afterEach(() => {
   transport?.dispose();
   transport = undefined;
   describeDocuments = () => 'no server';
   workspace?.dispose();
   workspace = undefined;
});

async function composeServer(
   options?: OrderFlowOptions,
   on?: { readonly workspace: ScratchWorkspace }
): Promise<{
   composed: LspServerConnection;
   shared: OrderFlowSharedServices;
   process: OrderFlowServices;
}> {
   const composed = makeLspServerConnection();
   transport = composed;
   const services = createOrderFlowServices(
      on
         ? {
              connection: composed.serverConnection,
              fileSystemProvider: serverSharedFactory(shared => new DefaultFileSystemProvider(shared))
           }
         : { connection: composed.serverConnection },
      options
   );
   startLanguageServer(services.shared);
   describeDocuments = () => {
      const store = services.shared.workspace.TextDocuments;
      const documents = services.shared.workspace.LangiumDocuments;
      return JSON.stringify(
         store.all().map(document => ({
            uri: document.uri,
            version: document.version,
            languageClientBehind: store.isLanguageClientBehind(document.uri, document.version),
            buildState: documents.getDocument(URI.parse(document.uri))?.state
         }))
      );
   };
   await composed.initialize(on ? { workspaceFolders: [{ uri: on.workspace.uri(), name: 'order-flow' }] } : undefined);
   await services.shared.workspace.WorkspaceManager.workspaceInitialized;
   return { composed, shared: services.shared, process: services.Process };
}

/** Rejects a wait that {@link bounded} gave up on; {@link outcome} rethrows it rather than reporting it as an answer. */
class NotSettled extends Error {}

/** `work`, or a rejection naming `what` and the documents' state when it is not settled in time. */
async function bounded<T>(what: string, work: Promise<T>): Promise<T> {
   let timer: NodeJS.Timeout | undefined;
   const timedOut = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
         () => reject(new NotSettled(`${what} not settled after ${ANSWER_TIMEOUT_MS} ms; documents: ${describeDocuments()}`)),
         ANSWER_TIMEOUT_MS
      );
   });
   try {
      return await Promise.race([work, timedOut]);
   } finally {
      clearTimeout(timer);
   }
}

function request<R>(composed: LspServerConnection, method: string, params: object): Promise<R> {
   return bounded(method, composed.client.sendRequest<R>(method, params));
}

/** The code of the response error `request` rejects with, or `'answered'` when it resolves. */
async function outcome(request: Promise<unknown>): Promise<unknown> {
   try {
      await request;
      return 'answered';
   } catch (error: unknown) {
      if (error instanceof NotSettled) {
         throw error;
      }
      return (error as { code?: unknown }).code ?? error;
   }
}

/** Write `text` to `uri` as a form does, and wait until its push reaches the editor, which does not apply it yet. */
async function writeFromForm(composed: LspServerConnection, shared: OrderFlowSharedServices, uri: string, text: string): Promise<void> {
   const session = shared.model.ModelService.createSession('form', 'form');
   await bounded('the form session open', session.open(uri));
   const pushed = composed.nextAppliedEdit(uri);
   await bounded('the form update', session.update({ uri, model: text, baseVersion: 'any' }));
   await pushed;
}

/**
 * Starts a form session's `write`. `landed` resolves once it changes `uri` in the store, and rejects with the
 * write's failure should it fail first.
 */
function changedByForm<T>(
   shared: OrderFlowSharedServices,
   uri: string,
   write: () => Promise<T>
): { landed: Promise<void>; written: Promise<T> } {
   const changed = new Deferred();
   const listener = shared.workspace.TextDocuments.onDidChangeContent(event => {
      if (event.document.uri === uri && event.clientId === 'form') {
         changed.resolve();
      }
   });
   const written = write();
   const landed = Promise.race([changed.promise, written.then(() => changed.promise)]).finally(() => listener.dispose());
   return { landed, written };
}

const position = { line: 1, character: 9 };
/** A read-hold limit short enough that a build a request holds off starts during the test. */
const SHORT_READ_HOLD_LIMIT: OrderFlowOptions = {
   extraSharedModules: [
      { workspace: { WorkspaceLock: (services: OrderFlowSharedServices) => new HydraniumWorkspaceLock(services, { readHoldLimitMs: 50 }) } }
   ]
};
const options = { tabSize: 3, insertSpaces: true };

describe('order-flow edit requests over the real transport', () => {
   it('answer `ContentModified` until the editor echoes the push of a form write', async () => {
      const { composed, shared } = await composeServer();
      composed.openDocument(PROCESS_URI, OPENED, 'order-flow-process', 1);
      const textDocument = { uri: PROCESS_URI };
      const requests = (): Promise<Record<string, unknown>> =>
         Promise.all([
            outcome(request(composed, 'textDocument/formatting', { textDocument, options })),
            outcome(
               request(composed, 'textDocument/rangeFormatting', {
                  textDocument,
                  options,
                  range: { start: { line: 0, character: 0 }, end: { line: 4, character: 0 } }
               })
            ),
            outcome(request(composed, 'textDocument/rename', { textDocument, position, newName: 'Renamed' })),
            outcome(request(composed, 'textDocument/completion', { textDocument, position })),
            outcome(
               request(composed, 'textDocument/codeAction', {
                  textDocument,
                  range: { start: position, end: position },
                  context: { diagnostics: [] }
               })
            ),
            outcome(request(composed, 'textDocument/onTypeFormatting', { textDocument, position, ch: '\n', options })),
            outcome(request(composed, 'textDocument/hover', { textDocument, position }))
         ]).then(([formatting, rangeFormatting, rename, completion, codeAction, onTypeFormatting, hover]) => ({
            formatting,
            rangeFormatting,
            onTypeFormatting,
            rename,
            completion,
            codeAction,
            hover
         }));
      const opened = await requests();

      await writeFromForm(composed, shared, PROCESS_URI, WRITTEN);
      const inFlight = await requests();

      composed.changeDocument(PROCESS_URI, WRITTEN, 2);
      const echoed = await requests();

      const answered = {
         formatting: 'answered',
         rangeFormatting: 'answered',
         onTypeFormatting: 'answered',
         rename: 'answered',
         completion: 'answered',
         codeAction: 'answered',
         hover: 'answered'
      };
      const refused = LSPErrorCodes.ContentModified;
      expect({ opened, inFlight, echoed }).toEqual({
         opened: answered,
         inFlight: {
            formatting: refused,
            rangeFormatting: refused,
            onTypeFormatting: refused,
            rename: refused,
            completion: refused,
            codeAction: refused,
            hover: 'answered'
         },
         echoed: answered
      });
   });

   it('answer `ContentModified` to a rename that edits another document whose editor is behind', async () => {
      const { composed, shared } = await composeServer();
      composed.openDocument(DOMAIN_URI, DOMAIN, 'order-flow-domain', 1);
      composed.openDocument(PROCESS_URI, OPENED, 'order-flow-process', 1);
      // On `Crate` in the process, which the domain declares.
      const rename = (): Promise<WorkspaceEdit | null> =>
         request(composed, 'textDocument/rename', {
            textDocument: { uri: PROCESS_URI },
            position: { line: 0, character: 23 },
            newName: 'Box'
         });
      const opened = Object.keys((await rename())?.changes ?? {}).sort();

      await writeFromForm(composed, shared, DOMAIN_URI, DOMAIN_WRITTEN);
      const inFlight = await outcome(rename());

      composed.changeDocument(DOMAIN_URI, DOMAIN_WRITTEN, 2);
      const echoed = await outcome(rename());

      expect({ opened, inFlight, echoed }).toEqual({
         opened: [DOMAIN_URI, PROCESS_URI].sort(),
         inFlight: LSPErrorCodes.ContentModified,
         echoed: 'answered'
      });
   });

   it('answer `ContentModified` to a code action that edits another document whose editor is behind', async () => {
      const edit: WorkspaceEdit = {
         documentChanges: [
            {
               textDocument: { uri: PROCESS_URI, version: null },
               edits: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, newText: '' }]
            }
         ]
      };
      const { composed, shared } = await composeServer({
         extraLanguageModules: [
            { lsp: { CodeActionProvider: () => ({ getCodeActions: (): CodeAction[] => [{ title: 'Edit the process', edit }] }) } }
         ]
      });
      composed.openDocument(DOMAIN_URI, DOMAIN, 'order-flow-domain', 1);
      composed.openDocument(PROCESS_URI, OPENED, 'order-flow-process', 1);
      const codeAction = (): Promise<unknown> =>
         outcome(
            request(composed, 'textDocument/codeAction', {
               textDocument: { uri: DOMAIN_URI },
               range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
               context: { diagnostics: [] }
            })
         );
      const opened = await codeAction();

      await writeFromForm(composed, shared, PROCESS_URI, WRITTEN);
      const inFlight = await codeAction();

      composed.changeDocument(PROCESS_URI, WRITTEN, 2);
      const echoed = await codeAction();

      expect({ opened, inFlight, echoed }).toEqual({ opened: 'answered', inFlight: LSPErrorCodes.ContentModified, echoed: 'answered' });
   });

   it('answer `ContentModified` to a rename requested while the editor was behind, after it echoes', async () => {
      const { composed, shared, process } = await composeServer();
      composed.openDocument(PROCESS_URI, OPENED, 'order-flow-process', 1);
      const renameProvider = process.lsp.RenameProvider!;
      const rename = renameProvider.rename.bind(renameProvider);
      const gate = new Deferred();
      renameProvider.rename = async (document, params, cancelToken) => {
         const edit = await rename(document, params, cancelToken);
         await gate.promise;
         return edit;
      };
      // Answered after the open, so the form attaches to the editor's text.
      await request(composed, 'textDocument/hover', { textDocument: { uri: PROCESS_URI }, position });
      await writeFromForm(composed, shared, PROCESS_URI, WRITTEN);

      // On `Inspect` in the editor's text, where the store's has `Ship`.
      const renamed = outcome(
         composed.client.sendRequest('textDocument/rename', { textDocument: { uri: PROCESS_URI }, position, newName: 'Renamed' })
      );
      composed.changeDocument(PROCESS_URI, WRITTEN, 2);
      // Answered after the echo, which the server handles in order.
      await request(composed, 'textDocument/hover', { textDocument: { uri: PROCESS_URI }, position });
      gate.resolve();

      expect(await bounded('textDocument/rename', renamed)).toBe(LSPErrorCodes.ContentModified);
   });

   it.each([
      ['refuse a code action that edits a closed document rebuilt while it is computed', true, LSPErrorCodes.ContentModified],
      ['answer a code action that edits a closed document left alone', false, 'answered']
   ] as const)('%s', async (_title, rebuild, expected) => {
      workspace = makeScratchWorkspace({ prefix: 'order-flow-edit-requests-' });
      workspace.write('closed.domain', DOMAIN);
      workspace.write('open.process', OPENED);
      const closedUri = workspace.uri('closed.domain');
      const openUri = workspace.uri('open.process');
      const computed = new Deferred();
      const gate = new Deferred();
      const edit: WorkspaceEdit = {
         changes: { [closedUri]: [{ range: { start: { line: 1, character: 3 }, end: { line: 1, character: 4 } }, newText: 'z' }] }
      };
      // Computes, then awaits, as a provider awaiting I/O does.
      const getCodeActions = async (): Promise<CodeAction[]> => {
         computed.resolve();
         await gate.promise;
         return [{ title: 'Edit the closed document', edit }];
      };
      const { composed, shared } = await composeServer(
         { extraLanguageModules: [{ lsp: { CodeActionProvider: () => ({ getCodeActions }) } }] },
         { workspace }
      );
      composed.openDocument(openUri, OPENED, 'order-flow-process', 1);
      const codeAction = outcome(
         composed.client.sendRequest('textDocument/codeAction', {
            textDocument: { uri: openUri },
            range: { start: position, end: position },
            context: { diagnostics: [] }
         })
      );
      await bounded('the provider call', computed.promise);

      if (rebuild) {
         workspace.write('closed.domain', DOMAIN_WRITTEN);
         await bounded('the rebuild', shared.workspace.DocumentBuilder.update([URI.parse(closedUri)], []));
      }
      gate.resolve();

      expect(await bounded('textDocument/codeAction', codeAction)).toBe(expected);
   });

   it('refuse a code action that edits a document another client saved, and the editor closed and reopened, while it is computed', async () => {
      workspace = makeScratchWorkspace({ prefix: 'order-flow-edit-requests-' });
      workspace.write('edited.process', OPENED);
      workspace.write('asked.domain', DOMAIN);
      const editedUri = workspace.uri('edited.process');
      const askedUri = workspace.uri('asked.domain');
      const computed = new Deferred();
      const gate = new Deferred();
      // Renames `Inspect` where the opened text has it, which the write shifts.
      const edit: WorkspaceEdit = {
         changes: { [editedUri]: [{ range: { start: { line: 1, character: 8 }, end: { line: 1, character: 15 } }, newText: 'Renamed' }] }
      };
      const getCodeActions = async (): Promise<CodeAction[]> => {
         computed.resolve();
         await gate.promise;
         return [{ title: 'Rename the task', edit }];
      };
      const { composed, shared } = await composeServer(
         { extraLanguageModules: [{ lsp: { CodeActionProvider: () => ({ getCodeActions }) } }] },
         { workspace }
      );
      composed.openDocument(askedUri, DOMAIN, 'order-flow-domain', 1);
      composed.openDocument(editedUri, OPENED, 'order-flow-process', 1);
      // Answered after the opens, so the form attaches to the editor's text.
      await request(composed, 'textDocument/hover', { textDocument: { uri: editedUri }, position });
      const codeAction = outcome(
         composed.client.sendRequest('textDocument/codeAction', {
            textDocument: { uri: askedUri },
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
            context: { diagnostics: [] }
         })
      );
      await bounded('the provider call', computed.promise);

      const session = shared.model.ModelService.createSession('form', 'form');
      await bounded('the form session open', session.open(editedUri));
      // Its build waits for the code action.
      const { landed, written: saved } = changedByForm(shared, editedUri, () =>
         session.save({ uri: editedUri, model: WRITTEN, baseVersion: 'any' })
      );
      await bounded('the form save in the store', landed);
      await composed.closeDocument(editedUri);
      composed.openDocument(editedUri, WRITTEN, 'order-flow-process', 1);
      // Answered after the reopen, which the server handles in order.
      await request(composed, 'textDocument/hover', { textDocument: { uri: editedUri }, position });
      gate.resolve();

      expect(await bounded('textDocument/codeAction', codeAction)).toBe(LSPErrorCodes.ContentModified);
      await bounded('the form save', saved);
      await bounded('the form session close', session.close(editedUri));
   });

   it.each([
      [
         'refuse a format computed while a form write lands in the store',
         LSPErrorCodes.ContentModified,
         async (_composed: LspServerConnection, shared: OrderFlowSharedServices) => {
            const session = shared.model.ModelService.createSession('form', 'form');
            await bounded('the form session open', session.open(PROCESS_URI));
            // Its build, and so its push to the editor, waits for the format.
            const { landed, written: updated } = changedByForm(shared, PROCESS_URI, () =>
               session.update({ uri: PROCESS_URI, model: OPENED, baseVersion: 'any' })
            );
            await bounded('the form write in the store', landed);
            return { settled: updated };
         },
         undefined
      ],
      [
         'refuse a format computed before a form write the editor has echoed, once the read-hold limit starts its build',
         LSPErrorCodes.ContentModified,
         async (composed: LspServerConnection, shared: OrderFlowSharedServices) => {
            await writeFromForm(composed, shared, PROCESS_URI, OPENED);
            composed.changeDocument(PROCESS_URI, OPENED, 2);
            return { settled: Promise.resolve() };
         },
         SHORT_READ_HOLD_LIMIT
      ],
      [
         'answer a format computed before the editor typed',
         'answered',
         async (composed: LspServerConnection) => {
            composed.changeDocument(PROCESS_URI, `${WRITTEN}\n`, 2);
            return { settled: Promise.resolve() };
         },
         undefined
      ]
   ] as const)('%s', async (_title, expected, change, composition) => {
      const { composed, shared, process } = await composeServer(composition);
      composed.openDocument(PROCESS_URI, WRITTEN, 'order-flow-process', 1);
      const formatter = process.lsp.Formatter!;
      const format = formatter.formatDocument.bind(formatter);
      const computed = new Deferred();
      const gate = new Deferred();
      // Computes, then awaits, as a provider awaiting I/O does.
      formatter.formatDocument = async (document, params) => {
         const edits = await format(document, params);
         computed.resolve();
         await gate.promise;
         return edits;
      };
      const formatting = outcome(composed.client.sendRequest('textDocument/formatting', { textDocument: { uri: PROCESS_URI }, options }));
      await bounded('the provider call', computed.promise);

      const { settled } = await change(composed, shared);
      // Answered after the change, which the server handles in order.
      await request(composed, 'textDocument/hover', { textDocument: { uri: PROCESS_URI }, position });
      gate.resolve();

      expect(await bounded('textDocument/formatting', formatting)).toBe(expected);
      await bounded<unknown>('the change', settled);
   });
});
