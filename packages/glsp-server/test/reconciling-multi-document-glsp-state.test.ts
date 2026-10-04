/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, expect, it } from 'vitest';
import { ClientId, GModelIndex, GModelSerializer, ModelState } from '@eclipse-glsp/server';
import 'reflect-metadata';
import { Container, injectable } from 'inversify';
import { type AstNode, DocumentState } from '@hydranium/langium';
import { AstDocument, type ClientSession, DefaultModelLedger, type ServerSharedServices } from '@hydranium/core';
import {
   type BaseVersion,
   asModelVersion,
   ConflictError,
   type ConflictResolver,
   type ReconcileOutcome,
   ReconcilingConflictResolver,
   type TransferElement,
   UNRECORDED_VERSION
} from '@hydranium/protocol';
import { makeFakeAstNode, makeStubServiceRegistry } from '@hydranium/core/testing';
import { HydraniumGlspIndex } from '../src/state/hydranium-glsp-index.js';
import { type MultiDocumentSourceModel, ReconcilingMultiDocumentGlspState } from '../src/state/reconciling-multi-document-glsp-state.js';
import { HydraniumTypes } from '../src/state/hydranium-shared-core-services.js';

interface TestRoot extends AstNode {
   readonly $type: 'TestRoot';
   readonly label: string;
}

interface TestPrimary extends TransferElement {
   $type: string;
   label: string;
}

type TestComposite = MultiDocumentSourceModel<TestPrimary>;

const DIAGRAM_URI = 'file:///ws/a.diagram';
const SEMANTIC_URI = 'file:///ws/a.semantic';
const OTHER_URI = 'file:///ws/b.semantic';

function makeRoot(label: string): TestRoot {
   return makeFakeAstNode<TestRoot>({ $type: 'TestRoot', label });
}

interface FakeDocument {
   uri: { toString(): string };
   state: DocumentState;
   parseResult: { value: AstNode };
   textDocument?: { version: number; getText(): string };
}

/**
 * Project a fake document into the envelope `ModelService.snapshot` returns.
 * Only `version` is read by the state, but the shape stays faithful so a stub
 * cannot pass a test the real service would fail.
 */
function toSnapshot(uri: string, document: FakeDocument | undefined): AstDocument<AstNode, never> | undefined {
   return document && AstDocument.create(uri, document.textDocument?.version ?? 0, document.parseResult.value);
}

interface UpdateEntry {
   uri: string;
   model: unknown;
   baseVersion: BaseVersion;
}

interface Harness {
   readonly warns: string[];
   readonly debugs: string[];
   readonly documents: Map<string, FakeDocument>;
   /** Every `updateAll` the diagram's session received, one entry list per call. */
   readonly updateAllCalls: UpdateEntry[][];
   /** Every call the diagram's session received, in order: `open <uri>` or `updateAll`. */
   readonly sessionCalls: string[];
   /** URI whose next write set fails with a `ConflictError`, once. */
   conflictOn: string | undefined;
   /** Error the next write set fails with, once. */
   failNextWrite: Error | undefined;
   nextUpdatedRoot: TestRoot;
   /** Roots `ModelService.validated` answers with, by URI. Absent → rejects. */
   readonly validated: Map<string, TestRoot>;
   /** The text store's documents; the stub parser turns a text into a root labelled with it. */
   readonly store: Map<string, { version: number; text: string }>;
   resolve: (
      base: TestComposite,
      ours: TestComposite,
      refetch: () => Promise<TestComposite | undefined>
   ) => Promise<ReconcileOutcome<TestComposite>>;
}

/** The ledger every test's services share; a root is recorded once, so they never collide. */
const ledger = new DefaultModelLedger();

/** A built document parsed from `label` at `version`, and the store holding the same text at the same version. */
function seed(harness: Harness, uri: string, label: string, version: number): void {
   const root = makeRoot(label);
   ledger.record(root, version);
   harness.documents.set(uri, {
      uri: { toString: () => uri },
      state: DocumentState.Validated,
      parseResult: { value: root },
      textDocument: { version, getText: () => label }
   });
   harness.store.set(uri, { version, text: label });
}

/** The built root {@link seed} registered for `uri`, or an unrecorded one when none was seeded. */
function builtRoot(harness: Harness, uri: string): TestRoot {
   return (harness.documents.get(uri)?.parseResult.value as TestRoot | undefined) ?? makeRoot('diagram');
}

@injectable()
class TestMultiState extends ReconcilingMultiDocumentGlspState<TestRoot, TestPrimary> {
   get exposedBase(): TestComposite | undefined {
      return this.base;
   }
}

/** Creates every secondary it writes. */
@injectable()
class CreatingSecondaryState extends TestMultiState {
   protected override openForWrite(session: ClientSession<AstNode>, uri: string): Promise<void> {
      return uri === this.sourceUri ? session.open(uri) : this.createSecondaryDocument(session, uri, 'created');
   }
}

/** Forces secondary writes through the hook. */
@injectable()
class ForcedSecondaryState extends TestMultiState {
   protected override secondaryBaseVersion(): BaseVersion {
      return 'any';
   }
}

function makeHarness(): Harness {
   return {
      warns: [],
      debugs: [],
      documents: new Map(),
      updateAllCalls: [],
      sessionCalls: [],
      conflictOn: undefined,
      failNextWrite: undefined,
      nextUpdatedRoot: makeRoot('updated'),
      validated: new Map(),
      store: new Map(),
      resolve: async (_base, ours) => ({ status: 'merged', merged: ours })
   };
}

function createState(harness: Harness, stateClass: new () => TestMultiState = TestMultiState): TestMultiState {
   const childLogger = {
      info: () => undefined,
      warn: (msg: string) => harness.warns.push(msg),
      error: () => undefined,
      debug: (msg: string) => harness.debugs.push(msg),
      async time<T>(_label: string, callback: () => Promise<T> | T): Promise<T> {
         return await callback();
      }
   };
   const sharedServices = {
      ServiceRegistry: makeStubServiceRegistry([{ languageId: 'test', fileExtensions: ['.diagram', '.semantic'] }]),
      Tracer: { for: () => ({ withUri: () => childLogger }) },
      workspace: {
         ModelLedger: ledger,
         DocumentUriPolicy: { canonicalUri: (uri: string) => uri },
         LangiumDocuments: {
            getDocument: (uri: { toString(): string }) => harness.documents.get(uri.toString())
         },
         TextDocuments: {
            get(uri: string): { version: number; getText(): string } | undefined {
               const stored = harness.store.get(uri);
               return stored && { version: stored.version, getText: () => stored.text };
            },
            version: (uri: string): number => harness.store.get(uri)?.version ?? 0
         },
         LangiumDocumentFactory: {
            fromString: (text: string) => ({ parseResult: { value: makeRoot(text) } })
         }
      },
      model: {
         TransferEncoder: {
            toTransfer(root: TestRoot, mode?: string): unknown {
               return mode === 'grammar' ? { $type: root.$type, label: root.label } : { ...root };
            }
         },
         ModelService: {
            snapshot: (uri: string) => toSnapshot(uri, harness.documents.get(uri)),
            ensureDocumentState: () => Promise.resolve(),
            getDocument: (uri: string) => harness.documents.get(uri),
            async validated(uri: string): Promise<{ root: TestRoot }> {
               const root = harness.validated.get(uri);
               if (!root) {
                  throw new Error(`no validated root for ${uri}`);
               }
               return { root };
            }
         }
      }
   };
   const conflictResolver: ConflictResolver = {
      resolve: (base, ours, refetch) =>
         harness.resolve(base as TestComposite, ours as TestComposite, refetch as () => Promise<TestComposite | undefined>) as Promise<
            ReconcileOutcome<never>
         >
   };
   const container = new Container();
   container.bind(HydraniumTypes.SharedCoreServices).toConstantValue(sharedServices as unknown as ServerSharedServices);
   container.bind(HydraniumTypes.Tracer).toConstantValue({ withUri: () => childLogger } as never);
   container.bind(HydraniumTypes.ConflictResolver).toConstantValue(conflictResolver);
   container.bind(HydraniumGlspIndex).toSelf().inSingletonScope();
   container.bind(GModelSerializer).toConstantValue({} as GModelSerializer);
   container.bind(GModelIndex).toService(HydraniumGlspIndex);
   container.bind(ClientId).toConstantValue('test-client');
   container.bind(ModelState).to(stateClass).inSingletonScope();
   container.bind(stateClass).toService(ModelState);
   const state = container.get(stateClass);
   state.modelSession = makeRecordingSession(harness);
   return state;
}

/**
 * The diagram's session as the state sees it: records opens and write sets, and
 * fails a write set the way `updateAll` does — before anything applies.
 */
function makeRecordingSession(harness: Harness): ClientSession<AstNode> {
   const session = {
      clientId: 'test-client',
      async open(uri: string): Promise<void> {
         harness.sessionCalls.push(`open ${uri}`);
      },
      async create(uri: string, text: string): Promise<number> {
         harness.sessionCalls.push(`create ${uri}`);
         harness.store.set(uri, { version: 5, text });
         // Another client's write, landing before the creator resumes.
         queueMicrotask(() => harness.store.set(uri, { version: 6, text: 'theirs' }));
         return 5;
      },
      async updateAll(args: { updates: UpdateEntry[] }): Promise<{ root: TestRoot }[]> {
         harness.sessionCalls.push('updateAll');
         harness.updateAllCalls.push(args.updates);
         const failure = harness.failNextWrite;
         harness.failNextWrite = undefined;
         if (failure) {
            throw failure;
         }
         const conflicted = args.updates.find(update => update.uri === harness.conflictOn && update.baseVersion !== 'any');
         if (conflicted) {
            harness.conflictOn = undefined;
            throw new ConflictError(conflicted.uri, asModelVersion(1), 2);
         }
         return args.updates.map(update => ({ root: update.uri === DIAGRAM_URI ? harness.nextUpdatedRoot : makeRoot(update.uri) }));
      }
   };
   return session as unknown as ClientSession<AstNode>;
}

describe('ReconcilingMultiDocumentGlspState', () => {
   describe('the secondary write set', () => {
      it('projects the primary plus every registered secondary', () => {
         const harness = makeHarness();
         seed(harness, DIAGRAM_URI, 'diagram', 3);
         seed(harness, SEMANTIC_URI, 'semantic', 7);
         const state = createState(harness);
         state.setSourceRoot(DIAGRAM_URI, builtRoot(harness, DIAGRAM_URI));
         state.trackSecondaryDocument(SEMANTIC_URI);

         expect(state.sourceModel).toEqual({
            primary: { $type: 'TestRoot', label: 'diagram' },
            secondaries: { [SEMANTIC_URI]: { $type: 'TestRoot', label: 'semantic' } }
         });
      });

      it('omits an unloaded secondary rather than projecting it as undefined', () => {
         // An explicit `undefined` would diff as a removal and persist as a
         // deletion of content the state merely could not see.
         const harness = makeHarness();
         seed(harness, DIAGRAM_URI, 'diagram', 1);
         const state = createState(harness);
         state.setSourceRoot(DIAGRAM_URI, builtRoot(harness, DIAGRAM_URI));
         state.trackSecondaryDocument(SEMANTIC_URI);

         expect(state.sourceModel.secondaries).toEqual({});
         expect(SEMANTIC_URI in state.sourceModel.secondaries).toBe(false);
      });

      it('ignores an attempt to register the primary as a secondary', () => {
         const harness = makeHarness();
         seed(harness, DIAGRAM_URI, 'diagram', 1);
         const state = createState(harness);
         state.setSourceRoot(DIAGRAM_URI, builtRoot(harness, DIAGRAM_URI));
         state.trackSecondaryDocument(DIAGRAM_URI);
         expect(state.secondaryUris).toEqual([]);
      });

      it('records a base version per document, and distinguishes untracked from v0', () => {
         const harness = makeHarness();
         seed(harness, DIAGRAM_URI, 'diagram', 3);
         seed(harness, SEMANTIC_URI, 'semantic', 7);
         const state = createState(harness);
         state.setSourceRoot(DIAGRAM_URI, builtRoot(harness, DIAGRAM_URI));
         state.trackSecondaryDocument(SEMANTIC_URI);

         expect(state.baseVersionOf(DIAGRAM_URI)).toBe(3);
         expect(state.baseVersionOf(SEMANTIC_URI)).toBe(7);
         // `undefined`, not 0 — 0 is a real version meaning "present, never
         // edited", so collapsing them would let a caller gate against a
         // document it never read.
         expect(state.baseVersionOf(OTHER_URI)).toBeUndefined();
      });

      it('records the version the built root was parsed from once the store has moved on', () => {
         const harness = makeHarness();
         seed(harness, DIAGRAM_URI, 'diagram', 1);
         seed(harness, SEMANTIC_URI, 'semantic', 1);
         harness.store.set(SEMANTIC_URI, { version: 2, text: 'semantic, typed' });
         const state = createState(harness);
         state.setSourceRoot(DIAGRAM_URI, builtRoot(harness, DIAGRAM_URI));
         state.trackSecondaryDocument(SEMANTIC_URI);

         expect(state.baseVersionOf(SEMANTIC_URI)).toBe(1);
      });

      it('records a version no write matches for a built root no version was recorded for', () => {
         const harness = makeHarness();
         seed(harness, DIAGRAM_URI, 'diagram', 1);
         seed(harness, SEMANTIC_URI, 'semantic', 1);
         harness.documents.get(SEMANTIC_URI)!.parseResult.value = makeRoot('semantic');
         const state = createState(harness);
         state.setSourceRoot(DIAGRAM_URI, builtRoot(harness, DIAGRAM_URI));
         state.trackSecondaryDocument(SEMANTIC_URI);

         expect(state.baseVersionOf(SEMANTIC_URI)).toBe(UNRECORDED_VERSION);
      });

      it('records a version no write matches for a secondary the builder has not parsed yet', () => {
         const harness = makeHarness();
         seed(harness, DIAGRAM_URI, 'diagram', 1);
         seed(harness, SEMANTIC_URI, 'semantic', 0);
         const placeholder = harness.documents.get(SEMANTIC_URI)!;
         placeholder.state = DocumentState.Changed;
         placeholder.parseResult.value = makeFakeAstNode({ $type: 'INVALID' });
         ledger.record(placeholder.parseResult.value, 0);
         ledger.markPlaceholder(placeholder.parseResult.value);
         const state = createState(harness);
         state.setSourceRoot(DIAGRAM_URI, builtRoot(harness, DIAGRAM_URI));
         state.trackSecondaryDocument(SEMANTIC_URI);

         expect(state.baseVersionOf(SEMANTIC_URI)).toBe(UNRECORDED_VERSION);
      });

      it('records the version of the root a secondary keeps while it is rebuilt', () => {
         const harness = makeHarness();
         seed(harness, DIAGRAM_URI, 'diagram', 1);
         seed(harness, SEMANTIC_URI, 'semantic', 4);
         harness.documents.get(SEMANTIC_URI)!.state = DocumentState.Changed;
         const state = createState(harness);
         state.setSourceRoot(DIAGRAM_URI, builtRoot(harness, DIAGRAM_URI));
         state.trackSecondaryDocument(SEMANTIC_URI);

         expect(state.baseVersionOf(SEMANTIC_URI)).toBe(4);
      });

      it('records a version no write matches for a secondary with no built document', () => {
         // The store counts a file it has not built yet at v0 too.
         const harness = makeHarness();
         seed(harness, DIAGRAM_URI, 'diagram', 1);
         const state = createState(harness);
         state.setSourceRoot(DIAGRAM_URI, builtRoot(harness, DIAGRAM_URI));
         state.trackSecondaryDocument(SEMANTIC_URI);

         expect(state.baseVersionOf(SEMANTIC_URI)).toBe(UNRECORDED_VERSION);
      });

      it('refreshes secondary versions on setSourceRoot, so the next command is not gated on a stale number', () => {
         const harness = makeHarness();
         seed(harness, DIAGRAM_URI, 'diagram', 1);
         seed(harness, SEMANTIC_URI, 'semantic', 7);
         const state = createState(harness);
         state.setSourceRoot(DIAGRAM_URI, builtRoot(harness, DIAGRAM_URI));
         state.trackSecondaryDocument(SEMANTIC_URI);
         expect(state.baseVersionOf(SEMANTIC_URI)).toBe(7);

         // The write that lands advances the secondary too.
         seed(harness, SEMANTIC_URI, 'semantic', 8);
         state.setSourceRoot(DIAGRAM_URI, builtRoot(harness, DIAGRAM_URI));
         expect(state.baseVersionOf(SEMANTIC_URI)).toBe(8);
      });

      it('drops the whole set on untrack', () => {
         const harness = makeHarness();
         seed(harness, DIAGRAM_URI, 'diagram', 1);
         seed(harness, SEMANTIC_URI, 'semantic', 1);
         const state = createState(harness);
         state.setSourceRoot(DIAGRAM_URI, builtRoot(harness, DIAGRAM_URI));
         state.trackSecondaryDocument(SEMANTIC_URI);
         state.untrackSecondaryDocuments();
         expect(state.secondaryUris).toEqual([]);
         expect(state.baseVersionOf(SEMANTIC_URI)).toBeUndefined();
      });
   });

   describe('updateSourceModel', () => {
      it('writes every changed document in one updateAll on the diagram session, each gated', async () => {
         // One call is what makes the set all or none: a conflict on any
         // document is thrown before any text applies.
         const harness = makeHarness();
         seed(harness, DIAGRAM_URI, 'diagram', 4);
         seed(harness, SEMANTIC_URI, 'semantic', 9);
         const state = createState(harness);
         state.setSourceRoot(DIAGRAM_URI, builtRoot(harness, DIAGRAM_URI));
         state.trackSecondaryDocument(SEMANTIC_URI);

         await state.updateSourceModel(
            {
               primary: { $type: 'TestRoot', label: 'edited' },
               secondaries: { [SEMANTIC_URI]: { $type: 'TestRoot', label: 'edited-semantic' } as TestPrimary }
            },
            asModelVersion(4)
         );

         expect(harness.updateAllCalls).toEqual([
            [
               { uri: DIAGRAM_URI, model: { $type: 'TestRoot', label: 'edited' }, baseVersion: 4 },
               // The version the secondary had when the root was read.
               { uri: SEMANTIC_URI, model: { $type: 'TestRoot', label: 'edited-semantic' }, baseVersion: 9 }
            ]
         ]);
      });

      it('opens every document of the set before writing it', async () => {
         // `updateAll` opens nothing, so a secondary the storage has not opened
         // yet would fail the whole set as not open.
         const harness = makeHarness();
         seed(harness, DIAGRAM_URI, 'diagram', 4);
         seed(harness, SEMANTIC_URI, 'semantic', 9);
         const state = createState(harness);
         state.setSourceRoot(DIAGRAM_URI, builtRoot(harness, DIAGRAM_URI));
         state.trackSecondaryDocument(SEMANTIC_URI);

         await state.updateSourceModel(
            {
               primary: { $type: 'TestRoot', label: 'diagram' },
               secondaries: { [SEMANTIC_URI]: { $type: 'TestRoot', label: 's' } as TestPrimary }
            },
            asModelVersion(4)
         );

         expect(harness.sessionCalls).toEqual([`open ${SEMANTIC_URI}`, 'updateAll']);
      });

      it('gates a secondary created for the write on the version it was created at', async () => {
         const harness = makeHarness();
         seed(harness, DIAGRAM_URI, 'diagram', 4);
         const state = createState(harness, CreatingSecondaryState);
         state.setSourceRoot(DIAGRAM_URI, builtRoot(harness, DIAGRAM_URI));
         state.trackSecondaryDocument(SEMANTIC_URI);

         await state.updateSourceModel(
            {
               primary: { $type: 'TestRoot', label: 'diagram' },
               secondaries: { [SEMANTIC_URI]: { $type: 'TestRoot', label: 's' } as TestPrimary }
            },
            asModelVersion(4)
         );

         expect(harness.sessionCalls).toEqual([`create ${SEMANTIC_URI}`, 'updateAll']);
         expect(harness.updateAllCalls.flat().map(update => update.baseVersion)).toEqual([5]);
      });

      it('keeps the primary based on the root it holds when a secondary-only write follows a foreign build of the primary', async () => {
         const harness = makeHarness();
         seed(harness, DIAGRAM_URI, 'diagram', 4);
         seed(harness, SEMANTIC_URI, 'semantic', 9);
         const state = createState(harness);
         state.setSourceRoot(DIAGRAM_URI, builtRoot(harness, DIAGRAM_URI));
         state.trackSecondaryDocument(SEMANTIC_URI);
         seed(harness, DIAGRAM_URI, 'diagram, edited elsewhere', 5);

         await state.updateSourceModel(
            {
               primary: { $type: 'TestRoot', label: 'diagram' },
               secondaries: { [SEMANTIC_URI]: { $type: 'TestRoot', label: 's' } as TestPrimary }
            },
            asModelVersion(4)
         );

         expect(state.baseVersion).toBe(4);
      });

      it('leaves an unchanged document out of the set and keeps the captured root', async () => {
         const harness = makeHarness();
         seed(harness, DIAGRAM_URI, 'diagram', 4);
         seed(harness, SEMANTIC_URI, 'semantic', 9);
         const state = createState(harness);
         const captured = makeRoot('diagram');
         state.setSourceRoot(DIAGRAM_URI, captured);
         state.trackSecondaryDocument(SEMANTIC_URI);
         state.setSourceRoot(DIAGRAM_URI, captured);

         await state.updateSourceModel(
            {
               primary: { $type: 'TestRoot', label: 'diagram' },
               secondaries: { [SEMANTIC_URI]: { $type: 'TestRoot', label: 's' } as TestPrimary }
            },
            asModelVersion(4)
         );

         expect(harness.updateAllCalls.map(call => call.map(update => update.uri))).toEqual([[SEMANTIC_URI]]);
         expect(state.sourceRoot).toBe(captured);
      });

      it('defaults baseVersion to the state model version when the caller passes none', async () => {
         const harness = makeHarness();
         seed(harness, DIAGRAM_URI, 'diagram', 4);
         const state = createState(harness);
         state.setSourceRoot(DIAGRAM_URI, builtRoot(harness, DIAGRAM_URI));

         await state.updateSourceModel({ primary: { $type: 'TestRoot', label: 'edited' }, secondaries: {} });

         // v4 and not `'any'`: the parameter is optional only because GLSP's
         // one-argument `JsonModelState.updateSourceModel` has to stay satisfiable,
         // so the default is what decides whether an ungated write is the easy one.
         expect(harness.updateAllCalls.flat().map(update => update.baseVersion)).toEqual([asModelVersion(4)]);
      });

      it('forces every document of the set when the write is based on any version', async () => {
         // An undo or redo replaying a patch, or a merged retry: the decision to
         // win covers the whole set, or the secondary's stale gate would refuse
         // what the reconcile already accepted.
         const harness = makeHarness();
         seed(harness, DIAGRAM_URI, 'diagram', 4);
         seed(harness, SEMANTIC_URI, 'semantic', 9);
         const state = createState(harness);
         state.setSourceRoot(DIAGRAM_URI, builtRoot(harness, DIAGRAM_URI));
         state.trackSecondaryDocument(SEMANTIC_URI);

         await state.updateSourceModel(
            {
               primary: { $type: 'TestRoot', label: 'edited' },
               secondaries: { [SEMANTIC_URI]: { $type: 'TestRoot', label: 's' } as TestPrimary }
            },
            'any'
         );

         expect(harness.updateAllCalls.flat().map(update => update.baseVersion)).toEqual(['any', 'any']);
      });

      it('forces a secondary when secondaryBaseVersion returns anything', async () => {
         const harness = makeHarness();
         seed(harness, DIAGRAM_URI, 'diagram', 4);
         seed(harness, SEMANTIC_URI, 'semantic', 9);
         const state = createState(harness, ForcedSecondaryState);
         state.setSourceRoot(DIAGRAM_URI, builtRoot(harness, DIAGRAM_URI));
         state.trackSecondaryDocument(SEMANTIC_URI);

         await state.updateSourceModel(
            {
               primary: { $type: 'TestRoot', label: 'edited' },
               secondaries: { [SEMANTIC_URI]: { $type: 'TestRoot', label: 's' } as TestPrimary }
            },
            asModelVersion(4)
         );

         expect(harness.updateAllCalls.flat().map(update => update.baseVersion)).toEqual([4, 'any']);
      });

      it('captures the primary root the write returned', async () => {
         const harness = makeHarness();
         seed(harness, DIAGRAM_URI, 'diagram', 1);
         harness.nextUpdatedRoot = makeRoot('written');
         const state = createState(harness);
         state.setSourceRoot(DIAGRAM_URI, builtRoot(harness, DIAGRAM_URI));

         await state.updateSourceModel({ primary: { $type: 'TestRoot', label: 'x' }, secondaries: {} }, asModelVersion(1));
         expect(state.sourceRoot.label).toBe('written');
      });

      it('reconciles a conflict on a SECONDARY through the shared orchestration', async () => {
         // A gated secondary is reconciled like the primary: a merged outcome
         // re-writes the whole set based on `'any'`.
         const harness = makeHarness();
         seed(harness, DIAGRAM_URI, 'diagram', 1);
         seed(harness, SEMANTIC_URI, 'semantic', 1);
         harness.validated.set(DIAGRAM_URI, makeRoot('theirs'));
         harness.conflictOn = SEMANTIC_URI;
         const state = createState(harness);
         state.setSourceRoot(DIAGRAM_URI, builtRoot(harness, DIAGRAM_URI));
         state.trackSecondaryDocument(SEMANTIC_URI);

         await state.updateSourceModel(
            {
               primary: { $type: 'TestRoot', label: 'edited' },
               secondaries: { [SEMANTIC_URI]: { $type: 'TestRoot', label: 's' } as TestPrimary }
            },
            asModelVersion(1)
         );

         expect(harness.updateAllCalls.map(call => call.map(update => update.baseVersion))).toEqual([
            [1, 1],
            ['any', 'any']
         ]);
      });

      it('drops the edit and resyncs on a conflict outcome', async () => {
         const harness = makeHarness();
         seed(harness, DIAGRAM_URI, 'diagram', 1);
         harness.validated.set(DIAGRAM_URI, makeRoot('theirs'));
         harness.conflictOn = DIAGRAM_URI;
         harness.resolve = async () => ({
            status: 'conflict',
            theirs: { primary: { $type: 'TestRoot', label: 'theirs' }, secondaries: {} }
         });
         const state = createState(harness);
         state.setSourceRoot(DIAGRAM_URI, builtRoot(harness, DIAGRAM_URI));

         await state.updateSourceModel({ primary: { $type: 'TestRoot', label: 'edited' }, secondaries: {} }, asModelVersion(1));

         expect(harness.updateAllCalls).toHaveLength(1);
         expect(harness.warns.some(msg => msg.includes('dropping the diagram edit'))).toBe(true);
      });

      it('re-throws a failed write instead of treating it as a conflict', async () => {
         // Reconciling would retry a write that failed for another reason.
         const harness = makeHarness();
         seed(harness, DIAGRAM_URI, 'diagram', 1);
         seed(harness, SEMANTIC_URI, 'semantic', 1);
         harness.failNextWrite = new Error('disk full');
         const state = createState(harness);
         state.setSourceRoot(DIAGRAM_URI, builtRoot(harness, DIAGRAM_URI));
         state.trackSecondaryDocument(SEMANTIC_URI);

         await expect(
            state.updateSourceModel(
               {
                  primary: { $type: 'TestRoot', label: 'x' },
                  secondaries: { [SEMANTIC_URI]: { $type: 'TestRoot', label: 's' } as TestPrimary }
               },
               asModelVersion(1)
            )
         ).rejects.toThrow('disk full');
         expect(harness.updateAllCalls).toHaveLength(1);
      });

      it('refuses to write without a session, rather than writing under an id it does not hold', async () => {
         const harness = makeHarness();
         seed(harness, DIAGRAM_URI, 'diagram', 1);
         const state = createState(harness);
         state.setSourceRoot(DIAGRAM_URI, builtRoot(harness, DIAGRAM_URI));
         state.modelSession = undefined;

         await expect(
            state.updateSourceModel({ primary: { $type: 'TestRoot', label: 'x' }, secondaries: {} }, asModelVersion(1))
         ).rejects.toThrow(/No client session/);
      });
   });

   describe('refetch', () => {
      it('returns undefined when the primary cannot be read, since there is nothing to merge into', async () => {
         const harness = makeHarness();
         seed(harness, DIAGRAM_URI, 'diagram', 1);
         harness.conflictOn = DIAGRAM_URI;
         // No validated root registered for the primary → refetch fails.
         let refetched: TestComposite | undefined | 'not-called' = 'not-called';
         harness.resolve = async (_base, ours, refetch) => {
            refetched = await refetch();
            return { status: 'merged', merged: ours };
         };
         const state = createState(harness);
         state.setSourceRoot(DIAGRAM_URI, builtRoot(harness, DIAGRAM_URI));

         await state.updateSourceModel({ primary: { $type: 'TestRoot', label: 'x' }, secondaries: {} }, asModelVersion(1));
         expect(refetched).toBeUndefined();
      });

      it('reconciles against the stored text, not a built root an operation handler edited in place', async () => {
         // Until a rebuild replaces it, the built root already holds the edit
         // being reconciled, so the replay finds its own edit as a foreign one.
         const harness = makeHarness();
         seed(harness, DIAGRAM_URI, 'diagram', 1);
         seed(harness, SEMANTIC_URI, 'semantic', 1);
         const state = createState(harness);
         state.setSourceRoot(DIAGRAM_URI, builtRoot(harness, DIAGRAM_URI));
         state.trackSecondaryDocument(SEMANTIC_URI);
         state.setSourceRoot(DIAGRAM_URI, builtRoot(harness, DIAGRAM_URI));
         const built = harness.documents.get(SEMANTIC_URI)!.parseResult.value as TestRoot;
         (built as { label: string }).label = 'semantic, edited';
         harness.validated.set(DIAGRAM_URI, makeRoot('diagram'));
         harness.validated.set(SEMANTIC_URI, built);
         harness.conflictOn = SEMANTIC_URI;
         harness.resolve = (base, ours, refetch) => new ReconcilingConflictResolver().resolve(base, ours, refetch);

         await state.updateSourceModel(
            {
               primary: { $type: 'TestRoot', label: 'diagram' },
               secondaries: { [SEMANTIC_URI]: { $type: 'TestRoot', label: 'semantic, edited' } as TestPrimary }
            },
            asModelVersion(1)
         );

         expect(harness.updateAllCalls).toEqual([
            [{ uri: SEMANTIC_URI, model: { $type: 'TestRoot', label: 'semantic, edited' }, baseVersion: 1 }],
            [{ uri: SEMANTIC_URI, model: { $type: 'TestRoot', label: 'semantic, edited' }, baseVersion: 1 }]
         ]);
      });

      it('includes settled secondaries and omits unreadable ones', async () => {
         const harness = makeHarness();
         seed(harness, DIAGRAM_URI, 'diagram', 1);
         seed(harness, SEMANTIC_URI, 'semantic', 1);
         seed(harness, OTHER_URI, 'other', 1);
         harness.validated.set(DIAGRAM_URI, makeRoot('built-primary'));
         harness.validated.set(SEMANTIC_URI, makeRoot('built-semantic'));
         harness.store.set(DIAGRAM_URI, { version: 2, text: 'theirs-primary' });
         harness.store.set(SEMANTIC_URI, { version: 2, text: 'theirs-semantic' });
         // OTHER_URI deliberately has no validated root.
         harness.conflictOn = DIAGRAM_URI;
         let refetched: TestComposite | undefined;
         harness.resolve = async (_base, ours, refetch) => {
            refetched = await refetch();
            return { status: 'merged', merged: ours };
         };
         const state = createState(harness);
         state.setSourceRoot(DIAGRAM_URI, builtRoot(harness, DIAGRAM_URI));
         state.trackSecondaryDocument(SEMANTIC_URI);
         state.trackSecondaryDocument(OTHER_URI);

         await state.updateSourceModel({ primary: { $type: 'TestRoot', label: 'x' }, secondaries: {} }, asModelVersion(1));

         expect(refetched?.primary).toEqual({ $type: 'TestRoot', label: 'theirs-primary' });
         expect(refetched?.secondaries).toEqual({ [SEMANTIC_URI]: { $type: 'TestRoot', label: 'theirs-semantic' } });
      });
   });

   describe('base', () => {
      it('captures the whole write set on setSourceRoot', () => {
         const harness = makeHarness();
         seed(harness, DIAGRAM_URI, 'diagram', 1);
         seed(harness, SEMANTIC_URI, 'semantic', 1);
         const state = createState(harness);
         state.setSourceRoot(DIAGRAM_URI, builtRoot(harness, DIAGRAM_URI));
         state.trackSecondaryDocument(SEMANTIC_URI);
         // Re-capture now that the secondary is registered.
         state.setSourceRoot(DIAGRAM_URI, builtRoot(harness, DIAGRAM_URI));

         expect(state.exposedBase).toEqual({
            primary: { $type: 'TestRoot', label: 'diagram' },
            secondaries: { [SEMANTIC_URI]: { $type: 'TestRoot', label: 'semantic' } }
         });
      });
   });
});
