/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, expect, it } from 'vitest';
import { type CanonicalUri } from '@hydranium/protocol';
import { type AstNode, DocumentState } from '@hydranium/langium';
import { URI, UriUtils } from '@hydranium/langium';
import type { ServerSharedServices } from '../../src/langium/module.js';
import { DefaultAstDocumentManager } from '../../src/documents/ast-document-manager.js';
import { UNKNOWN_CLIENT_ID } from '../../src/documents/client-ids.js';
import { HydraniumTextDocuments } from '../../src/documents/hydranium-text-documents.js';
import { type DocumentUriPolicy } from '../../src/langium/workspace/document-uri-policy.js';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { makeFakeAstNode, makeFakeDocument, makeTestServices } from '../../src/testing/index.js';

interface FakeRoot extends AstNode {
   readonly $type: 'FakeRoot';
   readonly name: string;
}

const URI_A = 'file:///A.fake';
const URI_B = 'file:///B.fake';

/**
 * Wire a REAL {@link AstDocumentManager} over a REAL {@link HydraniumTextDocuments}.
 *
 * The bundled stub `HydraniumTextDocuments` doesn't implement `onDidOpen`, which
 * the real `AstDocumentManager` constructor subscribes to — so we swap a real
 * `HydraniumTextDocuments` into the `workspace.TextDocuments` slot. The stub
 * `DocumentBuilder` (with `firePhase` / `fireOnUpdate`) and stub
 * `LangiumDocuments` (seeded with `URI_A`) stay, since the real manager reads
 * them as plain slots.
 */
function makeManagerHarness(opts: { documentUriPolicy?: DocumentUriPolicy } = {}): {
   manager: DefaultAstDocumentManager<FakeRoot>;
   textDocuments: HydraniumTextDocuments;
   builder: ReturnType<typeof makeTestServices<FakeRoot>>['documentBuilder'];
   documents: ReturnType<typeof makeTestServices<FakeRoot>>['documents'];
   fileSystem: ReturnType<typeof makeTestServices<FakeRoot>>['fileSystem'];
} {
   const bundle = makeTestServices<FakeRoot>({
      seedDocuments: [{ uri: URI_A, root: makeFakeAstNode<FakeRoot>({ $type: 'FakeRoot', name: 'a' }) }],
      documentUriPolicy: opts.documentUriPolicy
   });
   // Swap in a REAL HydraniumTextDocuments (constructs from services.Logger only):
   const textDocuments = new HydraniumTextDocuments(bundle.services);
   const services = {
      ...bundle.services,
      workspace: { ...bundle.services.workspace, TextDocuments: textDocuments }
   } as ServerSharedServices;
   const manager = new DefaultAstDocumentManager<FakeRoot>(services);
   return { manager, textDocuments, builder: bundle.documentBuilder, documents: bundle.documents, fileSystem: bundle.fileSystem };
}

/** Open `uri` at `version` so the real text store records `clientId` as the version author. */
function open(textDocuments: HydraniumTextDocuments, uri: string, version: number, clientId: string): void {
   textDocuments.notifyDidOpenTextDocument({ textDocument: { uri, languageId: 'plaintext', version, text: '' } }, clientId);
}

describe('AstDocumentManager onUpdate', () => {
   it('fires once with the rebuilt root, the version author, and reason "rebuilt"', () => {
      const { manager, textDocuments, builder } = makeManagerHarness();
      open(textDocuments, URI_A, 1, 'author-1');

      const events: Array<{ name: string; sourceClientId: string; reason: string }> = [];
      manager.onUpdate(URI_A, event =>
         events.push({ name: event.document.root.name, sourceClientId: event.sourceClientId, reason: event.reason })
      );

      const doc = makeFakeDocument<FakeRoot>(URI_A, makeFakeAstNode<FakeRoot>({ $type: 'FakeRoot', name: 'rebuilt' }), { version: 1 });
      builder.firePhase(DocumentState.Validated, doc);

      // No fireOnUpdate beforehand → URI is in neither changed nor deleted → 'rebuilt'.
      expect(events).toEqual([{ name: 'rebuilt', sourceClientId: 'author-1', reason: 'rebuilt' }]);
   });

   it('reports reason "changed" when the URI is in the most recent changed set', () => {
      const { manager, textDocuments, builder } = makeManagerHarness();
      open(textDocuments, URI_A, 1, 'author-1');

      const reasons: string[] = [];
      manager.onUpdate(URI_A, event => reasons.push(event.reason));

      builder.fireOnUpdate([URI.parse(URI_A)], []);
      builder.firePhase(
         DocumentState.Validated,
         makeFakeDocument<FakeRoot>(URI_A, makeFakeAstNode<FakeRoot>({ $type: 'FakeRoot', name: 'a' }), { version: 1 })
      );

      expect(reasons).toEqual(['changed']);
   });

   // A `deleted` counterpart is deliberately absent: this harness's builder stub
   // will fire a phase for a URI it has just reported as deleted, which the real
   // builder cannot do, so such a test would assert an impossible sequence. The
   // unreachability is pinned against a real builder instead.

   it('URI-gates: a phase fire for a different URI does not invoke the listener', () => {
      const { manager, builder } = makeManagerHarness();

      const reasons: string[] = [];
      manager.onUpdate(URI_A, event => reasons.push(event.reason));

      builder.firePhase(
         DocumentState.Validated,
         makeFakeDocument<FakeRoot>(URI_B, makeFakeAstNode<FakeRoot>({ $type: 'FakeRoot', name: 'b' }), { version: 1 })
      );

      expect(reasons).toEqual([]);
   });

   it('falls back to UNKNOWN_CLIENT_ID when no author history exists for the version', () => {
      const { manager, builder } = makeManagerHarness();

      const sources: string[] = [];
      manager.onUpdate(URI_A, event => sources.push(event.sourceClientId));

      // URI_A was never opened in the real text store → no version-author history.
      builder.firePhase(
         DocumentState.Validated,
         makeFakeDocument<FakeRoot>(URI_A, makeFakeAstNode<FakeRoot>({ $type: 'FakeRoot', name: 'a' }), { version: 1 })
      );

      expect(sources).toEqual([UNKNOWN_CLIENT_ID]);
   });
});

describe('AstDocumentManager onSave', () => {
   it('fires for the subscribed URI carrying the saving client', async () => {
      const { manager, textDocuments } = makeManagerHarness();
      // Save only fires onDidSave for a synced (opened) document.
      open(textDocuments, URI_A, 1, 'saver-1');

      const events: Array<{ uri: string; sourceClientId: string }> = [];
      manager.onSave(URI_A, event => {
         events.push({ uri: event.document.uri, sourceClientId: event.sourceClientId });
      });

      textDocuments.notifyDidSaveTextDocument({ textDocument: { uri: URI_A } }, 'saver-1');
      // onSave's listener is async (awaits getOrCreateDocument); settle the microtask queue.
      await Promise.resolve();

      expect(events).toEqual([{ uri: URI_A, sourceClientId: 'saver-1' }]);
   });

   it('does not fire for a save of a different URI', async () => {
      const { manager, textDocuments } = makeManagerHarness();
      open(textDocuments, URI_A, 1, 'saver-1');
      open(textDocuments, URI_B, 1, 'saver-1');

      const events: string[] = [];
      manager.onSave(URI_A, event => {
         events.push(event.document.uri);
      });

      textDocuments.notifyDidSaveTextDocument({ textDocument: { uri: URI_B } }, 'saver-1');
      await Promise.resolve();

      expect(events).toEqual([]);
   });
});

describe('AstDocumentManager onClientClosed', () => {
   it('fires when the matching client closes the subscribed URI', () => {
      const { manager, textDocuments } = makeManagerHarness();
      // Open in two clients so closing one still delivers an onDidClose event.
      open(textDocuments, URI_A, 1, 'c1');
      open(textDocuments, URI_A, 1, 'c2');

      let fired = 0;
      manager.onClientClosed(URI_A, 'c1', () => {
         fired++;
      });

      textDocuments.notifyDidCloseTextDocument({ textDocument: { uri: URI_A } }, 'c1');

      expect(fired).toBe(1);
   });

   it('does not fire for a different client closing the same URI', () => {
      const { manager, textDocuments } = makeManagerHarness();
      open(textDocuments, URI_A, 1, 'c1');
      open(textDocuments, URI_A, 1, 'c2');

      let fired = 0;
      manager.onClientClosed(URI_A, 'c1', () => {
         fired++;
      });

      textDocuments.notifyDidCloseTextDocument({ textDocument: { uri: URI_A } }, 'c2');

      expect(fired).toBe(0);
   });

   it('does not fire when the matching client closes a different URI', () => {
      // Kills the URI-match conjunct in onClientClosed: a close of the right
      // client but the wrong URI must not invoke the listener.
      const { manager, textDocuments } = makeManagerHarness();
      open(textDocuments, URI_A, 1, 'c1');
      open(textDocuments, URI_A, 1, 'c2');
      open(textDocuments, URI_B, 1, 'c1');
      open(textDocuments, URI_B, 1, 'c2');

      let fired = 0;
      manager.onClientClosed(URI_A, 'c1', () => {
         fired++;
      });

      textDocuments.notifyDidCloseTextDocument({ textDocument: { uri: URI_B } }, 'c1');

      expect(fired).toBe(0);
   });
});

describe('AstDocumentManager symlink / canonical-URI divergence', () => {
   // A subscriber opens a *symlinked* file (LINK_URI) while the build pipeline
   // and LangiumDocuments key the same file by its resolved real path
   // (REAL_URI). A canonicalizer that collapses both to the real path is what
   // an adopter with symlink-aware `LangiumDocuments` binds; the manager must
   // route its event filters through it so the layers agree. Without the
   // canonicalisation the link↔real string mismatch silently drops events.
   const REAL_URI = 'file:///real/x.fake';
   const LINK_URI = 'file:///link/x.fake';
   const linkAware: DocumentUriPolicy = {
      canonicalUri: uri => {
         const text = typeof uri === 'string' ? uri : uri.toString();
         return UriUtils.normalize(text === LINK_URI ? REAL_URI : text) as CanonicalUri;
      },
      loadUri: uri => {
         const text = typeof uri === 'string' ? uri : uri.toString();
         return UriUtils.toUri(text === LINK_URI ? REAL_URI : text);
      }
   };

   it('onUpdate fires for a subscriber on the symlink URI when the build reports the real URI', () => {
      const { manager, textDocuments, builder } = makeManagerHarness({ documentUriPolicy: linkAware });
      open(textDocuments, REAL_URI, 1, 'author-1');

      const reasons: string[] = [];
      manager.onUpdate(LINK_URI, event => reasons.push(event.reason));

      builder.firePhase(
         DocumentState.Validated,
         makeFakeDocument<FakeRoot>(REAL_URI, makeFakeAstNode<FakeRoot>({ $type: 'FakeRoot', name: 'a' }), { version: 1 })
      );

      expect(reasons).toEqual(['rebuilt']);
   });

   it('onUpdate emits the document (canonical) URI, never the URI the subscriber armed with', () => {
      const { manager, textDocuments, builder } = makeManagerHarness({ documentUriPolicy: linkAware });
      open(textDocuments, REAL_URI, 1, 'author-1');

      const uris: string[] = [];
      manager.onUpdate(LINK_URI, event => uris.push(event.document.uri));

      builder.firePhase(
         DocumentState.Validated,
         makeFakeDocument<FakeRoot>(REAL_URI, makeFakeAstNode<FakeRoot>({ $type: 'FakeRoot', name: 'a' }), { version: 1 })
      );

      // Two competing URIs is the precondition the hazard needs: with one URI in
      // the fixture, an envelope echoing the subscriber's URI is byte-identical
      // to one carrying the document's, so nothing can tell them apart.
      expect(uris).toEqual([REAL_URI]);
   });

   it('onSave fires for a subscriber on the symlink URI when the real URI is saved', async () => {
      const { manager, textDocuments, documents } = makeManagerHarness({ documentUriPolicy: linkAware });
      documents.set(REAL_URI, makeFakeAstNode<FakeRoot>({ $type: 'FakeRoot', name: 'a' }));
      open(textDocuments, REAL_URI, 1, 'saver-1');

      const events: string[] = [];
      manager.onSave(LINK_URI, event => {
         events.push(event.document.uri);
      });

      textDocuments.notifyDidSaveTextDocument({ textDocument: { uri: REAL_URI } }, 'saver-1');
      await Promise.resolve();

      expect(events).toEqual([REAL_URI]);
   });

   it('onClientClosed fires for a subscriber on the symlink URI when the real URI is closed', () => {
      const { manager, textDocuments } = makeManagerHarness({ documentUriPolicy: linkAware });
      open(textDocuments, REAL_URI, 1, 'c1');
      open(textDocuments, REAL_URI, 1, 'c2');

      let fired = 0;
      manager.onClientClosed(LINK_URI, 'c1', () => {
         fired++;
      });

      textDocuments.notifyDidCloseTextDocument({ textDocument: { uri: REAL_URI } }, 'c1');

      expect(fired).toBe(1);
   });

   it('getDocument resolves a symlink-path URI to the document LangiumDocuments keys by its real path', () => {
      // The build keys the document by its real path; a caller holding the
      // client-facing symlink URI must still find it. The method folds the
      // canonicalize step so the lookup cannot silently miss.
      const { manager, documents } = makeManagerHarness({ documentUriPolicy: linkAware });
      documents.set(REAL_URI, makeFakeAstNode<FakeRoot>({ $type: 'FakeRoot', name: 'real' }));

      const document = manager.getDocument(LINK_URI);
      expect(document?.uri.toString()).toBe(REAL_URI);
      expect((document?.parseResult.value as FakeRoot | undefined)?.name).toBe('real');
   });

   it('getDocument returns undefined when no document is registered for the canonical URI', () => {
      const { manager } = makeManagerHarness({ documentUriPolicy: linkAware });
      expect(manager.getDocument(LINK_URI)).toBeUndefined();
   });
});

describe('AstDocumentManager onSave URI gating', () => {
   it('does not fire for the subscribed URI when no Langium document exists for it', async () => {
      // Kills the `this.langiumDocs.hasDocument(documentURI)` conjunct in
      // onSave: URI_B is opened in the text store but never registered in langiumDocs,
      // so the save listener must NOT fire even though the URI matches.
      const { manager, textDocuments } = makeManagerHarness();
      open(textDocuments, URI_B, 1, 'saver-1');

      const events: string[] = [];
      manager.onSave(URI_B, event => {
         events.push(event.document.uri);
      });

      textDocuments.notifyDidSaveTextDocument({ textDocument: { uri: URI_B } }, 'saver-1');
      await Promise.resolve();

      expect(events).toEqual([]);
   });

   it('does not fire when a DIFFERENT URI is saved, even with a Langium document present', async () => {
      // Kills onSave's URI-match conjunct in two ways
      // that the hasDocument-gating test could not (it left URI_B out of
      // langiumDocs, so hasDocument masked the uri-match conjunct):
      //   - ConditionalExpression `true && ...`: would fire for the wrong URI.
      //   - LogicalOperator `uri === uri || rest`: would fire whenever `rest`
      //     (documentURI !== undefined && hasDocument) holds for the saved URI.
      // Here URI_B IS registered in langiumDocs, so the only thing stopping the
      // fire for a subscriber on URI_A is the uri-match conjunct itself.
      const { manager, textDocuments, documents } = makeManagerHarness();
      documents.set(URI_B, makeFakeAstNode<FakeRoot>({ $type: 'FakeRoot', name: 'b' }));
      open(textDocuments, URI_B, 1, 'saver-1');

      const events: string[] = [];
      manager.onSave(URI_A, event => {
         events.push(event.document.uri);
      });

      textDocuments.notifyDidSaveTextDocument({ textDocument: { uri: URI_B } }, 'saver-1');
      await Promise.resolve();

      expect(events).toEqual([]);
   });
});

describe('AstDocumentManager open / close lifecycle', () => {
   it('open() creates a not-yet-open document and reports it open afterwards', async () => {
      // Kills the `if (this.isOpen(args.uri))` guard in open(): with the
      // guard forced true, a fresh URI would route to refreshContent (no create)
      // and never become open.
      const { manager } = makeManagerHarness();
      expect(manager.isOpen(URI_B)).toBe(false);
      await manager.open({ uri: URI_B, clientId: 'c1', languageId: 'plaintext' });
      expect(manager.isOpen(URI_B)).toBe(true);
   });

   it('open() returns a disposable that closes the document', async () => {
      // Kills the `Disposable.create(() => this.close(args))` arrow returned by
      // open(): disposing must close the document, not be a no-op.
      const { manager } = makeManagerHarness();
      const disposable = await manager.open({ uri: URI_B, clientId: 'c1', languageId: 'plaintext' });
      expect(manager.isOpen(URI_B)).toBe(true);
      disposable.dispose();
      await Promise.resolve();
      expect(manager.isOpen(URI_B)).toBe(false);
   });

   it('open() on an already-open URI is a no-op — no rebuild, no disk read', async () => {
      // An already-open `open()` must NOT fire a change event and must
      // NOT read from disk. `open()` is the RPC ensure-loaded call (also issued
      // by update()/save() and by additional clients attaching to the same URI);
      // firing `refreshContent` here would turn every such call into a full Langium
      // rebuild + dependent relink cascade (and, via the `onDidOpen -> open`
      // constructor wiring, a redundant second rebuild on every first open).
      // Re-rendering an attaching *textual* view is the job of the real
      // `textDocument/didOpen` -> notifyDidOpenTextDocument attach branch, not
      // this method.
      //
      // Kills the `if (!this.isOpen(...))` guard mutants: forcing the guard true
      // would route the re-open through the create branch
      // (createDocumentFromTextOrFileSystem -> disk read + a change fire);
      // dropping the early return would re-introduce the refresh fire.
      const { manager, textDocuments, fileSystem } = makeManagerHarness();
      // First open supplies text → no read on the initial open.
      await manager.open({ uri: URI_B, clientId: 'c1', languageId: 'plaintext', text: 'seed\n' });

      let reads = 0;
      const realReadFile = fileSystem.readFile;
      (fileSystem as unknown as { readFile: typeof realReadFile }).readFile = async (uri: URI) => {
         reads++;
         return realReadFile(uri);
      };

      const changeFires: number[] = [];
      textDocuments.onDidChangeContent(() => changeFires.push(1));
      await manager.open({ uri: URI_B, clientId: 'c2', languageId: 'plaintext' });

      // The already-open re-open neither rebuilds...
      expect(changeFires).toHaveLength(0);
      // ...nor reads from disk (the create branch would do both).
      expect(reads).toBe(0);
      // ...and the document stays open for the new client.
      expect(manager.isOpen(URI_B)).toBe(true);
   });

   it('open() on a fresh URI fires exactly one rebuild — no re-entrant double-build', async () => {
      // Regression guard for the re-entrant double-build. The constructor wires
      // `textDocuments.onDidOpen -> this.open`, so a first open runs:
      // notifyDidOpenTextDocument (first client) fires onDidChangeContent
      // (rebuild #1) AND fires onDidOpen -> re-entrant open() -> the URI is now
      // open. A "refresh on already-open" branch would make that re-entrant call
      // fire refreshContent -> a second, byte-identical onDidChangeContent
      // (rebuild #2). The no-op already-open branch must collapse that to a
      // single rebuild fire.
      const { manager, textDocuments } = makeManagerHarness();

      const changeFires: number[] = [];
      textDocuments.onDidChangeContent(() => changeFires.push(1));
      await manager.open({ uri: URI_B, clientId: 'c1', languageId: 'plaintext', text: 'seed\n' });

      expect(changeFires).toHaveLength(1);
   });
});

describe('AstDocumentManager update', () => {
   it('throws when updating a document that is not open', async () => {
      // Kills the `if (!this.isOpen(uri))` throw guard in update().
      const { manager } = makeManagerHarness();
      await expect(manager.update(URI_B, 'text', 'c1')).rejects.toThrow(/hasn't been opened for updating/);
   });

   it('returns the store-assigned version on a successful update', async () => {
      // The store owns version assignment: a content change steps the shared
      // version by one; the manager returns exactly that.
      const { manager } = makeManagerHarness();
      await manager.open({ uri: URI_B, clientId: 'c1', languageId: 'plaintext', version: 0 });
      const applied = await manager.update(URI_B, 'new-text', 'c1');
      expect(applied).toBe(1);
   });
});

describe('AstDocumentManager external content reconciliation', () => {
   it('re-stamps a rebuilt closed document with the stepped sequence version', () => {
      // Close-revert: edits are discarded, the update handler rebuilds from
      // disk, and the factory creates a fresh text document at its own version.
      // The Parsed-phase reconcile must step the persisted sequence (content
      // changed while closed) and re-stamp the rebuilt document so the revert
      // broadcast carries the continued sequence, not the factory version.
      const { textDocuments, builder } = makeManagerHarness();
      open(textDocuments, URI_A, 1, 'author-1');
      textDocuments.notifyDidChangeTextDocument(
         { textDocument: { uri: URI_A, version: 2 }, contentChanges: [{ text: 'edited\n' }] },
         'author-1'
      );
      textDocuments.notifyDidCloseTextDocument({ textDocument: { uri: URI_A } }, 'author-1');
      // The rebuild reads the pre-edit disk content into a factory-fresh doc.
      const doc = makeFakeDocument<FakeRoot>(URI_A, makeFakeAstNode<FakeRoot>({ $type: 'FakeRoot', name: 'a' }), {
         textDocument: TextDocument.create(URI_A, 'plaintext', 0, '')
      });
      builder.firePhase(DocumentState.Parsed, doc);
      expect(doc.textDocument.version).toBe(3);
      expect(textDocuments.version(URI_A)).toBe(3);
   });

   it('re-stamps an unchanged rebuilt closed document without stepping the sequence', () => {
      // A close WITHOUT discarded edits: the rebuild carries identical content,
      // so the sequence stays put — but the factory document still gets the
      // sequence version instead of its own zero.
      const { textDocuments, builder } = makeManagerHarness();
      open(textDocuments, URI_A, 1, 'author-1');
      textDocuments.notifyDidChangeTextDocument(
         { textDocument: { uri: URI_A, version: 2 }, contentChanges: [{ text: 'saved\n' }] },
         'author-1'
      );
      textDocuments.notifyDidCloseTextDocument({ textDocument: { uri: URI_A } }, 'author-1');
      const doc = makeFakeDocument<FakeRoot>(URI_A, makeFakeAstNode<FakeRoot>({ $type: 'FakeRoot', name: 'a' }), {
         textDocument: TextDocument.create(URI_A, 'plaintext', 0, 'saved\n')
      });
      builder.firePhase(DocumentState.Parsed, doc);
      expect(doc.textDocument.version).toBe(2);
      expect(textDocuments.version(URI_A)).toBe(2);
   });

   it('leaves a never-tracked document untouched at the Parsed transition', () => {
      // Workspace-init builds pass every document through the listener; a URI
      // the store never tracked must keep the factory version.
      const { builder } = makeManagerHarness();
      const doc = makeFakeDocument<FakeRoot>(URI_B, makeFakeAstNode<FakeRoot>({ $type: 'FakeRoot', name: 'b' }), {
         textDocument: TextDocument.create(URI_B, 'plaintext', 0, 'x\n')
      });
      builder.firePhase(DocumentState.Parsed, doc);
      expect(doc.textDocument.version).toBe(0);
   });
});

describe('AstDocumentManager save', () => {
   it('throws when saving a document that is not open', async () => {
      // Kills the `if (!document)` throw guard in save().
      const { manager } = makeManagerHarness();
      await expect(manager.save(URI_B, 'c1')).rejects.toThrow(/hasn't been opened for saving/);
   });

   it('writes the document content to the file system and fires onSave', async () => {
      // Kills save()'s writeFile arrow (as `() => undefined`) and its
      // notifyDidSaveTextDocument object literal: save must persist the
      // text AND notify save subscribers.
      // The harness already seeds URI_A in langiumDocs, so onSave's hasDocument gate passes.
      const { manager, fileSystem } = makeManagerHarness();
      await manager.open({ uri: URI_A, clientId: 'c1', languageId: 'plaintext', version: 0, text: 'persist-me\n' });

      const saved: string[] = [];
      manager.onSave(URI_A, event => {
         saved.push(event.document.uri);
      });

      await manager.save(URI_A, 'c1');
      await Promise.resolve();

      expect(fileSystem.writes).toContainEqual({ uri: URI_A, content: 'persist-me\n' });
      expect(saved).toEqual([URI_A]);
   });
});

describe('AstDocumentManager isOpen / isTriggeringEdit', () => {
   it('isOpen reflects open state for a URI', async () => {
      // Kills the `return false` / `return true` ConditionalExpression mutants
      // on isOpen.
      const { manager } = makeManagerHarness();
      expect(manager.isOpen(URI_B)).toBe(false);
      await manager.open({ uri: URI_B, clientId: 'c1', languageId: 'plaintext' });
      expect(manager.isOpen(URI_B)).toBe(true);
   });

   it('isTriggeringEdit is true only for URIs in the latest changed set', () => {
      // Kills the isTriggeringEdit mutants: OptionalChaining (`lastUpdate?.`),
      // `?? false`→`&& false`, `.some`→`.every`, the predicate equality, and
      // the per-element booleans.
      const { manager, builder } = makeManagerHarness();
      // No build yet → no lastUpdate → false (exercises the `?? false` default).
      expect(manager.isTriggeringEdit(URI_A)).toBe(false);

      // Two changed URIs where only ONE equals the target. `.some` → true,
      // but a `.every` mutant → false (URI_B fails the predicate). A
      // single-element changed set cannot kill `.every`, because a one-element
      // array that matches satisfies BOTH `.some` and `.every`.
      builder.fireOnUpdate([URI.parse(URI_A), URI.parse(URI_B)], []);
      expect(manager.isTriggeringEdit(URI_A)).toBe(true);

      // A URI not in the changed set → false (kills `=> true` per-element booleans
      // and confirms the predicate equality is real).
      builder.fireOnUpdate([URI.parse(URI_A)], []);
      expect(manager.isTriggeringEdit('file:///C.fake')).toBe(false);
   });

   it('isTriggeringEdit canonicalizes the URI so a non-canonical query still matches', () => {
      const { manager, builder } = makeManagerHarness();
      // The builder reports canonical (percent-encoded) URIs; a caller querying with
      // the non-canonical spelling must still match (same normalization the
      // HydraniumTextDocuments applies to its document store).
      builder.fireOnUpdate([URI.parse('file:///My Folder/x.fake')], []);
      expect(manager.isTriggeringEdit('file:///My Folder/x.fake')).toBe(true);
      expect(manager.isTriggeringEdit('file:///My%20Folder/x.fake')).toBe(true);
   });
});
