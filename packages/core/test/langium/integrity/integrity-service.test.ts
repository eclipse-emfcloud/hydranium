/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { afterEach, describe, expect, it } from 'vitest';
import { asMutable, Disposable, Logger } from '@hydranium/protocol';
import { makeFakeClock } from '@hydranium/protocol/testing';
import { type AstNode, DocumentState, isOperationCancelled, type LangiumDocument } from '@hydranium/langium';
import type { ApplyWorkspaceEditParams, CancellationToken, TextEdit } from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { HydraniumTextDocuments } from '../../../src/documents/hydranium-text-documents.js';
import { DefaultDocumentUriPolicy } from '../../../src/langium/workspace/document-uri-policy.js';
import { DefaultIntegrityService } from '../../../src/langium/integrity/integrity-service.js';
import type { ServerLanguageServices } from '../../../src/langium/language-module.js';
import type { ServerSharedServices } from '../../../src/langium/module.js';
import { IntegrityPhase, type IntegrityRule, type IntegritySyncMode } from '../../../src/langium/integrity/integrity-rule.js';
import {
   makeCapturingLogger,
   makeCapturingTracer,
   makeFakeAstNode,
   makeFakeDocument,
   makeNoopLanguageServices,
   makeNoopSharedServices,
   type NoopLanguageServicesOverrides
} from '../../../src/testing/index.js';

interface FakeNode extends AstNode {
   readonly $type: string;
   readonly id?: string;
   _children?: FakeNode[];
}

function buildDocument(root: FakeNode, children: FakeNode[]): LangiumDocument {
   for (const child of children) {
      asMutable(child).$container = root;
   }
   (root as FakeNode & { _children?: FakeNode[] })._children = children;
   return makeFakeDocument('file:///doc.fake', root);
}

/**
 * Minimal `CancellationToken` shim. The constructor returns a token whose
 * cancellation flag can be flipped via `cancel()`; `interruptAndCheck` only
 * reads `isCancellationRequested` so the `onCancellationRequested` event is
 * never subscribed to in these tests.
 */
function makeCancelToken(): { token: CancellationToken; cancel: () => void } {
   let cancelled = false;
   const token: CancellationToken = {
      get isCancellationRequested() {
         return cancelled;
      },
      onCancellationRequested: () => Disposable.EMPTY
   };
   return {
      token,
      cancel: () => {
         cancelled = true;
      }
   };
}

// Minimal TextDocuments stub. The service reads it from `shared.workspace` and
// stores it, but invokes nothing on it during construction, so an empty
// stand-in suffices.
class FakeTextDocuments {}

/**
 * Per-language services for IntegrityService tests: the shared workspace slots
 * the service reads (TextDocuments / FileSystemProvider / WorkspaceManager) over
 * the no-op defaults. Merge `overrides` for a per-site tracer / logger,
 * serializer / parser, integrity rules, or a recording workspace slot; a nested
 * `shared.workspace` override merges key-by-key onto the base.
 */
function makeIntegrityServices(overrides: NoopLanguageServicesOverrides = {}): ServerLanguageServices {
   const { shared, ...rest } = overrides;
   const { workspace, ...sharedRest } = shared ?? {};
   return makeNoopLanguageServices({
      shared: {
         ...sharedRest,
         workspace: {
            TextDocuments: new FakeTextDocuments(),
            FileSystemProvider: {},
            WorkspaceManager: { wsRelativePath: () => 'doc.fake' },
            ...((workspace as Record<string, unknown>) ?? {})
         }
      },
      ...rest
   });
}

function makeService(): DefaultIntegrityService<FakeNode> {
   return new DefaultIntegrityService<FakeNode>(makeIntegrityServices());
}

function registerRule(
   service: DefaultIntegrityService<FakeNode>,
   options: {
      id?: string;
      nodeType: string;
      phase?: IntegrityPhase;
      onEnforce: (node: FakeNode) => boolean;
   }
): void {
   const rule: IntegrityRule<FakeNode> = {
      id: options.id ?? `rule-${options.nodeType}`,
      nodeType: options.nodeType,
      phase: options.phase ?? DocumentState.Parsed,
      enforce: node => options.onEnforce(node)
   };
   service.register(rule);
}

describe('IntegrityService.enforceIntegrity — cancellation', () => {
   it('returns early without invoking any rule when the token is already cancelled', async () => {
      const service = makeService();
      const calls: string[] = [];
      registerRule(service, {
         nodeType: 'Foo',
         onEnforce: node => {
            calls.push((node as FakeNode).id ?? '');
            return false;
         }
      });
      const document = buildDocument(makeFakeAstNode<FakeNode>({ $type: 'Root' }), [
         makeFakeAstNode<FakeNode>({ $type: 'Foo', id: 'a' }),
         makeFakeAstNode<FakeNode>({ $type: 'Foo', id: 'b' })
      ]);
      const { token, cancel } = makeCancelToken();
      cancel();

      const result = await service.enforceIntegrity(document, DocumentState.Parsed, token);

      expect(result).toBe(false);
      expect(calls).toEqual([]);
   });

   it('honours cancellation at the next per-node interrupt — first node processed, later nodes skipped', async () => {
      const service = makeService();
      const calls: string[] = [];
      const { token, cancel } = makeCancelToken();
      registerRule(service, {
         nodeType: 'Foo',
         onEnforce: node => {
            calls.push((node as FakeNode).id ?? '');
            // Cancel right after the first node's rule fires; the
            // `interruptAndCheck` after the node's rule sweep then throws.
            if ((node as FakeNode).id === 'a') {
               cancel();
            }
            return false;
         }
      });
      const document = buildDocument(makeFakeAstNode<FakeNode>({ $type: 'Root' }), [
         makeFakeAstNode<FakeNode>({ $type: 'Foo', id: 'a' }),
         makeFakeAstNode<FakeNode>({ $type: 'Foo', id: 'b' }),
         makeFakeAstNode<FakeNode>({ $type: 'Foo', id: 'c' })
      ]);

      let caught: unknown;
      try {
         await service.enforceIntegrity(document, DocumentState.Parsed, token);
      } catch (err) {
         caught = err;
      }

      expect(isOperationCancelled(caught)).toBe(true);
      expect(calls).toEqual(['a']);
   });

   it('runs to completion when the token is never cancelled', async () => {
      const service = makeService();
      const calls: string[] = [];
      registerRule(service, {
         nodeType: 'Foo',
         onEnforce: node => {
            calls.push((node as FakeNode).id ?? '');
            return false;
         }
      });
      const document = buildDocument(makeFakeAstNode<FakeNode>({ $type: 'Root' }), [
         makeFakeAstNode<FakeNode>({ $type: 'Foo', id: 'a' }),
         makeFakeAstNode<FakeNode>({ $type: 'Foo', id: 'b' })
      ]);
      const { token } = makeCancelToken();

      const result = await service.enforceIntegrity(document, DocumentState.Parsed, token);

      expect(result).toBe(false);
      expect(calls).toEqual(['a', 'b']);
   });

   it('runs to completion without a token (backwards-compatible path)', async () => {
      const service = makeService();
      const calls: string[] = [];
      registerRule(service, {
         nodeType: 'Foo',
         onEnforce: node => {
            calls.push((node as FakeNode).id ?? '');
            return false;
         }
      });
      const document = buildDocument(makeFakeAstNode<FakeNode>({ $type: 'Root' }), [
         makeFakeAstNode<FakeNode>({ $type: 'Foo', id: 'a' }),
         makeFakeAstNode<FakeNode>({ $type: 'Foo', id: 'b' })
      ]);

      const result = await service.enforceIntegrity(document, DocumentState.Parsed);

      expect(result).toBe(false);
      expect(calls).toEqual(['a', 'b']);
   });
});

describe('IntegrityService — contribution group consumption', () => {
   it('reads `services.integrity.rules` and calls each contribution at construction', () => {
      const calls: string[] = [];
      const services = makeIntegrityServices({
         integrity: {
            rules: {
               typeOne: {
                  registerIntegrityRules: (registry: DefaultIntegrityService<FakeNode>) => {
                     calls.push('typeOne');
                     registry.register({
                        id: 'typeOne-1',
                        nodeType: 'TypeOne',
                        phase: DocumentState.Parsed,
                        enforce: () => false
                     });
                  }
               },
               typeTwo: {
                  registerIntegrityRules: (registry: DefaultIntegrityService<FakeNode>) => {
                     calls.push('typeTwo');
                     registry.register({
                        id: 'typeTwo-1',
                        nodeType: 'TypeTwo',
                        phase: DocumentState.Linked,
                        enforce: () => false
                     });
                  }
               }
            }
         }
      });
      new DefaultIntegrityService<FakeNode>(services);
      expect(calls.sort()).toEqual(['typeOne', 'typeTwo']);
   });
});

/**
 * Probe subclass exposing the protected {@link DefaultIntegrityService.getPhaseBucket}
 * so the phase-bucket cache and priority ordering can be asserted directly.
 */
class ProbeService extends DefaultIntegrityService<FakeNode> {
   bucket(phase: DocumentState): readonly IntegrityRule[] {
      return this.getPhaseBucket(phase);
   }
}

function makeProbeService(): ProbeService {
   return new ProbeService(makeIntegrityServices());
}

describe('IntegrityService phase buckets', () => {
   it('invalidates the cached bucket on unregister, leaving only the surviving rule', () => {
      const service = makeProbeService();
      service.register({ id: 'keep', nodeType: 'Foo', phase: DocumentState.Parsed, enforce: () => false });
      service.register({ id: 'drop', nodeType: 'Bar', phase: DocumentState.Parsed, enforce: () => false });
      // Prime the cache so we exercise the unregister-driven invalidation path.
      expect(service.bucket(DocumentState.Parsed).map(rule => rule.id)).toEqual(['keep', 'drop']);

      service.unregister('drop');

      expect(service.bucket(DocumentState.Parsed).map(rule => rule.id)).toEqual(['keep']);
   });

   it('orders rules in a phase bucket by priority ascending, then registration order for ties', () => {
      const service = makeProbeService();
      // Registered out of priority order: b (priority 2) before a (priority 1).
      service.register({ id: 'b', nodeType: 'Foo', phase: DocumentState.Parsed, priority: 2, enforce: () => false });
      service.register({ id: 'a', nodeType: 'Foo', phase: DocumentState.Parsed, priority: 1, enforce: () => false });
      // Tie at priority 2 with `b`: registration order keeps `b` before `c`.
      service.register({ id: 'c', nodeType: 'Foo', phase: DocumentState.Parsed, priority: 2, enforce: () => false });

      expect(service.bucket(DocumentState.Parsed).map(rule => rule.id)).toEqual(['a', 'b', 'c']);
   });
});

describe('IntegrityPhase', () => {
   it('all() lists exactly the phases integrity may run at', () => {
      expect(IntegrityPhase.all()).toEqual([DocumentState.Parsed, DocumentState.Linked]);
   });
});

interface AuthorCall {
   uri: string;
   version: number;
   author: string;
}

/**
 * Richer text-document stub recording the calls `syncCorrections` /
 * `resyncDocument` make: authorship marks and staged pending content. `update`
 * returns a real {@link TextDocument} carrying `newText` so the reparse-guard
 * branch can read it back.
 */
class RecordingTextDocuments {
   readonly setAuthorCalls: AuthorCall[] = [];
   readonly stagedContent: { uri: string; text: string }[] = [];
   openInLanguageClient = false;

   isOpenInLanguageClient(): boolean {
      return this.openInLanguageClient;
   }

   setAuthor(uri: string, version: number, author: string): void {
      this.setAuthorCalls.push({ uri, version, author });
   }

   stagePendingContent(uri: string, text: string): void {
      this.stagedContent.push({ uri, text });
   }

   update(document: TextDocument, changes: { text: string }[], version: number): TextDocument {
      return TextDocument.create(document.uri, document.languageId, version, changes[changes.length - 1].text);
   }
}

class RecordingFileSystemProvider {
   readonly writes: { uri: string; content: string }[] = [];

   writeFile(uri: { toString(): string } | string, content: string): Promise<void> {
      this.writes.push({ uri: uri.toString(), content });
      return Promise.resolve();
   }
}

/** Probe exposing the protected correction-sync entry points. */
class CorrectionsProbe extends DefaultIntegrityService<FakeNode> {
   syncCorrectionsNow(document: TextDocument): Promise<void> {
      return this.syncCorrections(document);
   }
   resyncNow(document: LangiumDocument): Promise<void> {
      return this.resyncDocument(document);
   }
}

interface CorrectionsHarness {
   probe: CorrectionsProbe;
   textDocuments: RecordingTextDocuments;
   fileSystemProvider: RecordingFileSystemProvider;
   /** URIs passed to the (stubbed) document builder's reconciliation methods. */
   builderCalls: { reparse: string[]; reparseAndRelink: string[] };
}

function makeCorrectionsProbe(
   options: IntegritySyncMode | { syncMode?: IntegritySyncMode } = {},
   serializeResult = 'serialized-text'
): CorrectionsHarness {
   const textDocuments = new RecordingTextDocuments();
   const fileSystemProvider = new RecordingFileSystemProvider();
   const builderCalls = { reparse: [] as string[], reparseAndRelink: [] as string[] };
   const syncMode = typeof options === 'string' ? options : options.syncMode;
   const services = makeIntegrityServices({
      shared: {
         workspace: {
            TextDocuments: textDocuments,
            FileSystemProvider: fileSystemProvider,
            // resyncDocument delegates re-parse / re-link to the framework builder;
            // record which method each branch (Parsed vs Linked) invokes.
            DocumentBuilder: {
               reparse: async (document: LangiumDocument) => {
                  builderCalls.reparse.push(document.uri.toString());
               },
               reparseAndRelink: async (document: LangiumDocument) => {
                  builderCalls.reparseAndRelink.push(document.uri.toString());
               }
            }
            // syncCorrections asks the text store directly whether the document is
            // open in the language client (`isOpenInLanguageClient` canonicalizes
            // internally, so a symlinked open file is recognised across the R/S
            // divergence); the RecordingTextDocuments open flag drives it.
         }
      },
      serializer: { Serializer: { serializeAst: () => serializeResult } }
   });
   const probe = new CorrectionsProbe(services, syncMode ? { syncMode } : {});
   return { probe, textDocuments, fileSystemProvider, builderCalls };
}

/** A `LangiumDocument` carrying real text plus a mutable parse-result value. */
function makeResyncDocument(uri: string, text: string, state: DocumentState): LangiumDocument {
   return makeFakeDocument(uri, makeFakeAstNode({ $type: 'Root' }), {
      state,
      textDocument: TextDocument.create(uri, 'fake', 1, text)
   });
}

/**
 * The editor-mode staging chain against the REAL text store rather than
 * {@link RecordingTextDocuments}: integrity stages, the store consumes the
 * staged text at the next `didOpen`, and the open's own sync is the only
 * delivery this path has. Each half is covered against a stub elsewhere, which
 * cannot see whether a correction actually reaches the client — the store could
 * baseline its shadow to the staged text and answer the sync with no edits at
 * all, leaving the editor on stale disk content while the server believes
 * otherwise.
 */
function makeEditorStagingHarness(): {
   probe: CorrectionsProbe;
   docs: HydraniumTextDocuments<TextDocument>;
   recorded: ApplyWorkspaceEditParams[];
} {
   const recorded: ApplyWorkspaceEditParams[] = [];
   const storeServices = makeNoopSharedServices({
      lsp: {
         Connection: {
            workspace: {
               applyEdit: async (params: ApplyWorkspaceEditParams) => {
                  recorded.push(params);
                  return { applied: true };
               }
            }
         }
      },
      workspace: {
         LangiumDocuments: { getDocument: () => undefined },
         DocumentBuilder: { update: () => undefined, resetToState: () => undefined },
         WorkspaceManager: { workspaceInitialized: Promise.resolve(), wsRelativePath: () => 'doc.fake' },
         DocumentUriPolicy: new DefaultDocumentUriPolicy()
      }
   });
   // `makeNoopSharedServices` answers the MINIMAL tree; the store declares the full
   // one and reads only the slots stubbed above.
   const docs = new HydraniumTextDocuments<TextDocument>(storeServices as unknown as ServerSharedServices);
   // One instance in both trees: the store the integrity service stages into is
   // the store the client opens against, which is the whole point of the probe.
   const probe = new CorrectionsProbe(makeIntegrityServices({ shared: { workspace: { TextDocuments: docs, FileSystemProvider: {} } } }), {
      syncMode: 'editor'
   });
   return { probe, docs, recorded };
}

describe('IntegrityService editor-mode staging against the real text store', () => {
   it('delivers a staged correction to the client that opened the file from disk', async () => {
      const { probe, docs, recorded } = makeEditorStagingHarness();
      const uri = 'file:///staged.fake';

      // Integrity corrects a document no client has open, so editor mode stages it.
      await probe.syncCorrectionsNow(TextDocument.create(uri, 'fake', 4, 'corrected\n'));
      // The client opens the file afterwards and reads the STALE text from disk.
      docs.notifyDidOpenTextDocument({ textDocument: { uri, languageId: 'fake', version: 1, text: 'original\n' } });
      expect(docs.get(uri)?.getText()).toBe('corrected\n');

      await docs.applyEditToLanguageClient(uri, 'corrected\n');

      expect(recorded).toHaveLength(1);
      const edits = (recorded[0].edit.documentChanges![0] as { edits: TextEdit[] }).edits;
      const heldByClient = TextDocument.create(uri, 'fake', 0, 'original\n');
      expect(TextDocument.applyEdits(heldByClient, edits)).toBe('corrected\n');
   });
});

describe('IntegrityService corrections sync', () => {
   it('does not rewrite authorship or touch disk for an open file (the content listener delivers)', async () => {
      const { probe, textDocuments, fileSystemProvider } = makeCorrectionsProbe('editor');
      textDocuments.openInLanguageClient = true;
      const td = TextDocument.create('file:///open.fake', 'fake', 7, 'corrected');

      await probe.syncCorrectionsNow(td);

      // Open branch: no author rewrite, no disk write, no staging — the corrected
      // text is already in the store and ModelService mirrors it by content.
      expect(textDocuments.setAuthorCalls).toEqual([]);
      expect(fileSystemProvider.writes).toEqual([]);
      expect(textDocuments.stagedContent).toEqual([]);
   });

   it('writes corrected text to disk for a closed file in silent mode', async () => {
      const { probe, textDocuments, fileSystemProvider } = makeCorrectionsProbe('silent');
      textDocuments.openInLanguageClient = false;
      const td = TextDocument.create('file:///closed.fake', 'fake', 3, 'corrected');

      await probe.syncCorrectionsNow(td);

      expect(fileSystemProvider.writes).toEqual([{ uri: 'file:///closed.fake', content: 'corrected' }]);
      expect(textDocuments.setAuthorCalls).toEqual([]);
   });

   it('stages pending content for a closed file in editor mode (no author rewrite)', async () => {
      const { probe, textDocuments, fileSystemProvider } = makeCorrectionsProbe('editor');
      textDocuments.openInLanguageClient = false;
      const td = TextDocument.create('file:///closed.fake', 'fake', 4, 'corrected');

      await probe.syncCorrectionsNow(td);

      expect(textDocuments.stagedContent).toEqual([{ uri: 'file:///closed.fake', text: 'corrected' }]);
      expect(textDocuments.setAuthorCalls).toEqual([]);
      expect(fileSystemProvider.writes).toEqual([]);
   });

   it('re-applies a repeat correction on every resync rather than suppressing it', async () => {
      // Integrity must not short-circuit a repeated identical correction: any
      // early return from `resyncDocument` would skip `reparseAndRelink` and
      // strand the rule-mutated AST against a stale CST. Closed editor mode
      // makes every propagation observable as a staged-content call.
      const harness = makeCorrectionsProbe('editor', 'corrected');
      harness.textDocuments.openInLanguageClient = false;
      const doc = makeResyncDocument('file:///closed.fake', 'old', DocumentState.Linked);

      await harness.probe.resyncNow(doc);
      await harness.probe.resyncNow(doc);

      // No suppression: both resyncs stage the correction AND reconcile the
      // document in-build, so neither can strand a mutated AST.
      expect(harness.textDocuments.stagedContent).toHaveLength(2);
      expect(harness.builderCalls.reparseAndRelink).toEqual(['file:///closed.fake', 'file:///closed.fake']);
   });

   it('skips the text update, corrections sync, and reparse when serialization is a no-op', async () => {
      // serializeAst reproduces the document text verbatim → resyncDocument
      // hits the `if (oldText === newText) return` short-circuit and must touch
      // nothing downstream. The `if (false)` mutant instead re-applies the
      // (identical) text: it calls textDocuments.update, syncCorrections (which
      // writes to disk in silent mode), and re-parses via the builder.
      const harness = makeCorrectionsProbe('silent', 'identical-text');
      harness.textDocuments.openInLanguageClient = false;
      const doc = makeResyncDocument('file:///noop.fake', 'identical-text', DocumentState.Parsed);

      await harness.probe.resyncNow(doc);

      expect(harness.builderCalls.reparse).toEqual([]);
      expect(harness.builderCalls.reparseAndRelink).toEqual([]);
      expect(harness.fileSystemProvider.writes).toEqual([]);
      expect(harness.textDocuments.setAuthorCalls).toEqual([]);
      expect(harness.textDocuments.stagedContent).toEqual([]);
   });

   it('delegates a Parsed-phase correction to builder.reparse and a Linked-phase one to reparseAndRelink', async () => {
      // A correction found while the document is still at Parsed only needs a re-parse:
      // the build pipeline re-runs the later phases (scopes/link/…) on the fresh AST.
      const parsedHarness = makeCorrectionsProbe('silent', 'new-serialized');
      const parsedDoc = makeResyncDocument('file:///parsed.fake', 'old-text', DocumentState.Parsed);

      await parsedHarness.probe.resyncNow(parsedDoc);

      expect(parsedHarness.builderCalls.reparse).toEqual(['file:///parsed.fake']);
      expect(parsedHarness.builderCalls.reparseAndRelink).toEqual([]);

      // A correction found after linking must re-parse AND re-link in place — the build has
      // already passed those phases, and a stale CST would otherwise strand the mutated AST.
      const linkedHarness = makeCorrectionsProbe('silent', 'new-serialized');
      const linkedDoc = makeResyncDocument('file:///linked.fake', 'old-text', DocumentState.Linked);

      await linkedHarness.probe.resyncNow(linkedDoc);

      expect(linkedHarness.builderCalls.reparseAndRelink).toEqual(['file:///linked.fake']);
      expect(linkedHarness.builderCalls.reparse).toEqual([]);
   });
});

/** Probe recording every `resyncDocument` call instead of running the real resync. */
class BatchProbe extends DefaultIntegrityService<FakeNode> {
   readonly resyncedUris: string[] = [];
   protected override async resyncDocument(document: LangiumDocument): Promise<void> {
      this.resyncedUris.push(document.uri.toString());
   }
}

function makeBatchProbe(logger: Logger): BatchProbe {
   // The default Tracer wraps the `Logger` slot, so the batch service's info
   // lines flow into this (capturing) logger.
   return new BatchProbe(makeIntegrityServices({ shared: { Logger: logger } }));
}

function batchDocument(uri: string, nodes: FakeNode[]): LangiumDocument {
   const root = makeFakeAstNode<FakeNode>({ $type: 'Root' });
   for (const node of nodes) {
      asMutable(node).$container = root;
   }
   (root as FakeNode & { _children?: FakeNode[] })._children = nodes;
   return makeFakeDocument(uri, root);
}

describe('IntegrityService enforceBatch', () => {
   afterEach(() => Logger.setLevel('info'));

   it('never resyncs when no rule mutates a document', async () => {
      const { logger } = makeCapturingLogger();
      const probe = makeBatchProbe(logger);
      probe.register({ id: 'noop', nodeType: 'Foo', phase: DocumentState.Parsed, enforce: () => false });
      const { token } = makeCancelToken();
      const documents = [batchDocument('file:///a.fake', [makeFakeAstNode<FakeNode>({ $type: 'Foo', id: 'a' })])];

      await expect(probe.enforceBatch(documents, DocumentState.Parsed, token)).resolves.toBeUndefined();

      expect(probe.resyncedUris).toEqual([]);
   });

   it('logs mutated=1 when exactly one of three documents is mutated', async () => {
      const { logger, lines } = makeCapturingLogger();
      const probe = makeBatchProbe(logger);
      // Mutate only the node carrying id 'hit'; the other documents leave the AST untouched.
      probe.register({ id: 'sel', nodeType: 'Foo', phase: DocumentState.Parsed, enforce: node => (node as FakeNode).id === 'hit' });
      const { token } = makeCancelToken();
      const documents = [
         batchDocument('file:///a.fake', [makeFakeAstNode<FakeNode>({ $type: 'Foo', id: 'miss' })]),
         batchDocument('file:///b.fake', [makeFakeAstNode<FakeNode>({ $type: 'Foo', id: 'hit' })]),
         batchDocument('file:///c.fake', [makeFakeAstNode<FakeNode>({ $type: 'Foo', id: 'miss' })])
      ];

      await probe.enforceBatch(documents, DocumentState.Parsed, token);

      expect(probe.resyncedUris).toEqual(['file:///b.fake']);
      expect(lines.some(line => /mutated=1/.test(line.message))).toBe(true);
   });

   it('tolerates an undefined integrity slot — zero rules, empty phase bucket', async () => {
      const service = new DefaultIntegrityService<FakeNode>(makeIntegrityServices());
      const document = buildDocument(makeFakeAstNode<FakeNode>({ $type: 'Root' }), [makeFakeAstNode<FakeNode>({ $type: 'Foo', id: 'a' })]);

      const result = await service.enforceIntegrity(document, DocumentState.Parsed);

      expect(result).toBe(false);
   });

   it('profiles per-rule self-time and reports it line-based at debug level', async () => {
      const { tracer, lines } = makeCapturingTracer(makeFakeClock());
      const service = new DefaultIntegrityService<FakeNode>(makeIntegrityServices({ shared: { Tracer: tracer } }));
      service.register({ id: 'ruleA', nodeType: 'Foo', phase: DocumentState.Parsed, enforce: () => false });
      service.register({ id: 'ruleB', nodeType: 'Foo', phase: DocumentState.Parsed, enforce: () => false });
      Logger.setLevel('debug');
      const { token } = makeCancelToken();
      const documents = [
         batchDocument('file:///a.fake', [
            makeFakeAstNode<FakeNode>({ $type: 'Foo', id: 'a' }),
            makeFakeAstNode<FakeNode>({ $type: 'Foo', id: 'b' })
         ])
      ];

      await service.enforceBatch(documents, DocumentState.Parsed, token);

      const profileLines = lines.map(line => line.message).filter(message => message.includes('[profile integrity'));
      expect(profileLines.some(message => message.includes('ruleA'))).toBe(true);
      expect(profileLines.some(message => message.includes('ruleB'))).toBe(true);
   });
});

/**
 * Pins the registration phase guard: a rule may only register at `Parsed` or
 * `Linked` — registering at any later phase throws so the
 * `IntegrityService.SettledState` invariant stays valid. The error message is
 * built from {@link DefaultIntegrityService.formatRule} (`label ?? id`), so the
 * same test pins that the human-readable label is preferred over the id in the
 * message.
 */
describe('IntegrityService.register phase guard', () => {
   it('throws when a rule registers at a phase other than Parsed or Linked', () => {
      const service = makeService();
      expect(() =>
         service.register({
            id: 'late-rule',
            nodeType: 'Foo',
            phase: DocumentState.Validated as unknown as IntegrityPhase,
            enforce: () => false
         })
      ).toThrow(/would invalidate IntegrityService.SettledState/);
   });

   it('accepts a rule registered at the Linked phase (the other allowed phase)', () => {
      const service = makeService();
      expect(() =>
         service.register({ id: 'linked-rule', nodeType: 'Foo', phase: DocumentState.Linked, enforce: () => false })
      ).not.toThrow();
   });

   it('formats the rejected rule by its label (formatRule prefers label over id)', () => {
      const service = makeService();
      let message = '';
      try {
         service.register({
            id: 'rule-id-123',
            label: 'My Friendly Rule',
            nodeType: 'Foo',
            phase: DocumentState.Validated as unknown as IntegrityPhase,
            enforce: () => false
         });
      } catch (err) {
         message = (err as Error).message;
      }
      expect(message).toContain('My Friendly Rule');
      // The id appears nowhere when a label is present — a `label && id`
      // mutant of formatRule would surface the id instead.
      expect(message).not.toContain('rule-id-123');
   });
});

/**
 * Pins the empty-phase-bucket early return: when no rule targets the
 * requested phase, `enforceIntegrity` returns `false` BEFORE doing any
 * per-document work (resolving the workspace-relative URI, streaming the
 * AST). A spy on `wsRelativePath` distinguishes the early return from an
 * `if (false)` mutant that proceeds into the (rule-less) sweep.
 */
describe('IntegrityService.enforceIntegrity empty-phase-bucket short-circuit', () => {
   it('returns false without resolving the workspace-relative URI when no rule targets the phase', async () => {
      const wsRelativeCalls: string[] = [];
      const services = makeIntegrityServices({
         shared: {
            workspace: {
               WorkspaceManager: {
                  wsRelativePath: (uri: { toString(): string }) => {
                     wsRelativeCalls.push(uri.toString());
                     return 'doc.fake';
                  }
               }
            }
         }
      });
      const service = new DefaultIntegrityService<FakeNode>(services);
      // A rule exists, but at a DIFFERENT phase, so the requested phase's
      // bucket is empty — exercising the length-zero short-circuit, not the
      // no-rules-at-all path.
      service.register({ id: 'linked', nodeType: 'Foo', phase: DocumentState.Linked, enforce: () => false });
      const document = buildDocument(makeFakeAstNode<FakeNode>({ $type: 'Root' }), [makeFakeAstNode<FakeNode>({ $type: 'Foo', id: 'a' })]);

      const result = await service.enforceIntegrity(document, DocumentState.Parsed);

      expect(result).toBe(false);
      expect(wsRelativeCalls).toEqual([]);
   });
});

/**
 * Pins the `isOpenInLanguageClient` branch: an open file returns immediately —
 * it never stages pending content (the closed-editor path) and never rewrites
 * authorship. An `if (false)` mutant (open file falls through to the editor-mode
 * staging branch) would survive without this. This pins that staging does not
 * run for open files.
 */
describe('IntegrityService corrections sync — open-file branch isolation', () => {
   it('does not stage pending content or rewrite authorship for an open file (editor mode)', async () => {
      const { probe, textDocuments } = makeCorrectionsProbe('editor');
      textDocuments.openInLanguageClient = true;
      const td = TextDocument.create('file:///open.fake', 'fake', 9, 'corrected');

      await probe.syncCorrectionsNow(td);

      // Open branch took effect: no staging (the CLOSED-file editor-mode path) and
      // no author rewrite — delivery is the ModelService content listener's job.
      expect(textDocuments.setAuthorCalls).toEqual([]);
      expect(textDocuments.stagedContent).toEqual([]);
   });
});

/**
 * Probe exposing the protected {@link DefaultIntegrityService.formatNode} so
 * the node-labelling branches can be asserted directly: the
 * string-typed-and-truthy guards on `name` / `id`, the `name`-before-`id`
 * fallback, and the `Type('label')` wrap.
 */
class FormatNodeProbe extends DefaultIntegrityService<FakeNode> {
   format(node: AstNode): string {
      return this.formatNode(node);
   }
}

function makeFormatNodeProbe(): FormatNodeProbe {
   return new FormatNodeProbe(makeIntegrityServices());
}

describe('IntegrityService.formatNode', () => {
   it("prefers a string name, wrapping it as Type('name')", () => {
      const probe = makeFormatNodeProbe();
      const node = makeFakeAstNode<AstNode>({ $type: 'TypeOne', name: 'ns.Element', id: 'element-1' });
      expect(probe.format(node)).toBe("TypeOne('ns.Element')");
   });

   it('falls through to id when name is an empty string', () => {
      const probe = makeFormatNodeProbe();
      const node = makeFakeAstNode<AstNode>({ $type: 'TypeOne', name: '', id: 'element-1' });
      expect(probe.format(node)).toBe("TypeOne('element-1')");
   });

   it('falls through to id when name is not a string', () => {
      const probe = makeFormatNodeProbe();
      const node = makeFakeAstNode<AstNode>({ $type: 'TypeOne', name: 42, id: 'element-1' });
      expect(probe.format(node)).toBe("TypeOne('element-1')");
   });

   it('returns the bare $type when neither a string name nor a string id is present', () => {
      const probe = makeFormatNodeProbe();
      const node = makeFakeAstNode<AstNode>({ $type: 'TypeTwo' });
      expect(probe.format(node)).toBe('TypeTwo');
   });

   it('ignores a non-string id, returning the bare $type', () => {
      const probe = makeFormatNodeProbe();
      const node = makeFakeAstNode<AstNode>({ $type: 'TypeTwo', id: 99 });
      expect(probe.format(node)).toBe('TypeTwo');
   });
});

/**
 * Pins the phase-bucket cache-identity guard
 * (`if (this.phaseBucketsFor !== current)`). Repeated `getPhaseBucket` calls
 * without an intervening registry mutation must return the SAME cached array
 * reference — an `if (true)` mutant rebuilds the buckets on every call,
 * yielding a fresh array each time.
 */
describe('IntegrityService phase-bucket cache identity', () => {
   it('returns the same array reference across calls when the registry is unchanged', () => {
      const service = makeProbeService();
      service.register({ id: 'a', nodeType: 'Foo', phase: DocumentState.Parsed, enforce: () => false });

      const first = service.bucket(DocumentState.Parsed);
      const second = service.bucket(DocumentState.Parsed);

      expect(second).toBe(first);
   });

   it('returns a new array reference after a registry mutation invalidates the cache', () => {
      const service = makeProbeService();
      service.register({ id: 'a', nodeType: 'Foo', phase: DocumentState.Parsed, enforce: () => false });
      const first = service.bucket(DocumentState.Parsed);

      service.register({ id: 'b', nodeType: 'Foo', phase: DocumentState.Parsed, enforce: () => false });
      const second = service.bucket(DocumentState.Parsed);

      expect(second).not.toBe(first);
   });
});
