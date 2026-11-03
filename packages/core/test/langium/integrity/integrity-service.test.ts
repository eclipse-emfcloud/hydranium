/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { afterEach, describe, expect, it } from 'vitest';
import { asMutable, Disposable, Logger, ProfileCollector } from '@hydranium/protocol';
import { makeFakeClock } from '@hydranium/protocol/testing';
import {
   AbstractAstReflection,
   type AstMetaData,
   type AstNode,
   DocumentState,
   isOperationCancelled,
   type LangiumDocument,
   stream,
   type URI
} from '@hydranium/langium';
import { type ApplyWorkspaceEditParams, CancellationToken, CancellationTokenSource, type TextEdit } from 'vscode-languageserver';
import type { BuildEndedEvent, BuildEndedListener, RunningBuild } from '../../../src/langium/document-builder/document-builder.js';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { HydraniumTextDocuments } from '../../../src/documents/hydranium-text-documents.js';
import { DefaultDocumentUriPolicy } from '../../../src/langium/workspace/document-uri-policy.js';
import { DefaultIntegrityService, IntegrityRun } from '../../../src/langium/integrity/integrity-service.js';
import { virtualUri } from '../../../src/langium/workspace/virtual-document.js';
import type { ServerLanguageServices } from '../../../src/langium/language-module.js';
import type { ServerSharedServices } from '../../../src/langium/module.js';
import { IntegrityPhase, type IntegrityRule, type IntegritySyncMode } from '../../../src/langium/integrity/integrity-rule.js';
import {
   type CapturedLine,
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

/** `TypeOne` and `TypeTwo` are subtypes of the abstract `BaseType`; `UnknownType` is not listed. */
class FixedReflection extends AbstractAstReflection {
   override readonly types: AstMetaData = {
      Root: { name: 'Root', properties: {}, superTypes: [] },
      Foo: { name: 'Foo', properties: {}, superTypes: [] },
      Bar: { name: 'Bar', properties: {}, superTypes: [] },
      BaseType: { name: 'BaseType', properties: {}, superTypes: [] },
      TypeOne: { name: 'TypeOne', properties: {}, superTypes: ['BaseType'] },
      TypeTwo: { name: 'TypeTwo', properties: {}, superTypes: ['BaseType'] }
   };
}

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
   const workspaceOverrides = (workspace as Record<string, unknown>) ?? {};
   return makeNoopLanguageServices({
      shared: {
         AstReflection: new FixedReflection(),
         ...sharedRest,
         workspace: {
            TextDocuments: new FakeTextDocuments(),
            FileSystemProvider: {},
            WorkspaceManager: { wsRelativePath: () => 'doc.fake' },
            ...workspaceOverrides,
            // The service subscribes to build ends at construction.
            DocumentBuilder: { onBuildEnded: () => ({ dispose: () => undefined }), ...(workspaceOverrides.DocumentBuilder ?? {}) }
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

describe('IntegrityService.enforceIntegrity cancellation', () => {
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

   it('honours cancellation at the next per-node interrupt, processing the first node and skipping later ones', async () => {
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

   it('stops the sweep and returns true when cancelled after a rule mutated the AST', async () => {
      // Throwing here would skip the resync and leave the mutation against
      // text the next build does not re-parse.
      const service = makeService();
      const calls: string[] = [];
      const { token, cancel } = makeCancelToken();
      registerRule(service, {
         nodeType: 'Foo',
         onEnforce: node => {
            calls.push((node as FakeNode).id ?? '');
            cancel();
            return true;
         }
      });
      const document = buildDocument(makeFakeAstNode<FakeNode>({ $type: 'Root' }), [
         makeFakeAstNode<FakeNode>({ $type: 'Foo', id: 'a' }),
         makeFakeAstNode<FakeNode>({ $type: 'Foo', id: 'b' })
      ]);

      await expect(service.enforceIntegrity(document, DocumentState.Parsed, token)).resolves.toBe(true);
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

describe('IntegrityService contribution group consumption', () => {
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

class ExactMatchService extends DefaultIntegrityService<FakeNode> {
   protected override nodeTypesFor(rule: IntegrityRule): Iterable<string> {
      return [rule.nodeType];
   }
}

describe('IntegrityService node type matching', () => {
   async function enforcedIds(service: DefaultIntegrityService<FakeNode>, nodeType: string): Promise<string[]> {
      const ids: string[] = [];
      registerRule(service, {
         nodeType,
         onEnforce: node => {
            ids.push(node.id ?? '');
            return false;
         }
      });
      const document = buildDocument(makeFakeAstNode<FakeNode>({ $type: 'Root' }), [
         makeFakeAstNode<FakeNode>({ $type: 'TypeOne', id: 'one' }),
         makeFakeAstNode<FakeNode>({ $type: 'TypeTwo', id: 'two' }),
         makeFakeAstNode<FakeNode>({ $type: 'UnknownType', id: 'unknown' })
      ]);
      await service.enforceIntegrity(document, DocumentState.Parsed);
      return ids;
   }

   it('runs a rule keyed on an abstract type on every node of a subtype', async () => {
      await expect(enforcedIds(makeService(), 'BaseType')).resolves.toEqual(['one', 'two']);
   });

   it('runs a rule keyed on a concrete type once per node of that type', async () => {
      await expect(enforcedIds(makeService(), 'TypeOne')).resolves.toEqual(['one']);
   });

   it('runs a rule keyed on a type the reflection does not know on nodes of exactly that type', async () => {
      await expect(enforcedIds(makeService(), 'UnknownType')).resolves.toEqual(['unknown']);
   });

   it('warns at registration about a rule keyed on a type the reflection does not know, and only that rule', () => {
      const { tracer, lines } = makeCapturingTracer();
      const service = new DefaultIntegrityService<FakeNode>(makeIntegrityServices({ shared: { Tracer: tracer } }));

      service.register({ id: 'known', nodeType: 'BaseType', phase: DocumentState.Parsed, enforce: () => false });
      service.register({ id: 'unknown', nodeType: 'UnknownType', phase: DocumentState.Parsed, enforce: () => false });

      const warnings = lines.filter(line => line.level === 'warn').map(line => line.message);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("'unknown'");
      expect(warnings[0]).toContain("'UnknownType'");
   });

   it('lets a subclass narrow the match to the exact type through nodeTypesFor', async () => {
      await expect(enforcedIds(new ExactMatchService(makeIntegrityServices()), 'BaseType')).resolves.toEqual([]);
   });

   it.each(
      [
         { basePriority: 1, ownPriority: 2, expected: ['base', 'own'] },
         { basePriority: 2, ownPriority: 1, expected: ['own', 'base'] }
      ].map(entry => [entry.expected.join(' then '), entry] as const)
   )(
      'runs a supertype rule and a subtype rule on one node in priority order %s',
      async (_order, { basePriority, ownPriority, expected }) => {
         const service = makeService();
         const order: string[] = [];
         const record = (id: string): boolean => {
            order.push(id);
            return false;
         };
         service.register({
            id: 'base',
            nodeType: 'BaseType',
            phase: DocumentState.Parsed,
            priority: basePriority,
            enforce: () => record('base')
         });
         service.register({
            id: 'own',
            nodeType: 'TypeOne',
            phase: DocumentState.Parsed,
            priority: ownPriority,
            enforce: () => record('own')
         });
         const document = buildDocument(makeFakeAstNode<FakeNode>({ $type: 'Root' }), [makeFakeAstNode<FakeNode>({ $type: 'TypeOne' })]);

         await service.enforceIntegrity(document, DocumentState.Parsed);

         expect(order).toEqual(expected);
      }
   );
});

/**
 * Probe subclass exposing the protected {@link DefaultIntegrityService.getPhaseBucket}
 * so the phase-bucket cache and priority ordering can be asserted directly.
 */
class ProbeService extends DefaultIntegrityService<FakeNode> {
   bucket(phase: DocumentState): ReadonlyMap<string, readonly IntegrityRule[]> {
      return this.getPhaseBucket(phase);
   }

   bucketIds(phase: DocumentState, nodeType: string): string[] | undefined {
      return this.bucket(phase)
         .get(nodeType)
         ?.map(rule => rule.id);
   }
}

function makeProbeService(): ProbeService {
   return new ProbeService(makeIntegrityServices());
}

class RelinkedByProbe extends DefaultIntegrityService<FakeNode> {
   relinkedBy(document: LangiumDocument, changed: LangiumDocument): boolean {
      return this.isRelinkedBy(document, changed);
   }
}

describe('IntegrityService dependents of a changed document', () => {
   /** A multi-reference whose `items` read counts in `reads`, as a read resolves it. */
   const multiReference = (items: unknown, reads: string[]): object => ({
      $refText: 'x',
      _items: items,
      get items() {
         reads.push('items');
         return Array.isArray(items) ? items : [];
      }
   });

   it('reads no unresolved multi-reference, as the read would resolve one that links nothing', () => {
      const probe = new RelinkedByProbe(makeIntegrityServices());
      const changed = makeFakeDocument('file:///changed.fake', makeFakeAstNode<FakeNode>({ $type: 'Foo' }));
      const dependent = makeFakeDocument('file:///dependent.fake', makeFakeAstNode<FakeNode>({ $type: 'Foo' }));
      const reads: string[] = [];
      asMutable(dependent).references = [multiReference(undefined, reads) as LangiumDocument['references'][number]];

      expect(probe.relinkedBy(dependent, changed)).toBe(false);
      expect(reads).toEqual([]);
   });

   it('counts a resolved multi-reference into the changed document', () => {
      const probe = new RelinkedByProbe(makeIntegrityServices());
      const changed = makeFakeDocument('file:///changed.fake', makeFakeAstNode<FakeNode>({ $type: 'Foo' }));
      const dependent = makeFakeDocument('file:///dependent.fake', makeFakeAstNode<FakeNode>({ $type: 'Foo' }));
      const items = [{ $nodeDescription: { documentUri: changed.uri } }];
      asMutable(dependent).references = [multiReference(items, []) as LangiumDocument['references'][number]];

      expect(probe.relinkedBy(dependent, changed)).toBe(true);
   });
});

describe('IntegrityService phase buckets', () => {
   it('invalidates the cached bucket on unregister, leaving only the surviving rule', () => {
      const service = makeProbeService();
      service.register({ id: 'keep', nodeType: 'Foo', phase: DocumentState.Parsed, enforce: () => false });
      service.register({ id: 'drop', nodeType: 'Bar', phase: DocumentState.Parsed, enforce: () => false });
      // Prime the cache so we exercise the unregister-driven invalidation path.
      expect(service.bucketIds(DocumentState.Parsed, 'Bar')).toEqual(['drop']);

      service.unregister('drop');

      expect(service.bucketIds(DocumentState.Parsed, 'Bar')).toBeUndefined();
      expect(service.bucketIds(DocumentState.Parsed, 'Foo')).toEqual(['keep']);
   });

   it('orders rules in a phase bucket by priority ascending, then registration order for ties', () => {
      const service = makeProbeService();
      // Registered out of priority order: b (priority 2) before a (priority 1).
      service.register({ id: 'b', nodeType: 'Foo', phase: DocumentState.Parsed, priority: 2, enforce: () => false });
      service.register({ id: 'a', nodeType: 'Foo', phase: DocumentState.Parsed, priority: 1, enforce: () => false });
      // Tie at priority 2 with `b`: registration order keeps `b` before `c`.
      service.register({ id: 'c', nodeType: 'Foo', phase: DocumentState.Parsed, priority: 2, enforce: () => false });

      expect(service.bucketIds(DocumentState.Parsed, 'Foo')).toEqual(['a', 'b', 'c']);
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
 * `resyncDocument` make: authorship marks and staged pending content. `update` returns a real {@link TextDocument}
 * carrying `newText` so the reparse-guard branch can read it back.
 */
class RecordingTextDocuments {
   readonly setAuthorCalls: AuthorCall[] = [];
   readonly stagedContent: { uri: string; text: string }[] = [];
   openInLanguageClient = false;
   /** Held by a client other than the language client — the data or GLSP head. */
   openInOtherClient = false;
   /** Open for no client, but waiting out the release grace after its last client's connection was lost. */
   releasePending = false;
   /** What `get` answers, by URI: the store's own document for a held URI. */
   readonly held = new Map<string, TextDocument>();

   get(uri: string): TextDocument | undefined {
      return this.held.get(uri);
   }

   isOpenInLanguageClient(): boolean {
      return this.openInLanguageClient;
   }

   isOpenInAnyClient(): boolean {
      return this.openInLanguageClient || this.openInOtherClient;
   }

   isReleaseDeferred(): boolean {
      return this.releasePending;
   }

   setAuthor(uri: string, version: number, author: string): void {
      this.setAuthorCalls.push({ uri, version, author });
   }

   stagePendingContent(uri: string, text: string): void {
      this.stagedContent.push({ uri, text });
   }

   /** Every disk baseline the service records, in order. */
   readonly diskBaselines: { uri: string; text: string | undefined }[] = [];

   setDiskBaseline(uri: string, text: string | undefined): void {
      this.diskBaselines.push({ uri, text });
   }

   /**
    * This stub holds no synced documents, so `undefined` — "nothing open here to
    * commit into" — is the truthful answer, and it routes `resyncDocument` down
    * the same fallback a CLOSED document takes. That is the branch these tests
    * are about; the open-document commit needs the real store, because what it
    * commits into is the object the store holds and a stub holds none.
    */
   commitRepair(): { status: 'not-open' } {
      return { status: 'not-open' };
   }

   /** Consistent with {@link commitRepair}: a stub with no synced documents. */
   isOpen(): boolean {
      return false;
   }

   update(document: TextDocument, changes: { text: string }[], version: number): TextDocument {
      return TextDocument.create(document.uri, document.languageId, version, changes[changes.length - 1].text);
   }
}

class RecordingFileSystemProvider {
   readonly writes: { uri: string; content: string }[] = [];
   /** What `readFile` answers, by URI; a URI missing here reads as a missing file. */
   readonly onDisk = new Map<string, string>();
   /** Whether `writeFile` rejects, as a full disk or a revoked permission does. */
   failWrites = false;
   /** Runs while a read is pending, before it answers. */
   duringRead: () => void = () => undefined;
   /** Whether a disk-queue task is running; set by the harness's queue double. */
   inDiskQueue: () => boolean = () => false;
   /** Every read and write made while no disk-queue task was running. */
   readonly outsideDiskQueue: string[] = [];

   readFile(uri: { toString(): string }): Promise<string> {
      if (!this.inDiskQueue()) {
         this.outsideDiskQueue.push(`read ${uri.toString()}`);
      }
      this.duringRead();
      const content = this.onDisk.get(uri.toString());
      return content === undefined ? Promise.reject(new Error(`no such file: ${uri.toString()}`)) : Promise.resolve(content);
   }

   writeFile(uri: { toString(): string } | string, content: string): Promise<void> {
      if (!this.inDiskQueue()) {
         this.outsideDiskQueue.push(`write ${uri.toString()}`);
      }
      if (this.failWrites) {
         return Promise.reject(new Error(`cannot write: ${uri.toString()}`));
      }
      this.writes.push({ uri: uri.toString(), content });
      return Promise.resolve();
   }
}

/** Probe exposing the protected correction-sync entry points. */
class CorrectionsProbe extends DefaultIntegrityService<FakeNode> {
   syncCorrectionsNow(document: TextDocument, parsedFrom?: string): Promise<void> {
      return this.syncCorrections(document, parsedFrom);
   }
   resyncNow(document: LangiumDocument, cancelToken?: CancellationToken): Promise<void> {
      return this.resyncDocument(document, cancelToken);
   }
}

interface CorrectionsHarness {
   probe: CorrectionsProbe;
   textDocuments: RecordingTextDocuments;
   fileSystemProvider: RecordingFileSystemProvider;
   /** URIs passed to the (stubbed) document builder's reconciliation methods. */
   builderCalls: { reparse: string[]; reparseAndRelink: string[] };
   /** URIs of the tasks queued through the (stubbed) file-system task queue. */
   diskTasks: string[];
   /** What the service reported to `VersionSyncService.modelProduced`, in order. */
   produced: { uri: string; text: string | undefined }[];
   /** Every line the service logged. */
   lines: CapturedLine[];
   /** The services the probe was built with, for a second language on the same server. */
   services: ServerLanguageServices;
}

function makeCorrectionsProbe(
   options: IntegritySyncMode | { syncMode?: IntegritySyncMode; onReparse?: () => void } = {},
   serializeResult = 'serialized-text'
): CorrectionsHarness {
   const textDocuments = new RecordingTextDocuments();
   const fileSystemProvider = new RecordingFileSystemProvider();
   const builderCalls = { reparse: [] as string[], reparseAndRelink: [] as string[] };
   const diskTasks: string[] = [];
   const produced: CorrectionsHarness['produced'] = [];
   const { tracer, lines } = makeCapturingTracer();
   let runningDiskTasks = 0;
   fileSystemProvider.inDiskQueue = () => runningDiskTasks > 0;
   const syncMode = typeof options === 'string' ? options : options.syncMode;
   const onReparse = typeof options === 'string' ? undefined : options.onReparse;
   const services = makeIntegrityServices({
      shared: {
         Tracer: tracer,
         workspace: {
            TextDocuments: textDocuments,
            FileSystemProvider: fileSystemProvider,
            // resyncDocument delegates re-parse / re-link to the framework builder;
            // record which method each branch (Parsed vs Linked) invokes.
            DocumentBuilder: {
               reparse: async (document: LangiumDocument) => {
                  builderCalls.reparse.push(document.uri.toString());
                  onReparse?.();
               },
               reparseAndRelink: async (document: LangiumDocument) => {
                  builderCalls.reparseAndRelink.push(document.uri.toString());
               }
            },
            // A Linked-phase correction looks for the documents that reference the repaired one.
            LangiumDocuments: { all: stream([]) },
            VersionSyncService: {
               modelProduced: (document: LangiumDocument, origin?: { text?: string }) => {
                  produced.push({ uri: document.uri.toString(), text: origin?.text });
               }
            },
            FileSystemTaskQueue: {
               enqueue: async <T>(uri: string, task: () => Promise<T>): Promise<T> => {
                  diskTasks.push(uri);
                  runningDiskTasks++;
                  try {
                     return await task();
                  } finally {
                     runningDiskTasks--;
                  }
               }
            }
            // syncCorrections asks the text store directly whether any client
            // holds the document (`isOpenInAnyClient` canonicalizes internally,
            // so a symlinked open file is recognised across the R/S divergence);
            // the RecordingTextDocuments open flags drive it.
         }
      },
      serializer: { Serializer: { serializeAst: () => serializeResult } }
   });
   const probe = new CorrectionsProbe(services, syncMode ? { syncMode } : {});
   return { probe, textDocuments, fileSystemProvider, builderCalls, diskTasks, produced, lines, services };
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

   it('writes corrected text to disk for a closed file in silent mode, through its disk queue', async () => {
      const { probe, textDocuments, fileSystemProvider, diskTasks } = makeCorrectionsProbe('silent');
      textDocuments.openInLanguageClient = false;
      const td = TextDocument.create('file:///closed.fake', 'fake', 3, 'corrected');

      await probe.syncCorrectionsNow(td);

      expect(fileSystemProvider.writes).toEqual([{ uri: 'file:///closed.fake', content: 'corrected' }]);
      expect(diskTasks).toEqual(['file:///closed.fake']);
      expect(fileSystemProvider.outsideDiskQueue).toEqual([]);
      expect(textDocuments.setAuthorCalls).toEqual([]);
   });

   it('persists nothing for a virtual document in silent mode, rather than writing it to a derived path', async () => {
      // A virtual document has no disk backing at all, so "closed" does not mean
      // "on disk somewhere" for it. Silent mode must skip the write instead of
      // handing the URI to the filesystem provider: `URI.fsPath` yields a path
      // for any scheme, so the write either lands somewhere unrelated (the
      // provider derives `<cwd>/<contributor>/<name>`) or, against a provider
      // that refuses a URI it cannot reach, rejects and fails the whole build
      // for a repair that was never persistable. The repair still
      // rides the in-memory AST and the text store, which is where a virtual
      // document lives.
      const { probe, textDocuments, fileSystemProvider } = makeCorrectionsProbe('silent');
      textDocuments.openInLanguageClient = false;
      const td = TextDocument.create(virtualUri('probe-contributor', 'built-in.fake').toString(), 'fake', 3, 'corrected');

      await probe.syncCorrectionsNow(td);

      expect(fileSystemProvider.writes).toEqual([]);
      expect(textDocuments.stagedContent).toEqual([]);
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

   it('re-versions even when the build is cancelled mid-resync, the correction already being persisted', async () => {
      // The one place cancellation must NOT short-circuit. `syncCorrections` has
      // already written (or staged) the repair by the time the re-parse runs, so
      // a preempted build that skipped the re-version would leave the store's
      // sequence describing text that is no longer there — which is the defect
      // the re-version exists to prevent, reintroduced on the cancel path.
      const cancellation = makeCancelToken();
      const harness = makeCorrectionsProbe({ syncMode: 'silent', onReparse: () => cancellation.cancel() }, 'new-serialized');
      harness.textDocuments.openInLanguageClient = false;
      const doc = makeResyncDocument('file:///cancelled.fake', 'old-text', DocumentState.Parsed);

      await harness.probe.resyncNow(doc, cancellation.token);

      // The write is the premise, not a bonus assertion: without it there would
      // be nothing for the sequence to have fallen behind.
      expect(harness.fileSystemProvider.writes).toHaveLength(1);
      expect(harness.produced).toEqual([{ uri: 'file:///cancelled.fake', text: 'new-serialized' }]);
   });

   it('delegates a Parsed-phase correction to builder.reparse and a Linked-phase one to reparseAndRelink', async () => {
      // A correction found while the document is still at Parsed only needs a re-parse:
      // the build pipeline re-runs the later phases (scopes/link/…) on the fresh AST.
      const parsedHarness = makeCorrectionsProbe('silent', 'new-serialized');
      const parsedDoc = makeResyncDocument('file:///parsed.fake', 'old-text', DocumentState.Parsed);

      await parsedHarness.probe.resyncNow(parsedDoc);

      expect(parsedHarness.builderCalls.reparse).toEqual(['file:///parsed.fake']);
      expect(parsedHarness.builderCalls.reparseAndRelink).toEqual([]);
      // The Parsed branch re-versions against the REPAIRED text, because the
      // re-parse renumbers a closed document and the store's own reconciliation
      // already ran with the pre-repair content.
      expect(parsedHarness.produced).toEqual([{ uri: 'file:///parsed.fake', text: 'new-serialized' }]);

      // A correction found after linking must re-parse AND re-link in place — the build has
      // already passed those phases, and a stale CST would otherwise strand the mutated AST.
      const linkedHarness = makeCorrectionsProbe('silent', 'new-serialized');
      const linkedDoc = makeResyncDocument('file:///linked.fake', 'old-text', DocumentState.Linked);

      await linkedHarness.probe.resyncNow(linkedDoc);

      expect(linkedHarness.builderCalls.reparseAndRelink).toEqual(['file:///linked.fake']);
      expect(linkedHarness.builderCalls.reparse).toEqual([]);
      // And so does the Linked branch. `reparseAndRelink` re-fires the Parsed
      // notification, so the store's own reconciliation runs — but against the
      // text on DISK, which in editor mode is the pre-repair text, so the
      // repaired text still has to be reconciled here.
      expect(linkedHarness.produced).toEqual([{ uri: 'file:///linked.fake', text: 'new-serialized' }]);
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

describe('IntegrityService.enforceBatch', () => {
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

   it('runs no rule on a document with lexer or parser errors, so a recovered AST is never written back', async () => {
      const { logger } = makeCapturingLogger();
      const probe = makeBatchProbe(logger);
      const visited: string[] = [];
      probe.register({
         id: 'always',
         nodeType: 'Foo',
         phase: DocumentState.Parsed,
         enforce: node => {
            visited.push((node as FakeNode).id ?? '');
            return true;
         }
      });
      const { token } = makeCancelToken();
      const withParseResult = (uri: string, parseResult: Partial<LangiumDocument['parseResult']>): LangiumDocument => {
         const root = makeFakeAstNode<FakeNode>({ $type: 'Root' });
         const node = makeFakeAstNode<FakeNode>({ $type: 'Foo', id: uri });
         asMutable(node).$container = root;
         root._children = [node];
         return makeFakeDocument(uri, root, { parseResult });
      };
      const documents = [
         withParseResult('file:///parser.fake', {
            parserErrors: [{ message: 'Expecting token of type ID' }] as LangiumDocument['parseResult']['parserErrors']
         }),
         withParseResult('file:///lexer.fake', {
            lexerReport: { diagnostics: [{ message: 'unexpected character', offset: 0, line: 1, column: 1, length: 1, severity: 'error' }] }
         }),
         withParseResult('file:///lexer-unrated.fake', {
            lexerReport: { diagnostics: [{ message: 'unexpected character', offset: 0, line: 1, column: 1, length: 1 }] }
         }),
         withParseResult('file:///lexer-errors.fake', {
            lexerErrors: [{ message: 'unexpected character', offset: 0, line: 1, column: 1, length: 1 }]
         }),
         withParseResult('file:///warning.fake', {
            lexerReport: { diagnostics: [{ message: 'odd character', offset: 0, line: 1, column: 1, length: 1, severity: 'warning' }] }
         })
      ];

      await probe.enforceBatch(documents, DocumentState.Parsed, token);

      expect(visited).toEqual(['file:///warning.fake']);
      expect(probe.resyncedUris).toEqual(['file:///warning.fake']);
   });

   it('resyncs a mutated document before honouring a cancellation that arrived during its sweep', async () => {
      const { logger } = makeCapturingLogger();
      const probe = makeBatchProbe(logger);
      const { token, cancel } = makeCancelToken();
      probe.register({
         id: 'mutate-then-cancel',
         nodeType: 'Foo',
         phase: DocumentState.Parsed,
         enforce: node => {
            if ((node as FakeNode).id !== 'hit') {
               return false;
            }
            cancel();
            return true;
         }
      });
      const documents = [
         batchDocument('file:///b.fake', [makeFakeAstNode<FakeNode>({ $type: 'Foo', id: 'hit' })]),
         batchDocument('file:///c.fake', [makeFakeAstNode<FakeNode>({ $type: 'Foo', id: 'hit' })])
      ];

      const caught = await probe.enforceBatch(documents, DocumentState.Parsed, token).then(
         () => undefined,
         (err: unknown) => err
      );

      expect(isOperationCancelled(caught)).toBe(true);
      // The mutated document is resynced; the next one is left to the build that cancelled this.
      expect(probe.resyncedUris).toEqual(['file:///b.fake']);
   });

   it('tolerates an undefined integrity slot with zero rules and an empty phase bucket', async () => {
      const service = new DefaultIntegrityService<FakeNode>(makeIntegrityServices());
      const document = buildDocument(makeFakeAstNode<FakeNode>({ $type: 'Root' }), [makeFakeAstNode<FakeNode>({ $type: 'Foo', id: 'a' })]);

      const result = await service.enforceIntegrity(document, DocumentState.Parsed);

      expect(result).toBe(false);
   });

   it.each([
      ['Parsed', DocumentState.Parsed],
      ['Linked', DocumentState.Linked]
   ] as const)('keeps captured rule timings separate across languages at %s', async (phaseName, phase) => {
      Logger.setLevel('off');
      const clock = makeFakeClock();
      const { tracer } = makeCapturingTracer(clock);
      const collector = new ProfileCollector();
      collector.start();
      try {
         for (const { languageId, duration, count } of [
            { languageId: 'first', duration: 2, count: 2 },
            { languageId: 'second', duration: 3, count: 1 }
         ]) {
            const service = new DefaultIntegrityService<FakeNode>(
               makeIntegrityServices({ shared: { Tracer: tracer }, LanguageMetaData: { languageId } })
            );
            service.register({
               id: 'shared-rule',
               nodeType: 'Foo',
               phase,
               enforce: () => {
                  clock.advance(duration);
                  return false;
               }
            });
            const document = batchDocument(
               `file:///${languageId}.fake`,
               Array.from({ length: count }, () => makeFakeAstNode<FakeNode>({ $type: 'Foo' }))
            );
            await service.enforceBatch([document], phase, CancellationToken.None);
         }
      } finally {
         collector.stop();
      }

      expect(collector.records(10)).toEqual([
         { session: `integrity first ${phaseName}`, id: 'shared-rule', count: 2, selfMs: 4, selfPct: 40 },
         { session: `integrity second ${phaseName}`, id: 'shared-rule', count: 1, selfMs: 3, selfPct: 30 }
      ]);
   });

   it('profiles per-rule self-time and reports it line-based at debug level', async () => {
      const { tracer, lines } = makeCapturingTracer(makeFakeClock());
      const service = new DefaultIntegrityService<FakeNode>(
         makeIntegrityServices({ shared: { Tracer: tracer }, LanguageMetaData: { languageId: 'test' } })
      );
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
 * Pins the open-file branches: a file any client holds never stages pending
 * content (the closed-editor path) and never rewrites authorship, and it
 * reaches disk only in silent mode, only for a holder other than the language
 * client, and only when disk holds the text the repair was computed from. An
 * `if (false)` mutant (open file falls through to the closed-file branches)
 * would survive without this: silent mode would then write unsaved store text
 * to disk.
 */
describe('IntegrityService corrections sync isolating the open-file branch', () => {
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

   for (const syncMode of ['silent', 'editor'] as const) {
      it(`treats a file waiting out the release grace as held, so its unsaved source reaches no disk and no stage (${syncMode} mode)`, async () => {
         const { probe, textDocuments, fileSystemProvider } = makeCorrectionsProbe(syncMode);
         textDocuments.releasePending = true;
         fileSystemProvider.onDisk.set('file:///held.fake', 'saved');
         const td = TextDocument.create('file:///held.fake', 'fake', 5, 'corrected');

         // Parsed from the lost client's unsaved edit, which the grace keeps.
         await probe.syncCorrectionsNow(td, 'unsaved');

         expect(fileSystemProvider.writes).toEqual([]);
         expect(textDocuments.stagedContent).toEqual([]);
      });

      it(`neither writes disk nor stages for a held file whose source is not what disk holds (${syncMode} mode)`, async () => {
         const { probe, textDocuments, fileSystemProvider } = makeCorrectionsProbe(syncMode);
         textDocuments.openInOtherClient = true;
         fileSystemProvider.onDisk.set('file:///held.fake', 'saved');
         const td = TextDocument.create('file:///held.fake', 'fake', 5, 'corrected');

         // Parsed from an unsaved edit, which a disk write would carry along.
         await probe.syncCorrectionsNow(td, 'unsaved');

         expect(fileSystemProvider.writes).toEqual([]);
         expect(textDocuments.stagedContent).toEqual([]);
      });
   }

   it('writes a held file in silent mode when its source is what disk holds, reading and writing in one disk-queue task', async () => {
      const { probe, textDocuments, fileSystemProvider, diskTasks } = makeCorrectionsProbe('silent');
      textDocuments.openInOtherClient = true;
      fileSystemProvider.onDisk.set('file:///held.fake', 'saved');
      const td = TextDocument.create('file:///held.fake', 'fake', 5, 'corrected');
      textDocuments.held.set('file:///held.fake', td);

      await probe.syncCorrectionsNow(td, 'saved');

      expect(fileSystemProvider.writes).toEqual([{ uri: 'file:///held.fake', content: 'corrected' }]);
      expect(diskTasks).toEqual(['file:///held.fake']);
      expect(fileSystemProvider.outsideDiskQueue).toEqual([]);
      expect(textDocuments.stagedContent).toEqual([]);
   });

   it("records the repair it writes to a held file as that file's disk baseline, and no other", async () => {
      const { probe, textDocuments, fileSystemProvider } = makeCorrectionsProbe('silent');
      textDocuments.openInOtherClient = true;
      fileSystemProvider.onDisk.set('file:///held.fake', 'saved');
      const td = TextDocument.create('file:///held.fake', 'fake', 5, 'corrected');
      textDocuments.held.set('file:///held.fake', td);

      await probe.syncCorrectionsNow(td, 'moved on');
      expect(textDocuments.diskBaselines).toEqual([]);
      await probe.syncCorrectionsNow(td, 'saved');

      expect(textDocuments.diskBaselines).toEqual([{ uri: 'file:///held.fake', text: 'corrected' }]);
   });

   it('writes nothing when an edit lands while disk is being read', async () => {
      // The document is the store's own object, so a newer edit changes it in
      // place while the read is pending. The repair is then older than the
      // store, and writing either text could overwrite a save of that edit.
      const { probe, textDocuments, fileSystemProvider } = makeCorrectionsProbe('silent');
      textDocuments.openInOtherClient = true;
      fileSystemProvider.onDisk.set('file:///held.fake', 'saved');
      const td = TextDocument.create('file:///held.fake', 'fake', 5, 'corrected');
      textDocuments.held.set('file:///held.fake', td);
      fileSystemProvider.duringRead = () => TextDocument.update(td, [{ text: 'newer unsaved' }], 6);

      await probe.syncCorrectionsNow(td, 'saved');

      expect(td.getText()).toBe('newer unsaved');
      expect(fileSystemProvider.writes).toEqual([]);
   });

   it('writes nothing when an editor attaches while disk is being read', async () => {
      const { probe, textDocuments, fileSystemProvider } = makeCorrectionsProbe('silent');
      textDocuments.openInOtherClient = true;
      fileSystemProvider.onDisk.set('file:///held.fake', 'saved');
      const td = TextDocument.create('file:///held.fake', 'fake', 5, 'corrected');
      textDocuments.held.set('file:///held.fake', td);
      fileSystemProvider.duringRead = () => (textDocuments.openInLanguageClient = true);

      await probe.syncCorrectionsNow(td, 'saved');

      expect(fileSystemProvider.writes).toEqual([]);
      expect(textDocuments.diskBaselines).toEqual([]);
   });

   it('neither writes nor stages a held file in editor mode, even when its source is what disk holds', async () => {
      const { probe, textDocuments, fileSystemProvider } = makeCorrectionsProbe('editor');
      textDocuments.openInOtherClient = true;
      fileSystemProvider.onDisk.set('file:///held.fake', 'saved');
      const td = TextDocument.create('file:///held.fake', 'fake', 5, 'corrected');

      await probe.syncCorrectionsNow(td, 'saved');

      expect(fileSystemProvider.writes).toEqual([]);
      expect(textDocuments.stagedContent).toEqual([]);
   });

   it('does not write a held file in silent mode without the source text, or when disk cannot be read', async () => {
      const { probe, textDocuments, fileSystemProvider } = makeCorrectionsProbe('silent');
      textDocuments.openInOtherClient = true;
      fileSystemProvider.onDisk.set('file:///held.fake', 'saved');

      await probe.syncCorrectionsNow(TextDocument.create('file:///held.fake', 'fake', 5, 'corrected'));
      await probe.syncCorrectionsNow(TextDocument.create('file:///missing.fake', 'fake', 5, 'corrected'), 'saved');

      expect(fileSystemProvider.writes).toEqual([]);
   });
});

describe('IntegrityService reporting a silent write-back', () => {
   const infoLines = (lines: CapturedLine[]): string[] => lines.filter(line => line.level === 'info').map(line => line.message);

   it('logs the first write of a closed file at info, naming the file and the sync mode, and no later write', async () => {
      const { probe, lines } = makeCorrectionsProbe('silent');

      await probe.syncCorrectionsNow(TextDocument.create('file:///first.fake', 'fake', 3, 'corrected'));
      await probe.syncCorrectionsNow(TextDocument.create('file:///second.fake', 'fake', 3, 'corrected'));

      const info = infoLines(lines);
      expect(info).toHaveLength(1);
      expect(info[0]).toContain('file:///first.fake');
      expect(info[0]).toContain('syncMode');
   });

   it('logs once for a server whose two languages both write, since they hold the same shared services', async () => {
      const { probe, services, lines } = makeCorrectionsProbe('silent');
      const otherLanguage = new CorrectionsProbe({ ...services }, { syncMode: 'silent' });

      await probe.syncCorrectionsNow(TextDocument.create('file:///first.fake', 'fake', 3, 'corrected'));
      await otherLanguage.syncCorrectionsNow(TextDocument.create('file:///second.other', 'other', 3, 'corrected'));

      expect(infoLines(lines)).toHaveLength(1);
   });

   it('keeps the once-guard for a subclass that overrides only the reported line', async () => {
      const { services } = makeCorrectionsProbe('silent');
      const reported: string[] = [];
      class Reworded extends CorrectionsProbe {
         protected override reportSilentWrite(uri: string): void {
            reported.push(uri);
         }
      }
      const probe = new Reworded(services, { syncMode: 'silent' });

      await probe.syncCorrectionsNow(TextDocument.create('file:///first.fake', 'fake', 3, 'corrected'));
      await probe.syncCorrectionsNow(TextDocument.create('file:///second.fake', 'fake', 3, 'corrected'));

      expect(reported).toEqual(['file:///first.fake']);
   });

   it('logs again for a second server, which holds shared services of its own', async () => {
      const first = makeCorrectionsProbe('silent');
      const second = makeCorrectionsProbe('silent');

      await first.probe.syncCorrectionsNow(TextDocument.create('file:///first.fake', 'fake', 3, 'corrected'));
      await second.probe.syncCorrectionsNow(TextDocument.create('file:///second.fake', 'fake', 3, 'corrected'));

      expect(infoLines(first.lines)).toHaveLength(1);
      expect(infoLines(second.lines)).toHaveLength(1);
   });

   it('logs the first write of a held file, not a skipped one, and counts it for closed files too', async () => {
      const { probe, textDocuments, fileSystemProvider, lines } = makeCorrectionsProbe('silent');
      textDocuments.openInOtherClient = true;
      fileSystemProvider.onDisk.set('file:///held.fake', 'saved');
      const td = TextDocument.create('file:///held.fake', 'fake', 5, 'corrected');
      textDocuments.held.set('file:///held.fake', td);

      await probe.syncCorrectionsNow(td, 'unsaved');
      expect(infoLines(lines)).toEqual([]);
      await probe.syncCorrectionsNow(td, 'saved');
      textDocuments.openInOtherClient = false;
      await probe.syncCorrectionsNow(TextDocument.create('file:///closed.fake', 'fake', 3, 'corrected'));

      const info = infoLines(lines);
      expect(info).toHaveLength(1);
      expect(info[0]).toContain('file:///held.fake');
   });

   it('logs nothing for a write that fails, and reports the next write that succeeds', async () => {
      const { probe, fileSystemProvider, lines } = makeCorrectionsProbe('silent');
      fileSystemProvider.failWrites = true;

      await expect(probe.syncCorrectionsNow(TextDocument.create('file:///failed.fake', 'fake', 3, 'corrected'))).rejects.toThrow();
      expect(infoLines(lines)).toEqual([]);
      fileSystemProvider.failWrites = false;
      await probe.syncCorrectionsNow(TextDocument.create('file:///written.fake', 'fake', 3, 'corrected'));

      const info = infoLines(lines);
      expect(info).toHaveLength(1);
      expect(info[0]).toContain('file:///written.fake');
   });

   it('logs nothing in editor mode, which stages instead of writing', async () => {
      const { probe, lines } = makeCorrectionsProbe('editor');

      await probe.syncCorrectionsNow(TextDocument.create('file:///closed.fake', 'fake', 3, 'corrected'));

      expect(infoLines(lines)).toEqual([]);
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

describe('DefaultIntegrityService.formatNode', () => {
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
 * without an intervening registry mutation must return the SAME cached map
 * reference — an `if (true)` mutant rebuilds the buckets on every call,
 * yielding a fresh map each time.
 */
describe('IntegrityService phase-bucket cache identity', () => {
   it('returns the same map reference across calls when the registry is unchanged', () => {
      const service = makeProbeService();
      service.register({ id: 'a', nodeType: 'Foo', phase: DocumentState.Parsed, enforce: () => false });

      const first = service.bucket(DocumentState.Parsed);
      const second = service.bucket(DocumentState.Parsed);

      expect(second).toBe(first);
   });

   it('returns a new map reference after a registry mutation invalidates the cache', () => {
      const service = makeProbeService();
      service.register({ id: 'a', nodeType: 'Foo', phase: DocumentState.Parsed, enforce: () => false });
      const first = service.bucket(DocumentState.Parsed);

      service.register({ id: 'b', nodeType: 'Foo', phase: DocumentState.Parsed, enforce: () => false });
      const second = service.bucket(DocumentState.Parsed);

      expect(second).not.toBe(first);
   });
});

/** Relinks a repaired document's dependents in place of the resync, and counts every other document as one. */
class RelinkProbe extends DefaultIntegrityService<FakeNode> {
   /** The documents whose dependents this service relinked. */
   readonly relinkedFor: LangiumDocument[] = [];
   protected override async relinkDependents(document: LangiumDocument, run: IntegrityRun): Promise<void> {
      this.relinkedFor.push(document);
      await super.relinkDependents(document, run);
   }
   protected override async resyncDocument(
      document: LangiumDocument,
      _cancelToken?: CancellationToken,
      run: IntegrityRun = IntegrityRun.create([document])
   ): Promise<void> {
      await this.relinkDependents(document, run);
   }
   protected override isRelinkedBy(): boolean {
      return true;
   }
}

interface RelinkHarness {
   probe: RelinkProbe;
   /** `a`, `b`, `c` and `d`, all linked. */
   documents: Record<'a' | 'b' | 'c' | 'd', LangiumDocument>;
   /** Each relink the builder was asked for, as `cause>document`. */
   relinked: string[];
   lines: CapturedLine[];
   /** Each document a build after this one was requested for. */
   rebuilds: string[];
   /** Tell the services that a build ended, as the builder does. */
   endBuild(event: BuildEndedEvent): void;
}

function makeRelinkHarness(
   options: { maxRepeatRepairs?: number; linking?: boolean; maxRepeatRepairsOfB?: number; rereads?: string[]; throws?: string[] } = {}
): RelinkHarness & { probeOfB: RelinkProbe } {
   const { tracer, lines } = makeCapturingTracer();
   const nameOf = (document: LangiumDocument): string => document.uri.path.slice(1, -'.fake'.length);
   const make = (name: string): LangiumDocument => {
      const document = batchDocument(`file:///${name}.fake`, [makeFakeAstNode<FakeNode>({ $type: 'Foo', id: name })]);
      document.state = DocumentState.Linked;
      return document;
   };
   const documents = { a: make('a'), b: make('b'), c: make('c'), d: make('d') };
   const relinked: string[] = [];
   const rebuilds: string[] = [];
   const buildEnded: BuildEndedListener[] = [];
   const reread = new Set<LangiumDocument>();
   const services = makeIntegrityServices({
      shared: {
         Tracer: tracer,
         // `b` is of another language when `maxRepeatRepairsOfB` is set.
         ServiceRegistry: {
            getServices: (uri: URI) => ({ integrity: { IntegrityService: uri.path === '/b.fake' ? probeOfB : probe } })
         },
         workspace: {
            LangiumDocuments: { all: stream(Object.values(documents)) },
            VersionSyncService: { rebuildWhileCurrent: (document: LangiumDocument) => void rebuilds.push(nameOf(document)) },
            DocumentBuilder: {
               onBuildEnded: (listener: BuildEndedListener) => {
                  buildEnded.push(listener);
                  return { dispose: () => undefined };
               },
               relinkInRunningBuild: async (document: LangiumDocument, cause: LangiumDocument) => {
                  relinked.push(`${nameOf(cause)}>${nameOf(document)}`);
                  if (options.throws?.includes(nameOf(document))) {
                     throw new Error(`relink of ${nameOf(document)}`);
                  }
                  if (options.rereads?.includes(nameOf(document)) && !reread.has(document)) {
                     // Re-read once, which replaces its root as a re-parse does.
                     reread.add(document);
                     Object.assign(document.parseResult, { value: makeFakeAstNode<FakeNode>({ $type: 'Foo', id: nameOf(document) }) });
                  }
                  return options.linking ?? true;
               }
            }
         }
      }
   });
   const probe = new RelinkProbe(services, { maxRepeatRepairs: options.maxRepeatRepairs });
   const probeOfB =
      options.maxRepeatRepairsOfB === undefined ? probe : new RelinkProbe(services, { maxRepeatRepairs: options.maxRepeatRepairsOfB });
   const endBuild = (event: BuildEndedEvent): void => buildEnded.forEach(listener => listener(event));
   return { probe, probeOfB, documents, relinked, lines, rebuilds, endBuild };
}

describe('IntegrityService relink of the dependents of a Linked-phase repair', () => {
   it('runs the rules again of a relinked dependent that ran them already, or that no batch of the run holds', async () => {
      const { probe, documents, relinked } = makeRelinkHarness();
      const { a, b, c } = documents;
      const runs: string[] = [];
      probe.register({
         id: 'once',
         nodeType: 'Foo',
         phase: DocumentState.Linked,
         enforce: node => {
            const id = (node as FakeNode).id!;
            runs.push(id);
            return id === 'a' && runs.filter(run => run === 'a').length === 1;
         }
      });

      await probe.enforceBatch([b, a, c], DocumentState.Linked, CancellationToken.None);

      // `c` at its own turn, `b` and `d` after the batch.
      expect(relinked).toEqual(['a>c', 'a>b', 'a>d']);
      expect(runs).toEqual(['b', 'a', 'c', 'b', 'd']);
   });

   it("relinks the dependents of a dependent the relink re-read through its own language's service", async () => {
      const { probe, probeOfB, documents, relinked } = makeRelinkHarness({ maxRepeatRepairsOfB: 3, rereads: ['b'] });
      const { a, b } = documents;
      probe.register({
         id: 'once',
         nodeType: 'Foo',
         phase: DocumentState.Linked,
         enforce: node => (node as FakeNode).id === 'a' && probe.relinkedFor.length === 0
      });

      await probe.enforceBatch([a], DocumentState.Linked, CancellationToken.None);

      expect(probe.relinkedFor).toEqual([a]);
      expect(probeOfB.relinkedFor).toEqual([b]);
      // `c` and `d` once, by the re-read `b` that selected them last.
      expect(relinked).toEqual(['a>b', 'b>c', 'b>d', 'b>a']);
   });

   it('relinks a dependent once for all the repairs that select it before its own turn, or before the batch ends', async () => {
      const { probe, documents, relinked } = makeRelinkHarness();
      const { a, b } = documents;
      const runs: string[] = [];
      probe.register({
         id: 'once-each',
         nodeType: 'Foo',
         phase: DocumentState.Linked,
         enforce: node => {
            const id = (node as FakeNode).id!;
            runs.push(id);
            return (id === 'a' || id === 'b') && runs.filter(run => run === id).length === 1;
         }
      });

      await probe.enforceBatch([a, b], DocumentState.Linked, CancellationToken.None);

      // `b` before its own turn, so its rules run once. The rest after the batch, by the repair that selected them last.
      expect(relinked).toEqual(['a>b', 'b>c', 'b>d', 'b>a']);
      expect(runs).toEqual(['a', 'b', 'c', 'd', 'a']);
   });

   it('relinks the dependents a repair selected before a cancel ends the batch, as the next build relinks only those of its changes', async () => {
      const { probe, documents, relinked } = makeRelinkHarness();
      const { a, b, c } = documents;
      const source = new CancellationTokenSource();
      probe.register({
         id: 'repair-a',
         nodeType: 'Foo',
         phase: DocumentState.Linked,
         enforce: node => {
            source.cancel();
            return (node as FakeNode).id === 'a';
         }
      });

      await expect(probe.enforceBatch([a, b, c], DocumentState.Linked, source.token)).rejects.toThrow();

      expect(relinked).toEqual(['a>b', 'a>c', 'a>d']);
   });

   it('requests a build of a repaired document whose dependents a later throw in the batch left unrelinked', async () => {
      const { probe, documents, relinked, rebuilds } = makeRelinkHarness();
      const { a, b, c } = documents;
      probe.register({
         id: 'repair-a-throw-b',
         nodeType: 'Foo',
         phase: DocumentState.Linked,
         enforce: node => {
            if ((node as FakeNode).id === 'b') {
               throw new Error('rule of b');
            }
            return (node as FakeNode).id === 'a';
         }
      });

      await expect(probe.enforceBatch([a, b, c], DocumentState.Linked, CancellationToken.None)).rejects.toThrow('rule of b');

      // `b` at its own turn, `c` and `d` left to the build.
      expect(relinked).toEqual(['a>b']);
      expect(rebuilds).toEqual(['a']);
   });

   it('rejects with the cancel when a relink after it throws, and requests a build for the dependents still unrelinked', async () => {
      const { probe, documents, relinked, rebuilds } = makeRelinkHarness({ throws: ['c'] });
      const { a, b } = documents;
      const source = new CancellationTokenSource();
      probe.register({
         id: 'repair-a',
         nodeType: 'Foo',
         phase: DocumentState.Linked,
         enforce: node => {
            source.cancel();
            return (node as FakeNode).id === 'a';
         }
      });

      await expect(probe.enforceBatch([a, b], DocumentState.Linked, source.token)).rejects.toSatisfy(isOperationCancelled);

      expect(relinked).toEqual(['a>b', 'a>c']);
      expect(rebuilds).toEqual(['a']);
   });

   it.each(['throw', 'passes before'])(
      "keeps a tokenless build's %s guard when another build completes before it repairs again",
      async guard => {
         const { probe, documents, rebuilds, endBuild } = makeRelinkHarness({ throws: guard === 'throw' ? ['b'] : [] });
         const { a } = documents;
         let repairs = true;
         probe.register({
            id: 'repair-a',
            nodeType: 'Foo',
            phase: DocumentState.Linked,
            enforce: node => repairs && (node as FakeNode).id === 'a'
         });
         const [first, active, other, clean, last] = [1, 2, 3, 4, 5].map((): RunningBuild => ({
            documents: [a],
            documentSet: new Set([a]),
            options: {},
            cancelToken: CancellationToken.None
         }));
         const enforceIn = async (build: RunningBuild): Promise<void> => {
            const result = probe.enforceBatch(
               [a],
               DocumentState.Linked,
               build.cancelToken,
               IntegrityRun.create([a], { build, passesBefore: guard === 'passes before' })
            );
            if (repairs && guard === 'throw') {
               await expect(result).rejects.toThrow('relink of b');
            } else {
               await result;
            }
         };

         await enforceIn(first);
         expect(rebuilds).toEqual(['a']);
         endBuild({ completed: false, cancelTokens: [CancellationToken.None] });
         repairs = false;
         await enforceIn(active);
         endBuild({ completed: true, build: other });
         repairs = true;
         await enforceIn(active);
         expect(rebuilds).toEqual(['a']);
         // A listener may catch the fault and let its build complete.
         endBuild({ completed: true, build: active });
         await enforceIn(last);
         expect(rebuilds).toEqual(['a']);

         repairs = false;
         await enforceIn(clean);
         endBuild({ completed: true, build: clean });
         repairs = true;
         await enforceIn(last);
         expect(rebuilds).toEqual(['a', 'a']);
      }
   );

   it.each(['throw', 'passes before'])(
      "keeps a tokenless build's pending %s guard lift when another tokenless build throws",
      async guard => {
         const { probe, documents, rebuilds, endBuild } = makeRelinkHarness({ throws: guard === 'throw' ? ['b'] : [] });
         const { a } = documents;
         let repairs = true;
         probe.register({
            id: 'repair-a',
            nodeType: 'Foo',
            phase: DocumentState.Linked,
            enforce: node => repairs && (node as FakeNode).id === 'a'
         });
         const [first, clean, last] = [1, 2, 3].map((): RunningBuild => ({
            documents: [a],
            documentSet: new Set([a]),
            options: {},
            cancelToken: CancellationToken.None
         }));
         const enforceIn = async (build: RunningBuild): Promise<void> => {
            const result = probe.enforceBatch(
               [a],
               DocumentState.Linked,
               build.cancelToken,
               IntegrityRun.create([a], { build, passesBefore: guard === 'passes before' })
            );
            if (repairs && guard === 'throw') {
               await expect(result).rejects.toThrow('relink of b');
            } else {
               await result;
            }
         };

         await enforceIn(first);
         expect(rebuilds).toEqual(['a']);
         repairs = false;
         await enforceIn(clean);
         endBuild({ completed: false, cancelTokens: [CancellationToken.None] });
         endBuild({ completed: true, build: clean });
         repairs = true;
         await enforceIn(last);
         expect(rebuilds).toEqual(['a', 'a']);
      }
   );

   it('keeps standalone guards when an unrelated builder completes', async () => {
      const { probe, documents, rebuilds, endBuild } = makeRelinkHarness({ throws: ['b'] });
      const { a } = documents;
      let repairs = true;
      probe.register({
         id: 'repair-a',
         nodeType: 'Foo',
         phase: DocumentState.Linked,
         enforce: node => repairs && (node as FakeNode).id === 'a'
      });
      await expect(probe.enforceBatch([a], DocumentState.Linked, CancellationToken.None)).rejects.toThrow('relink of b');
      repairs = false;
      await probe.enforceBatch([a], DocumentState.Linked, CancellationToken.None);
      endBuild({ completed: true, cancelToken: CancellationToken.None });
      repairs = true;
      await expect(probe.enforceBatch([a], DocumentState.Linked, CancellationToken.None)).rejects.toThrow('relink of b');
      expect(rebuilds).toEqual(['a']);
   });

   it("warns naming the repairing rule instead of running a dependent's rules again past maxRepeatRepairs in one run", async () => {
      const { probe, documents, lines } = makeRelinkHarness({ maxRepeatRepairs: 1 });
      const { a, b } = documents;
      const runs: string[] = [];
      // `a` and `b` repair each other without end.
      probe.register({
         id: 'ping',
         nodeType: 'Foo',
         phase: DocumentState.Linked,
         enforce: node => {
            const id = (node as FakeNode).id!;
            runs.push(id);
            return id === 'a' || id === 'b';
         }
      });

      await probe.enforceBatch([a, b], DocumentState.Linked, CancellationToken.None);

      expect(runs.filter(run => run === 'a')).toHaveLength(2);
      expect(runs.filter(run => run === 'b')).toHaveLength(2);
      const warnings = lines.filter(line => line.level === 'warn').map(line => line.message);
      // Once, for the run of `a` it skips, which ends the cycle.
      expect(warnings).toHaveLength(1);
      expect(warnings.every(warning => warning.includes("Integrity rule 'ping'"))).toBe(true);
   });

   it("bounds a dependent's repeat repairs by the maxRepeatRepairs of its own language", async () => {
      const { probe, probeOfB, documents, lines } = makeRelinkHarness({ maxRepeatRepairs: 3, maxRepeatRepairsOfB: 1 });
      const { a, b } = documents;
      const runs: string[] = [];
      // `a` and `b` repair each other without end, each by its own language's rule.
      const ping = (id: string): IntegrityRule => ({
         id: `ping-${id}`,
         nodeType: 'Foo',
         phase: DocumentState.Linked,
         enforce: node => {
            runs.push((node as FakeNode).id!);
            return (node as FakeNode).id === id;
         }
      });
      probe.register(ping('a'));
      probeOfB.register(ping('b'));
      const run = IntegrityRun.create([a, b]);

      await probe.enforceBatch([a], DocumentState.Linked, CancellationToken.None, run);
      await probeOfB.enforceBatch([b], DocumentState.Linked, CancellationToken.None, run);

      expect(runs.filter(run => run === 'b')).toHaveLength(2);
      expect(runs.filter(run => run === 'a')).toHaveLength(3);
      expect(lines.filter(line => line.level === 'warn')).toHaveLength(1);
   });

   it('warns once for a document whose rules run again no more, however many repairs relink it after', async () => {
      const { probe, documents, lines } = makeRelinkHarness({ maxRepeatRepairs: 1 });
      const { a, b, c } = documents;
      const runs: string[] = [];
      // `a` and `b` repair each other without end, and `c`'s one repair in a batch after relinks both again.
      probe.register({
         id: 'ping',
         nodeType: 'Foo',
         phase: DocumentState.Linked,
         enforce: node => {
            const id = (node as FakeNode).id!;
            runs.push(id);
            return id === 'a' || id === 'b' || (id === 'c' && runs.filter(run => run === 'c').length === 1);
         }
      });

      const run = IntegrityRun.create([a, b, c]);

      await probe.enforceBatch([a, b], DocumentState.Linked, CancellationToken.None, run);
      await probe.enforceBatch([c], DocumentState.Linked, CancellationToken.None, run);

      const warnings = lines.filter(line => line.level === 'warn').map(line => line.message);
      // One for each of `a` and `b`, the first time each is skipped.
      expect(warnings).toHaveLength(2);
   });

   it("runs the rules of a dependent again for every language's batch whose repairs select it when they repair nothing", async () => {
      const { probe, documents, lines } = makeRelinkHarness({ maxRepeatRepairs: 1 });
      const { a, b, c, d } = documents;
      const runs: string[] = [];
      probe.register({
         id: 'first-run',
         nodeType: 'Foo',
         phase: DocumentState.Linked,
         enforce: node => {
            const id = (node as FakeNode).id!;
            runs.push(id);
            return id !== 'd' && runs.filter(run => run === id).length === 1;
         }
      });

      const run = IntegrityRun.create([d, a, b, c]);

      for (const document of [d, a, b, c]) {
         await probe.enforceBatch([document], DocumentState.Linked, CancellationToken.None, run);
      }

      // Its own run, then one after each of the three batches that repair.
      expect(runs.filter(run => run === 'd')).toHaveLength(4);
      expect(lines.filter(line => line.level === 'warn')).toEqual([]);
   });

   it('runs no rule again when no running build links the repaired document', async () => {
      const { probe, documents, relinked } = makeRelinkHarness({ linking: false });
      const { a, b } = documents;
      const runs: string[] = [];
      probe.register({
         id: 'always-a',
         nodeType: 'Foo',
         phase: DocumentState.Linked,
         enforce: node => {
            runs.push((node as FakeNode).id!);
            return (node as FakeNode).id === 'a';
         }
      });

      await probe.enforceBatch([b, a], DocumentState.Linked, CancellationToken.None);

      expect(relinked).toEqual(['a>b', 'a>c', 'a>d']);
      expect(runs).toEqual(['b', 'a']);
   });
});
