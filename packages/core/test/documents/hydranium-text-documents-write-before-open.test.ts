/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, expect, it } from 'vitest';
import {
   type ApplyWorkspaceEditParams,
   type ApplyWorkspaceEditResult,
   Range,
   type TextDocumentEdit,
   type TextDocumentContentChangeEvent,
   TextEdit
} from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { LANGUAGE_CLIENT_ID } from '../../src/documents/client-ids.js';
import { DefaultDocumentReleaseHandler } from '../../src/documents/document-release-handler.js';
import { HydraniumTextDocuments } from '../../src/documents/hydranium-text-documents.js';
import { diffToEdits } from '../../src/documents/language-client-shadow.js';
import type { ServerSharedServices } from '../../src/langium/module.js';
import { DefaultDocumentUriPolicy } from '../../src/langium/workspace/document-uri-policy.js';
import { type CapturedLine, makeCapturingTracer, makeStubDocumentBuilder, makeStubLangiumDocuments } from '../../src/testing/index.js';

const URI = 'file:///a.x';
const DISK = 'a\nb\nc\n';
const WRITTEN = 'a\nb\nc\nd\n';
const NEXT = 'a\nb\nc\nd\ne\n';

/**
 * A language client as LSP lets one behave: it writes an edit to a URI it
 * holds no buffer for to the file, refuses a versioned edit to a buffer at
 * another version, steps its version once per applied edit, and echoes each
 * applied edit as a `didChange` whose ranges address its own buffer.
 */
class FakeEditor {
   readonly disk = new Map<string, string>([[URI, DISK]]);
   protected readonly buffers = new Map<string, TextDocument>();

   constructor(protected readonly docs: HydraniumTextDocuments<TextDocument>) {}

   open(uri: string): void {
      const text = this.disk.get(uri) ?? '';
      this.buffers.set(uri, TextDocument.create(uri, 'plaintext', 1, text));
      this.docs.notifyDidOpenTextDocument({ textDocument: { uri, languageId: 'plaintext', version: 1, text } }, LANGUAGE_CLIENT_ID);
   }

   type(uri: string, change: TextDocumentContentChangeEvent): void {
      const buffer = this.bufferOf(uri);
      const version = buffer.version + 1;
      TextDocument.update(buffer, [change], version);
      this.docs.notifyDidChangeTextDocument({ textDocument: { uri, version }, contentChanges: [change] }, LANGUAGE_CLIENT_ID);
   }

   text(uri: string): string | undefined {
      return this.buffers.get(uri)?.getText();
   }

   async applyEdit(params: ApplyWorkspaceEditParams): Promise<ApplyWorkspaceEditResult> {
      const change = params.edit.documentChanges![0] as TextDocumentEdit;
      const { uri, version } = change.textDocument;
      const buffer = this.buffers.get(uri);
      const edits = change.edits.filter(TextEdit.is);
      if (edits.length !== change.edits.length) {
         return { applied: false };
      }
      if (!buffer) {
         const file = TextDocument.create(uri, 'plaintext', 0, this.disk.get(uri) ?? '');
         this.disk.set(uri, TextDocument.applyEdits(file, edits));
         return { applied: true };
      }
      if (version !== null && version !== buffer.version) {
         return { applied: false };
      }
      const before = buffer.getText();
      const after = TextDocument.applyEdits(buffer, edits);
      const next = TextDocument.create(uri, 'plaintext', buffer.version + 1, after);
      this.buffers.set(uri, next);
      // Bottom-up, so each change addresses the buffer the previous one left.
      const ranged = diffToEdits(before, after)
         .reverse()
         .map(edit => ({ range: edit.range, text: edit.newText }));
      this.docs.notifyDidChangeTextDocument({ textDocument: { uri, version: next.version }, contentChanges: ranged }, LANGUAGE_CLIENT_ID);
      return { applied: true };
   }

   protected bufferOf(uri: string): TextDocument {
      const buffer = this.buffers.get(uri);
      if (!buffer) {
         throw new Error(`No buffer for ${uri}`);
      }
      return buffer;
   }
}

function makeStore(): {
   docs: HydraniumTextDocuments<TextDocument>;
   editor: FakeEditor;
   pushes: ApplyWorkspaceEditParams[];
   lines: CapturedLine[];
} {
   const { tracer, lines } = makeCapturingTracer();
   const pushes: ApplyWorkspaceEditParams[] = [];
   const services = {
      lsp: {
         Connection: { workspace: { applyEdit: (params: ApplyWorkspaceEditParams) => (pushes.push(params), editor.applyEdit(params)) } }
      },
      Tracer: { for: () => tracer },
      workspace: {
         DocumentUriPolicy: new DefaultDocumentUriPolicy(),
         LangiumDocuments: makeStubLangiumDocuments(),
         DocumentBuilder: makeStubDocumentBuilder(),
         // The revert's fallback build is not under test here.
         VersionSyncService: { requestRecoveryBuild: async () => true, onDidRecordModel: () => ({ dispose: () => undefined }) },
         WorkspaceManager: { workspaceInitialized: Promise.resolve() }
      }
   } as unknown as ServerSharedServices;
   services.workspace.DocumentReleaseHandler = new DefaultDocumentReleaseHandler(services);
   const docs = new HydraniumTextDocuments<TextDocument>(services);
   const editor = new FakeEditor(docs);
   return { docs, editor, pushes, lines };
}

/** A server-side write and its push, retried once as a full replace after a refusal, as the model service does. */
async function write(docs: HydraniumTextDocuments<TextDocument>, text: string): Promise<void> {
   if (docs.get(URI)) {
      docs.applyContentChange(URI, text, 'form-client');
   }
   const result = await docs.applyEditToLanguageClient(URI, text);
   if (result?.applied === false) {
      await docs.applyEditToLanguageClient(URI, text);
   }
}

/**
 * Write `WRITTEN` while the editor has not opened the document: either another
 * client holds it, or the push comes after its release, which the model
 * service's coalesced sync does when the editor closes the document meanwhile.
 */
async function writeBeforeOpen(docs: HydraniumTextDocuments<TextDocument>, holder: 'held' | 'released'): Promise<void> {
   docs.notifyDidOpenTextDocument({ textDocument: { uri: URI, languageId: 'plaintext', version: 1, text: DISK } }, 'form-client');
   if (holder === 'held') {
      await write(docs, WRITTEN);
      return;
   }
   docs.applyContentChange(URI, WRITTEN, 'form-client');
   docs.notifyDidCloseTextDocument({ textDocument: { uri: URI } }, 'form-client');
   expect(docs.get(URI)).toBeUndefined();
   await docs.applyEditToLanguageClient(URI, WRITTEN);
}

describe('HydraniumTextDocuments — a write while the editor has not opened the document', () => {
   for (const [holderName, holder] of [
      ['another client holds the document', 'held'],
      ['the document was released', 'released']
   ] as const) {
      it(`sends the editor nothing when ${holderName}`, async () => {
         const { docs, pushes } = makeStore();
         await writeBeforeOpen(docs, holder);
         expect(pushes).toEqual([]);
      });

      it(`diffs the next push against the text the editor opens with when ${holderName}`, async () => {
         const { docs, editor } = makeStore();
         await writeBeforeOpen(docs, holder);
         // The file is reverted on disk before the editor opens it.
         editor.disk.set(URI, DISK);
         editor.open(URI);

         await write(docs, NEXT);

         expect({ editor: editor.text(URI), store: docs.get(URI)?.getText() }).toEqual({ editor: NEXT, store: NEXT });
      });
   }

   it('keeps a keystroke the editor makes in a document it opens afterwards', async () => {
      const { docs, editor, lines } = makeStore();
      await writeBeforeOpen(docs, 'released');
      // The file is reverted on disk before the editor opens it.
      editor.disk.set(URI, DISK);
      editor.open(URI);

      editor.type(URI, { range: Range.create(3, 0, 3, 0), text: 'x\n' });

      expect(docs.get(URI)?.getText()).toBe('a\nb\nc\nx\n');
      expect(lines.filter(line => line.level === 'warn')).toEqual([]);
   });
});

describe('HydraniumTextDocuments — a seeded language-client text', () => {
   for (const [name, otherHolder] of [
      ['the store opens the document with the editor', false],
      ['the editor joins another client', true]
   ] as const) {
      it(`gives way to the text the editor opens with when ${name}`, async () => {
         const { docs, editor } = makeStore();
         if (otherHolder) {
            docs.notifyDidOpenTextDocument({ textDocument: { uri: URI, languageId: 'plaintext', version: 1, text: DISK } }, 'form-client');
         }
         docs.setLanguageClientText(URI, 'seeded\n');
         editor.open(URI);

         await write(docs, NEXT);

         expect(editor.text(URI)).toBe(NEXT);
      });
   }
});
