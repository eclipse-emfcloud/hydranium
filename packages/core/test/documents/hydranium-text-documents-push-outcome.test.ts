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
   type Position,
   Range,
   type TextDocumentEdit,
   TextEdit
} from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { LANGUAGE_CLIENT_ID } from '../../src/documents/client-ids.js';
import { DefaultDocumentReleaseHandler } from '../../src/documents/document-release-handler.js';
import { HydraniumTextDocuments } from '../../src/documents/hydranium-text-documents.js';
import type { ServerSharedServices } from '../../src/langium/module.js';
import { DefaultDocumentUriPolicy } from '../../src/langium/workspace/document-uri-policy.js';
import { makeCapturingTracer, makeStubDocumentBuilder, makeStubLangiumDocuments } from '../../src/testing/index.js';

const URI = 'file:///a.x';
const DISK = 'l1\nl2\nl3\n';
/** What the editor holds once the setup's keystroke is heard, at version 2. */
const TYPED = 'l1\nl2\nl3\nl4\n';
const WRITTEN = 'l0\nl1\nl2\nl3\nl4\n';

type Order = 'echo-first' | 'reply-first';

interface PushRequest {
   readonly params: ApplyWorkspaceEditParams;
   readonly resolve: (result: ApplyWorkspaceEditResult) => void;
   readonly reject: (err: Error) => void;
}

const flush = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));

/**
 * An editor buffer behind an LSP client, as Monaco is one: a new document per
 * edit, a version step per applied edit, a versioned edit refused once the
 * buffer has moved past its version, and each applied edit echoed with its
 * ranges clamped to the buffer, last range first. A full replace therefore
 * echoes as a ranged change covering the old buffer. A push waits until the
 * test answers it, so the test decides what reaches the store meanwhile.
 */
class Editor {
   protected buffer: TextDocument | undefined;
   protected readonly requests: PushRequest[] = [];

   constructor(
      protected readonly docs: HydraniumTextDocuments<TextDocument>,
      readonly uri: string
   ) {}

   get text(): string | undefined {
      return this.buffer?.getText();
   }

   open(text: string): void {
      this.buffer = TextDocument.create(this.uri, 'plaintext', 1, text);
      this.docs.notifyDidOpenTextDocument(
         { textDocument: { uri: this.uri, languageId: 'plaintext', version: 1, text } },
         LANGUAGE_CLIENT_ID
      );
   }

   close(): void {
      this.buffer = undefined;
      this.docs.notifyDidCloseTextDocument({ textDocument: { uri: this.uri } }, LANGUAGE_CLIENT_ID);
   }

   /** A keystroke; its `didChange` reaches the store before anything the editor sends later. */
   type(range: Range, text: string): void {
      this.edit([{ range, newText: text }])();
   }

   applyEdit(params: ApplyWorkspaceEditParams): Promise<ApplyWorkspaceEditResult> {
      return new Promise((resolve, reject) => this.requests.push({ params, resolve, reject }));
   }

   /** Whether a push waits for an answer, once the store has had its turn. */
   async hasPush(): Promise<boolean> {
      await flush();
      return this.requests.length > 0;
   }

   /**
    * Answer the oldest push. An applied one's echo reaches the store before the
    * reply or after it, as `order` says, and `afterEcho` runs once the echo is
    * delivered: the editor sends nothing about a later change before the echo.
    * `'apply-then-fail'` applies the push and answers with an error, as a reply
    * lost after the edit landed does.
    */
   async answer(
      answer: 'apply' | 'apply-then-fail' | 'refuse' | 'fail',
      order: Order = 'echo-first',
      afterEcho?: () => void
   ): Promise<void> {
      await flush();
      const request = this.requests.shift();
      if (!request) {
         throw new Error(`No push to ${this.uri} to answer`);
      }
      const change = request.params.edit.documentChanges![0] as TextDocumentEdit;
      const { version } = change.textDocument;
      if (answer === 'fail') {
         request.reject(new Error('connection lost'));
      } else if (answer === 'refuse' || !this.buffer || (version !== null && version !== this.buffer.version)) {
         request.resolve({ applied: false });
      } else {
         const echo = this.edit(change.edits.filter(TextEdit.is));
         const reply = (): void =>
            answer === 'apply-then-fail' ? request.reject(new Error('connection lost')) : request.resolve({ applied: true });
         if (order === 'echo-first') {
            echo();
            afterEcho?.();
            reply();
         } else {
            reply();
            await flush();
            echo();
            afterEcho?.();
         }
      }
      await flush();
   }

   /** Apply `edits` to a new buffer, returning the delivery of their echo. */
   protected edit(edits: TextEdit[]): () => void {
      const buffer = this.buffer!;
      const clamp = (position: Position): Position => buffer.positionAt(buffer.offsetAt(position));
      const changes = [...edits]
         .sort((left, right) => buffer.offsetAt(right.range.start) - buffer.offsetAt(left.range.start))
         .map(edit => ({ range: Range.create(clamp(edit.range.start), clamp(edit.range.end)), text: edit.newText }));
      const version = buffer.version + 1;
      this.buffer = TextDocument.update(TextDocument.create(this.uri, 'plaintext', buffer.version, buffer.getText()), changes, version);
      const { uri, docs } = this;
      return () => docs.notifyDidChangeTextDocument({ textDocument: { uri, version }, contentChanges: changes }, LANGUAGE_CLIENT_ID);
   }
}

function makeStore(uriPolicy: unknown = new DefaultDocumentUriPolicy()): {
   docs: HydraniumTextDocuments<TextDocument>;
   editorAt: (uri: string) => Editor;
   pushes: ApplyWorkspaceEditParams[];
} {
   const { tracer } = makeCapturingTracer();
   const pushes: ApplyWorkspaceEditParams[] = [];
   const editors = new Map<string, Editor>();
   const applyEdit = (params: ApplyWorkspaceEditParams): Promise<ApplyWorkspaceEditResult> => {
      pushes.push(params);
      const { uri } = (params.edit.documentChanges![0] as TextDocumentEdit).textDocument;
      return editors.get(uri)!.applyEdit(params);
   };
   const services = {
      lsp: { Connection: { workspace: { applyEdit } } },
      Tracer: { for: () => tracer },
      workspace: {
         DocumentUriPolicy: uriPolicy,
         LangiumDocuments: makeStubLangiumDocuments(),
         DocumentBuilder: makeStubDocumentBuilder(),
         // The revert's fallback build is not under test here.
         VersionSyncService: { requestRecoveryBuild: async () => true, onDidRecordModel: () => ({ dispose: () => undefined }) },
         WorkspaceManager: { workspaceInitialized: Promise.resolve() }
      }
   } as unknown as ServerSharedServices;
   services.workspace.DocumentReleaseHandler = new DefaultDocumentReleaseHandler(services);
   const docs = new HydraniumTextDocuments<TextDocument>(services);
   const editorAt = (uri: string): Editor => {
      const editor = new Editor(docs, uri);
      editors.set(uri, editor);
      return editor;
   };
   return { docs, editorAt, pushes };
}

/** How a caller retries a refused push. */
interface RetryPolicy {
   /** `'held'` retries once while the store still holds the text, as the model service does; `'always'` retries once regardless. */
   retry: 'held' | 'always';
}

/** The push of a settled text, retried as `policy` says when it is refused; a failed push is dropped. */
async function sync(docs: HydraniumTextDocuments<TextDocument>, text: string, policy: RetryPolicy = { retry: 'held' }): Promise<void> {
   try {
      const result = await docs.applyEditToLanguageClient(URI, text);
      if (result?.applied === false && (policy.retry === 'always' || docs.get(URI)?.getText() === text)) {
         await docs.applyEditToLanguageClient(URI, text);
      }
   } catch {
      // The model service logs a failed push and moves on.
   }
}

interface Scenario {
   readonly name: string;
   /** Drive the push of {@link WRITTEN}, in flight as `pushed`, to its end. */
   readonly run: (context: {
      docs: HydraniumTextDocuments<TextDocument>;
      editor: Editor;
      order: Order;
      pushed: RetryPolicy;
   }) => Promise<void>;
}

const shortening = Range.create(3, 0, 4, 0);
const lengthening = Range.create(4, 0, 4, 0);

const scenarios: Scenario[] = [
   {
      name: 'the editor applies it',
      run: async ({ editor, order }) => editor.answer('apply', order)
   },
   {
      name: 'the editor applies it and a keystroke follows its echo',
      run: async ({ editor, order }) => editor.answer('apply', order, () => editor.type(lengthening, 'l5\n'))
   },
   {
      name: 'the store writes its text back before the echo',
      run: async ({ docs, editor, order }) => {
         docs.applyContentChange(URI, TYPED, 'form-client');
         await editor.answer('apply', order);
         // The echo is of a write the store has since undone.
         expect(docs.get(URI)?.getText()).toBe(TYPED);
      }
   },
   {
      name: 'a heard keystroke makes the editor refuse it',
      run: async ({ editor, order }) => {
         editor.type(lengthening, 'l5\n');
         await editor.answer('apply', order);
      }
   },
   {
      name: 'the editor refuses it for a reason of its own',
      run: async ({ editor, order }) => {
         await editor.answer('refuse');
         await editor.answer('apply', order);
      }
   },
   {
      name: 'the editor refuses it and a keystroke shortens the buffer while the retry is in flight',
      run: async ({ editor, order }) => {
         await editor.answer('refuse');
         editor.type(shortening, '');
         await editor.answer('apply', order);
      }
   },
   {
      name: 'the editor refuses it and a keystroke lengthens the buffer while the retry is in flight',
      run: async ({ editor, order }) => {
         await editor.answer('refuse');
         editor.type(lengthening, 'l5\n');
         await editor.answer('apply', order);
      }
   },
   {
      name: 'a heard keystroke makes the editor refuse it, and the caller retries anyway while another keystroke lands',
      run: async ({ editor, order, pushed }) => {
         pushed.retry = 'always';
         editor.type(lengthening, 'l5\n');
         await editor.answer('apply', order);
         editor.type(shortening, '');
         await editor.answer('apply', order);
      }
   },
   {
      name: 'the editor closes and reopens the document before refusing it',
      run: async ({ editor }) => {
         editor.close();
         editor.open(DISK);
         await editor.answer('refuse');
      }
   },
   {
      name: 'the editor closes and reopens the document, still held by another client, before refusing it',
      run: async ({ docs, editor, order }) => {
         docs.attachClient(URI, 'data-session');
         editor.close();
         editor.open(DISK);
         // Addressed at the closed buffer's version 2, which the reopened buffer refuses.
         await editor.answer('apply');
         // The store still holds the write, so it is retried as a full replace.
         await editor.answer('apply', order);
      }
   },
   {
      name: 'the editor applies it, then closes and reopens the document before the reply',
      run: async ({ editor, order }) =>
         editor.answer('apply', order, () => {
            editor.close();
            editor.open(DISK);
         })
   },
   {
      name: 'the editor closes and reopens the document before the push fails',
      run: async ({ editor }) => {
         editor.close();
         editor.open(DISK);
         await editor.answer('fail');
      }
   },
   {
      name: 'the push fails',
      run: async ({ editor }) => editor.answer('fail')
   },
   {
      name: 'the push fails and a keystroke shortens the buffer while the next push is in flight',
      run: async ({ docs, editor, order }) => {
         await editor.answer('fail');
         const next = sync(docs, WRITTEN);
         await flush();
         editor.type(shortening, '');
         await editor.answer('apply', order);
         await next;
      }
   },
   {
      name: 'the editor applies it and the reply fails',
      run: async ({ editor, order }) => editor.answer('apply-then-fail', order)
   },
   {
      name: 'the editor applies it, the reply fails, and a keystroke follows its echo',
      run: async ({ editor, order }) => editor.answer('apply-then-fail', order, () => editor.type(shortening, ''))
   }
];

describe('HydraniumTextDocuments — what a push leaves behind, in every order its reply, echo and the editor can take', () => {
   for (const scenario of scenarios) {
      for (const order of ['echo-first', 'reply-first'] as const) {
         it(`${scenario.name} (${order})`, async () => {
            const { docs, editorAt, pushes } = makeStore();
            const editor = editorAt(URI);
            editor.open(DISK);
            editor.type(Range.create(3, 0, 3, 0), 'l4\n');
            expect(docs.get(URI)?.getText()).toBe(TYPED);

            const pushed: RetryPolicy = { retry: 'held' };
            docs.applyContentChange(URI, WRITTEN, 'form-client');
            const done = sync(docs, WRITTEN, pushed);
            await flush();
            await scenario.run({ docs, editor, order, pushed });
            await done;
            expect(await editor.hasPush()).toBe(false);

            // The store pushes what it holds, as the next settle does.
            const held = editor.text === docs.get(URI)?.getText();
            const before = pushes.length;
            const settled = sync(docs, docs.get(URI)!.getText());
            while (await editor.hasPush()) {
               await editor.answer('apply', order);
            }
            await settled;

            expect(editor.text).toBe(docs.get(URI)?.getText());
            if (held) {
               // A push of text the editor already holds dirties its buffer and adds an undo step.
               expect(pushes.slice(before)).toEqual([]);
            }
            editor.type(Range.create(0, 0, 0, 0), 'k');
            expect(docs.get(URI)?.getText()).toBe(editor.text);
         });
      }
   }
});

describe('HydraniumTextDocuments — the retry after a refusal', () => {
   it('is a full replace, which lands even when the refusal was not about the version', async () => {
      const { docs, editorAt, pushes } = makeStore();
      const editor = editorAt(URI);
      editor.open(DISK);
      docs.applyContentChange(URI, WRITTEN, 'form-client');

      const done = sync(docs, WRITTEN);
      await editor.answer('refuse');
      await editor.answer('apply');
      await done;

      const versions = pushes.map(push => (push.edit.documentChanges![0] as TextDocumentEdit).textDocument.version);
      expect(versions).toEqual([1, null]);
      expect(editor.text).toBe(WRITTEN);
   });
});

describe('HydraniumTextDocuments — an answer that arrives after the editor reopened the document', () => {
   it('leaves the reopened buffer a diff baseline', async () => {
      const { docs, editorAt, pushes } = makeStore();
      const editor = editorAt(URI);
      editor.open(DISK);
      editor.type(Range.create(3, 0, 3, 0), 'l4\n');
      docs.applyContentChange(URI, WRITTEN, 'form-client');

      const done = sync(docs, WRITTEN);
      await flush();
      editor.close();
      editor.open(DISK);
      await editor.answer('refuse');
      await done;
      docs.applyContentChange(URI, 'l1\nL2\nl3\n', 'form-client');
      const next = sync(docs, 'l1\nL2\nl3\n');
      await editor.answer('apply');
      await next;

      // A full replace re-tokenises the whole buffer and is one undo step for all of it.
      expect((pushes.at(-1)!.edit.documentChanges![0] as TextDocumentEdit).textDocument.version).toBe(1);
      expect(editor.text).toBe('l1\nL2\nl3\n');
   });
});

describe('HydraniumTextDocuments — a push fanned out to a file open under two URIs', () => {
   const REAL = 'file:///real/a.x';
   const LINK = 'file:///link/a.x';
   const toText = (uri: string | { toString(): string }): string => (typeof uri === 'string' ? uri : uri.toString());
   const linkAware = {
      canonicalUri: (uri: string | { toString(): string }): string => (toText(uri) === LINK ? REAL : toText(uri)),
      loadUri: (uri: string | { toString(): string }) => ({ toString: () => (toText(uri) === LINK ? REAL : toText(uri)) })
   };

   for (const reopened of [REAL, LINK]) {
      it(`keeps tracking ${reopened === REAL ? 'the first' : 'the second'} URI when it reopens while its push is in flight`, async () => {
         const { docs, editorAt } = makeStore(linkAware);
         const editors = [editorAt(REAL), editorAt(LINK)];
         for (const editor of editors) {
            editor.open(DISK);
            editor.type(Range.create(3, 0, 3, 0), 'l4\n');
         }
         docs.applyContentChange(REAL, WRITTEN, 'form-client');

         const pushed = docs.applyEditToLanguageClient(REAL, WRITTEN);
         for (const editor of editors) {
            if (editor.uri === reopened) {
               editor.close();
               editor.open(DISK);
            }
            await editor.answer('apply');
         }
         await pushed;
         const settled = docs.applyEditToLanguageClient(REAL, WRITTEN);
         for (const editor of editors) {
            if (await editor.hasPush()) {
               await editor.answer('apply');
            }
         }
         await settled;

         expect(editors.map(editor => editor.text)).toEqual([WRITTEN, WRITTEN]);
         expect(docs.get(REAL)?.getText()).toBe(WRITTEN);
         for (const editor of editors) {
            editor.type(Range.create(0, 0, 0, 0), 'k');
            expect(docs.get(REAL)?.getText()).toBe(editor.text);
         }
      });
   }
});
