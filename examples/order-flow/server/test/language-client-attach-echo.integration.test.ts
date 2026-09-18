/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * A language client attaching to a document another client has already written,
 * driven over the REAL transport rather than against the text store.
 *
 * The sequence needs two clients on one tree: a diagram writes a document the
 * editor has not opened, and the editor then opens it from disk. Its buffer is
 * therefore the text the write already superseded, and every incremental range
 * it sends addresses that buffer rather than the server's copy. `@hydranium/core`
 * covers the store's half in isolation; what this adds is the wire — an outbound
 * `workspace/applyEdit`, a client that answers it, and a `didChange` carrying
 * ranges instead of full text.
 *
 * **The echo is deliberately NOT the ranges the server sent.** A host may
 * minimise a coarse edit against its own buffer before applying it — Theia routes
 * every workspace edit through `computeMoreMinimalEdits` — so a full-document
 * replace comes back as small ranges keyed to the text the client held. An echo
 * that replayed the received edit reconstructs identically under any baseline,
 * and would pass whatever the server did with it.
 */

import { makeLspServerConnection, type LspServerConnection } from '@hydranium/core/testing/node';
import { startLanguageServer } from '@hydranium/core/lsp';
import { afterEach, describe, expect, it } from 'vitest';
import { DidChangeTextDocumentNotification } from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { createOrderFlowServices, type OrderFlowSharedServices } from '../src/language-server/order-flow-module.js';

const PROCESS_LANGUAGE_ID = 'order-flow-process';
const URI = 'file:///attach-echo.process';

/** What the editor opens: the file as its author left it, comments and all. */
const ON_DISK = `// a note a serializer cannot carry
// and a second line of it
process Handling for Crate {
   task Inspect
   task Ship
}
`;

/** What the diagram wrote: re-serialized from the AST, so the notes are gone. */
const AUTHORED = `process Handling for Crate {
   task Inspect
   task Dispatch
}
`;

/**
 * The `didChange` a host sends after minimising {@link ON_DISK} → {@link AUTHORED}
 * against its own buffer: one hunk dropping the notes, one replacing the renamed
 * task, ordered descending so applying them in sequence is correct.
 */
const MINIMISED_ECHO = [
   { range: { start: { line: 4, character: 0 }, end: { line: 5, character: 0 } }, text: '   task Dispatch\n' },
   { range: { start: { line: 0, character: 0 }, end: { line: 2, character: 0 } }, text: '' }
];

let transport: LspServerConnection | undefined;

afterEach(() => {
   transport?.dispose();
   transport = undefined;
});

/**
 * Stand the server up the way `main.ts` does, and wait for the workspace gate.
 *
 * `initialize()` resolves the request, not the workspace build that the
 * `initialized` notification starts — and inbound `didOpen` notifications wait on
 * that build. A write issued before it lands therefore races a gate the editor's
 * open is queued behind, and the attach silently never registers.
 */
async function composeServer(): Promise<{ composed: LspServerConnection; shared: OrderFlowSharedServices }> {
   const composed = makeLspServerConnection();
   transport = composed;
   const services = createOrderFlowServices({ connection: composed.serverConnection });
   startLanguageServer(services.shared);
   await composed.initialize();
   await services.shared.workspace.WorkspaceManager.workspaceInitialized;
   return { composed, shared: services.shared };
}

describe('order-flow language-client attach over the real transport', () => {
   it('the fixture echo carries a client holding the disk text to the authored text', () => {
      // Guards the discriminator, not the server: an echo that does not
      // reconstruct the authored text from the client's own buffer would let the
      // test below pass for the wrong reason.
      const heldByClient = TextDocument.create(URI, PROCESS_LANGUAGE_ID, 1, ON_DISK);
      expect(TextDocument.update(heldByClient, MINIMISED_ECHO, 2).getText()).toBe(AUTHORED);
   });

   it('keeps the authored text when the attaching client echoes a minimised push', async () => {
      const { composed, shared } = await composeServer();

      // A non-LSP client writes a document the editor has not opened. `update` is
      // an upsert, so no file has to exist for the store to hold this.
      await shared.model.ModelService.update({ uri: URI, model: AUTHORED, clientId: 'diagram' });

      // The editor opens the same URI from disk, which is now the older text. The
      // server notices the two disagree and pushes, which is what the client is
      // about to echo.
      const pushed = composed.nextAppliedEdit(URI);
      composed.openDocument(URI, ON_DISK, PROCESS_LANGUAGE_ID);
      await pushed;

      composed.client.sendNotification(DidChangeTextDocumentNotification.type, {
         textDocument: { uri: URI, version: 2 },
         contentChanges: MINIMISED_ECHO
      });
      // A notification is one-way, so the assertion has to outlast its delivery:
      // read synchronously and the server has not seen the change yet, which
      // passes whatever it would have done with it. A round trip the server can
      // only answer after handling the queued notification is the ordering
      // guarantee; its own answer is not the subject.
      await composed.hover(URI, { line: 0, character: 0 });

      expect(shared.workspace.TextDocuments.get(URI)?.getText()).toBe(AUTHORED);
   });
});
