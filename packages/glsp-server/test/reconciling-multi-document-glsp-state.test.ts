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
import type { ServerSharedServices } from '@hydranium/core';
import { ConflictError, type ConflictResolver, type ReconcileOutcome, type TransferElement } from '@hydranium/protocol';
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
   textDocument?: { version: number };
}

interface UpdateCall {
   uri: string;
   model: unknown;
   clientId: string;
   baseVersion?: number;
}

interface Harness {
   readonly warns: string[];
   readonly debugs: string[];
   readonly documents: Map<string, FakeDocument>;
   readonly updateCalls: UpdateCall[];
   throwConflictOnPrimaryUpdate: boolean;
   nextUpdatedRoot: TestRoot;
   /** Roots `ModelService.validated` answers with, by URI. Absent → rejects. */
   readonly validated: Map<string, TestRoot>;
   resolve: (
      baseline: TestComposite,
      attempted: TestComposite,
      refetch: () => Promise<TestComposite | undefined>
   ) => Promise<ReconcileOutcome<TestComposite>>;
}

function seed(harness: Harness, uri: string, label: string, version: number): void {
   harness.documents.set(uri, {
      uri: { toString: () => uri },
      state: DocumentState.Validated,
      parseResult: { value: makeRoot(label) },
      textDocument: { version }
   });
}

@injectable()
class TestMultiState extends ReconcilingMultiDocumentGlspState<TestRoot, TestPrimary> {
   get exposedBaseline(): TestComposite | undefined {
      return this.baseline;
   }
}

/** Fails its secondary write, to exercise the partial-write path. */
@injectable()
class FailingSecondaryState extends TestMultiState {
   protected override persistSecondary(): Promise<void> {
      return Promise.reject(new Error('disk full'));
   }
}

function makeHarness(): Harness {
   return {
      warns: [],
      debugs: [],
      documents: new Map(),
      updateCalls: [],
      throwConflictOnPrimaryUpdate: false,
      nextUpdatedRoot: makeRoot('updated'),
      validated: new Map(),
      resolve: async (_baseline, attempted) => ({ status: 'merged', merged: attempted })
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
         LangiumDocuments: {
            getDocument: (uri: { toString(): string }) => harness.documents.get(uri.toString())
         }
      },
      model: {
         TransferEncoder: {
            toTransfer(root: TestRoot, mode?: string): unknown {
               return mode === 'grammar' ? { $type: root.$type, label: root.label } : { ...root };
            }
         },
         ModelService: {
            waitForDocumentState: () => Promise.resolve(),
            getDocument: (uri: string) => harness.documents.get(uri),
            async update(args: UpdateCall): Promise<{ root: TestRoot }> {
               harness.updateCalls.push(args);
               if (args.uri === DIAGRAM_URI && harness.throwConflictOnPrimaryUpdate) {
                  harness.throwConflictOnPrimaryUpdate = false;
                  throw new ConflictError(args.uri, 1, 2);
               }
               return { root: harness.nextUpdatedRoot };
            },
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
      resolve: (baseline, attempted, refetch) =>
         harness.resolve(
            baseline as TestComposite,
            attempted as TestComposite,
            refetch as () => Promise<TestComposite | undefined>
         ) as Promise<ReconcileOutcome<never>>
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
   return container.get(stateClass);
}

describe('ReconcilingMultiDocumentGlspState', () => {
   describe('the secondary write set', () => {
      it('projects the primary plus every registered secondary', () => {
         const harness = makeHarness();
         seed(harness, DIAGRAM_URI, 'diagram', 3);
         seed(harness, SEMANTIC_URI, 'semantic', 7);
         const state = createState(harness);
         state.setSourceRoot(DIAGRAM_URI, makeRoot('diagram'));
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
         state.setSourceRoot(DIAGRAM_URI, makeRoot('diagram'));
         state.trackSecondaryDocument(SEMANTIC_URI);

         expect(state.sourceModel.secondaries).toEqual({});
         expect(SEMANTIC_URI in state.sourceModel.secondaries).toBe(false);
      });

      it('ignores an attempt to register the primary as a secondary', () => {
         const harness = makeHarness();
         seed(harness, DIAGRAM_URI, 'diagram', 1);
         const state = createState(harness);
         state.setSourceRoot(DIAGRAM_URI, makeRoot('diagram'));
         state.trackSecondaryDocument(DIAGRAM_URI);
         expect(state.secondaryUris).toEqual([]);
      });

      it('captures a based-on version per document, and distinguishes untracked from v0', () => {
         const harness = makeHarness();
         seed(harness, DIAGRAM_URI, 'diagram', 3);
         seed(harness, SEMANTIC_URI, 'semantic', 7);
         const state = createState(harness);
         state.setSourceRoot(DIAGRAM_URI, makeRoot('diagram'));
         state.trackSecondaryDocument(SEMANTIC_URI);

         expect(state.capturedVersionOf(DIAGRAM_URI)).toBe(3);
         expect(state.capturedVersionOf(SEMANTIC_URI)).toBe(7);
         // `undefined`, not 0 — 0 is a real version meaning "present, never
         // edited", so collapsing them would let a caller gate against a
         // document it never captured.
         expect(state.capturedVersionOf(OTHER_URI)).toBeUndefined();
      });

      it('refreshes secondary versions on setSourceRoot, so the next command is not gated on a stale number', () => {
         const harness = makeHarness();
         seed(harness, DIAGRAM_URI, 'diagram', 1);
         seed(harness, SEMANTIC_URI, 'semantic', 7);
         const state = createState(harness);
         state.setSourceRoot(DIAGRAM_URI, makeRoot('diagram'));
         state.trackSecondaryDocument(SEMANTIC_URI);
         expect(state.capturedVersionOf(SEMANTIC_URI)).toBe(7);

         // The write that lands advances the secondary too.
         seed(harness, SEMANTIC_URI, 'semantic', 8);
         state.setSourceRoot(DIAGRAM_URI, makeRoot('diagram'));
         expect(state.capturedVersionOf(SEMANTIC_URI)).toBe(8);
      });

      it('drops the whole set on untrack', () => {
         const harness = makeHarness();
         seed(harness, DIAGRAM_URI, 'diagram', 1);
         seed(harness, SEMANTIC_URI, 'semantic', 1);
         const state = createState(harness);
         state.setSourceRoot(DIAGRAM_URI, makeRoot('diagram'));
         state.trackSecondaryDocument(SEMANTIC_URI);
         state.untrackSecondaryDocuments();
         expect(state.secondaryUris).toEqual([]);
         expect(state.capturedVersionOf(SEMANTIC_URI)).toBeUndefined();
      });
   });

   describe('updateSourceModel', () => {
      it('writes secondaries first and the primary last, gating only the primary', async () => {
         // The ordering IS the documented failure-mode choice: a partial write
         // leaves a semantic edit with no diagram entry (repairable) rather than
         // a diagram entry pointing at something that does not exist.
         const harness = makeHarness();
         seed(harness, DIAGRAM_URI, 'diagram', 4);
         seed(harness, SEMANTIC_URI, 'semantic', 9);
         const state = createState(harness);
         state.setSourceRoot(DIAGRAM_URI, makeRoot('diagram'));
         state.trackSecondaryDocument(SEMANTIC_URI);

         await state.updateSourceModel(
            {
               primary: { $type: 'TestRoot', label: 'edited' },
               secondaries: { [SEMANTIC_URI]: { $type: 'TestRoot', label: 'edited-semantic' } as TestPrimary }
            },
            4
         );

         expect(harness.updateCalls.map(call => call.uri)).toEqual([SEMANTIC_URI, DIAGRAM_URI]);
         expect(harness.updateCalls[0].baseVersion).toBeUndefined();
         expect(harness.updateCalls[1].baseVersion).toBe(4);
         expect(harness.updateCalls[1].model).toEqual({ $type: 'TestRoot', label: 'edited' });
      });

      it('captures the primary root the write returned', async () => {
         const harness = makeHarness();
         seed(harness, DIAGRAM_URI, 'diagram', 1);
         harness.nextUpdatedRoot = makeRoot('written');
         const state = createState(harness);
         state.setSourceRoot(DIAGRAM_URI, makeRoot('diagram'));

         await state.updateSourceModel({ primary: { $type: 'TestRoot', label: 'x' }, secondaries: {} }, 1);
         expect(state.sourceRoot.label).toBe('written');
      });

      it('reconciles a primary conflict through the shared orchestration', async () => {
         // Proves the multi-document state gets the identical conflict handling
         // rather than a second copy of it: a merged outcome re-persists without
         // a baseVersion, exactly as the single-document state does.
         const harness = makeHarness();
         seed(harness, DIAGRAM_URI, 'diagram', 1);
         seed(harness, SEMANTIC_URI, 'semantic', 1);
         harness.validated.set(DIAGRAM_URI, makeRoot('fresh'));
         harness.throwConflictOnPrimaryUpdate = true;
         const state = createState(harness);
         state.setSourceRoot(DIAGRAM_URI, makeRoot('diagram'));
         state.trackSecondaryDocument(SEMANTIC_URI);

         await state.updateSourceModel(
            {
               primary: { $type: 'TestRoot', label: 'edited' },
               secondaries: { [SEMANTIC_URI]: { $type: 'TestRoot', label: 's' } as TestPrimary }
            },
            1
         );

         const primaryWrites = harness.updateCalls.filter(call => call.uri === DIAGRAM_URI);
         expect(primaryWrites).toHaveLength(2);
         expect(primaryWrites[0].baseVersion).toBe(1);
         expect(primaryWrites[1].baseVersion).toBeUndefined();
      });

      it('drops the edit and resyncs on a conflict outcome', async () => {
         const harness = makeHarness();
         seed(harness, DIAGRAM_URI, 'diagram', 1);
         harness.validated.set(DIAGRAM_URI, makeRoot('fresh'));
         harness.throwConflictOnPrimaryUpdate = true;
         harness.resolve = async () => ({
            status: 'conflict',
            fresh: { primary: { $type: 'TestRoot', label: 'fresh' }, secondaries: {} }
         });
         const state = createState(harness);
         state.setSourceRoot(DIAGRAM_URI, makeRoot('diagram'));

         await state.updateSourceModel({ primary: { $type: 'TestRoot', label: 'edited' }, secondaries: {} }, 1);

         expect(harness.updateCalls.filter(call => call.uri === DIAGRAM_URI)).toHaveLength(1);
         expect(harness.warns.some(msg => msg.includes('dropping the diagram edit'))).toBe(true);
      });

      it('re-throws a failed SECONDARY write instead of treating it as a conflict', async () => {
         // The partial-write window made explicit: the secondary fails, the
         // primary is never attempted, and the error surfaces rather than being
         // funnelled into conflict reconciliation (which would silently retry).
         const harness = makeHarness();
         seed(harness, DIAGRAM_URI, 'diagram', 1);
         seed(harness, SEMANTIC_URI, 'semantic', 1);
         const state = createState(harness, FailingSecondaryState);
         state.setSourceRoot(DIAGRAM_URI, makeRoot('diagram'));
         state.trackSecondaryDocument(SEMANTIC_URI);

         await expect(
            state.updateSourceModel(
               {
                  primary: { $type: 'TestRoot', label: 'x' },
                  secondaries: { [SEMANTIC_URI]: { $type: 'TestRoot', label: 's' } as TestPrimary }
               },
               1
            )
         ).rejects.toThrow('disk full');
         expect(harness.updateCalls.filter(call => call.uri === DIAGRAM_URI)).toEqual([]);
      });
   });

   describe('refetch', () => {
      it('returns undefined when the primary cannot be read, since there is nothing to merge into', async () => {
         const harness = makeHarness();
         seed(harness, DIAGRAM_URI, 'diagram', 1);
         harness.throwConflictOnPrimaryUpdate = true;
         // No validated root registered for the primary → refetch fails.
         let refetched: TestComposite | undefined | 'not-called' = 'not-called';
         harness.resolve = async (_baseline, attempted, refetch) => {
            refetched = await refetch();
            return { status: 'merged', merged: attempted };
         };
         const state = createState(harness);
         state.setSourceRoot(DIAGRAM_URI, makeRoot('diagram'));

         await state.updateSourceModel({ primary: { $type: 'TestRoot', label: 'x' }, secondaries: {} }, 1);
         expect(refetched).toBeUndefined();
      });

      it('includes settled secondaries and omits unreadable ones', async () => {
         const harness = makeHarness();
         seed(harness, DIAGRAM_URI, 'diagram', 1);
         seed(harness, SEMANTIC_URI, 'semantic', 1);
         seed(harness, OTHER_URI, 'other', 1);
         harness.validated.set(DIAGRAM_URI, makeRoot('fresh-primary'));
         harness.validated.set(SEMANTIC_URI, makeRoot('fresh-semantic'));
         // OTHER_URI deliberately has no validated root.
         harness.throwConflictOnPrimaryUpdate = true;
         let refetched: TestComposite | undefined;
         harness.resolve = async (_baseline, attempted, refetch) => {
            refetched = await refetch();
            return { status: 'merged', merged: attempted };
         };
         const state = createState(harness);
         state.setSourceRoot(DIAGRAM_URI, makeRoot('diagram'));
         state.trackSecondaryDocument(SEMANTIC_URI);
         state.trackSecondaryDocument(OTHER_URI);

         await state.updateSourceModel({ primary: { $type: 'TestRoot', label: 'x' }, secondaries: {} }, 1);

         expect(refetched?.primary).toEqual({ $type: 'TestRoot', label: 'fresh-primary' });
         expect(refetched?.secondaries).toEqual({ [SEMANTIC_URI]: { $type: 'TestRoot', label: 'fresh-semantic' } });
      });
   });

   describe('baseline', () => {
      it('captures the whole write set on setSourceRoot', () => {
         const harness = makeHarness();
         seed(harness, DIAGRAM_URI, 'diagram', 1);
         seed(harness, SEMANTIC_URI, 'semantic', 1);
         const state = createState(harness);
         state.setSourceRoot(DIAGRAM_URI, makeRoot('diagram'));
         state.trackSecondaryDocument(SEMANTIC_URI);
         // Re-capture now that the secondary is registered.
         state.setSourceRoot(DIAGRAM_URI, makeRoot('diagram'));

         expect(state.exposedBaseline).toEqual({
            primary: { $type: 'TestRoot', label: 'diagram' },
            secondaries: { [SEMANTIC_URI]: { $type: 'TestRoot', label: 'semantic' } }
         });
      });
   });
});
