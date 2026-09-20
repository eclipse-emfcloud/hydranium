/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, expect, it } from 'vitest';
import { ClientId, GModelIndex, GModelSerializer, ModelState, SOURCE_URI_ARG } from '@eclipse-glsp/server';
import 'reflect-metadata';
import { Container, injectable } from 'inversify';
import { type AstNode, DocumentState } from '@hydranium/langium';
import { AstDocument, type ServerSharedServices } from '@hydranium/core';
import { type BasedOn, asSnapshotVersion, ConflictError, type ConflictResolver, type ReconcileOutcome } from '@hydranium/protocol';
import { makeFakeAstNode, makeStubServiceRegistry } from '@hydranium/core/testing';
import { HydraniumGlspIndex } from '../src/state/hydranium-glsp-index.js';
import { ReconcilingTransferHydraniumGlspState } from '../src/state/reconciling-transfer-hydranium-glsp-state.js';
import { HydraniumTypes } from '../src/state/hydranium-shared-core-services.js';

interface TestRoot extends AstNode {
   readonly $type: 'TestRoot';
   readonly label: string;
}

interface TestSourceModel {
   $type: string;
   label: string;
}

function makeRoot(label = 'r1'): TestRoot {
   return makeFakeAstNode<TestRoot>({ $type: 'TestRoot', label });
}

interface FakeDocument {
   uri: { toString(): string };
   state: DocumentState;
   parseResult: { value: AstNode };
   textDocument?: { version: number };
}

/**
 * Project a fake document into the envelope `ModelService.snapshot` returns.
 * Only `version` is read by the state, but the shape stays faithful so a stub
 * cannot pass a test the real service would fail.
 */
function toSnapshot(uri: string, document: FakeDocument | undefined): AstDocument<AstNode, never> | undefined {
   return document && AstDocument.create(uri, document.textDocument?.version ?? 0, document.parseResult.value);
}

interface UpdateCall {
   uri: string;
   model: TestSourceModel;
   clientId: string;
   basedOn: BasedOn;
}

interface Harness {
   readonly warns: string[];
   readonly debugs: string[];
   readonly documents: Map<string, FakeDocument>;
   readonly updateCalls: UpdateCall[];
   throwConflictOnNextUpdate: boolean;
   nextUpdatedRoot: TestRoot;
   validatedRoot: TestRoot;
   resolve: (
      baseline: TestSourceModel,
      attempted: TestSourceModel,
      refetch: () => Promise<TestSourceModel | undefined>
   ) => Promise<ReconcileOutcome<TestSourceModel>>;
}

@injectable()
class TestReconcilingState extends ReconcilingTransferHydraniumGlspState<TestRoot, TestSourceModel> {
   /** Expose the protected baseline for assertions. */
   get exposedBaseline(): TestSourceModel | undefined {
      return this.baseline;
   }
}

function makeHarness(): Harness {
   return {
      warns: [],
      debugs: [],
      documents: new Map(),
      updateCalls: [],
      throwConflictOnNextUpdate: false,
      nextUpdatedRoot: makeRoot('updated'),
      validatedRoot: makeRoot('validated'),
      resolve: async (_baseline, attempted) => ({ status: 'merged', merged: attempted })
   };
}

function createState(harness: Harness): TestReconcilingState {
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
      // `ServiceRegistry` is a required slot on a real shared tree, and the
      // state resolves per-target languages through it.
      ServiceRegistry: makeStubServiceRegistry([{ languageId: 'test', fileExtensions: ['.a'] }]),
      Tracer: {
         for: () => ({ withUri: () => childLogger })
      },
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
            snapshot: (uri: string) => toSnapshot(uri, harness.documents.get(uri)),
            waitForDocumentState: () => Promise.resolve(),
            getDocument: (uri: string) => harness.documents.get(uri),
            async update(args: UpdateCall): Promise<{ root: TestRoot }> {
               harness.updateCalls.push(args);
               if (harness.throwConflictOnNextUpdate) {
                  harness.throwConflictOnNextUpdate = false;
                  throw new ConflictError(args.uri, 1, 2);
               }
               return { root: harness.nextUpdatedRoot };
            },
            async validated(): Promise<{ root: TestRoot }> {
               return { root: harness.validatedRoot };
            }
         }
      }
   };
   const conflictResolver: ConflictResolver = {
      resolve: (baseline, attempted, refetch) =>
         harness.resolve(
            baseline as TestSourceModel,
            attempted as TestSourceModel,
            refetch as () => Promise<TestSourceModel | undefined>
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
   container.bind(ModelState).to(TestReconcilingState).inSingletonScope();
   container.bind(TestReconcilingState).toService(ModelState);
   return container.get(TestReconcilingState);
}

describe('ReconcilingTransferHydraniumGlspState', () => {
   describe('sourceModel', () => {
      it('returns the grammar-mode projection of the current source root', () => {
         const state = createState(makeHarness());
         state.setSourceRoot('file:///a.a', makeRoot('Alpha'));
         expect(state.sourceModel).toEqual({ $type: 'TestRoot', label: 'Alpha' });
      });
   });

   describe('baseline', () => {
      it('captures the source-model projection on setSourceRoot', () => {
         const state = createState(makeHarness());
         state.setSourceRoot('file:///a.a', makeRoot('Alpha'));
         expect(state.exposedBaseline).toEqual({ $type: 'TestRoot', label: 'Alpha' });
      });

      it('recaptures the baseline when setSourceRoot runs again', () => {
         const state = createState(makeHarness());
         state.setSourceRoot('file:///a.a', makeRoot('First'));
         state.setSourceRoot('file:///a.a', makeRoot('Second'));
         expect(state.exposedBaseline).toEqual({ $type: 'TestRoot', label: 'Second' });
      });
   });

   describe('updateSourceModel', () => {
      it('persists via ModelService.update with uri/model/clientId/basedOn and captures the returned root', async () => {
         const harness = makeHarness();
         harness.nextUpdatedRoot = makeRoot('persisted');
         const state = createState(harness);
         state.setSourceRoot('file:///a.a', makeRoot('before'));

         await state.updateSourceModel({ $type: 'TestRoot', label: 'edited' }, asSnapshotVersion(5));

         expect(harness.updateCalls).toEqual([
            { uri: 'file:///a.a', model: { $type: 'TestRoot', label: 'edited' }, clientId: 'test-client', basedOn: asSnapshotVersion(5) }
         ]);
         expect(state.sourceRoot).toBe(harness.nextUpdatedRoot);
      });

      it('defaults basedOn to the state snapshot version when the caller passes none', async () => {
         const harness = makeHarness();
         harness.documents.set('file:///a.a', {
            uri: { toString: () => 'file:///a.a' },
            state: DocumentState.Validated,
            parseResult: { value: makeRoot('before') },
            textDocument: { version: 7 }
         });
         const state = createState(harness);
         state.setSourceRoot('file:///a.a', makeRoot('before'));

         await state.updateSourceModel({ $type: 'TestRoot', label: 'edited' });

         // v7 and not `'anything'`: the parameter is optional only because GLSP's
         // one-argument `JsonModelState.updateSourceModel` has to stay satisfiable,
         // so the default is what decides whether an ungated write is the easy one.
         expect(harness.updateCalls).toHaveLength(1);
         expect(harness.updateCalls[0].basedOn).toBe(asSnapshotVersion(7));
      });

      it('on a ConflictError with a merged outcome, re-persists the merged model based on anything', async () => {
         const harness = makeHarness();
         harness.throwConflictOnNextUpdate = true;
         harness.nextUpdatedRoot = makeRoot('merged-root');
         harness.resolve = async () => ({ status: 'merged', merged: { $type: 'TestRoot', label: 'merged' } });
         const state = createState(harness);
         state.setSourceRoot('file:///a.a', makeRoot('before'));

         await state.updateSourceModel({ $type: 'TestRoot', label: 'edited' }, asSnapshotVersion(5));

         expect(harness.updateCalls).toHaveLength(2);
         expect(harness.updateCalls[0].basedOn).toBe(5);
         expect(harness.updateCalls[1]).toEqual({
            uri: 'file:///a.a',
            model: { $type: 'TestRoot', label: 'merged' },
            clientId: 'test-client',
            basedOn: 'anything'
         });
         expect(state.sourceRoot).toBe(harness.nextUpdatedRoot);
      });

      it('on a no-op outcome, does not persist again and leaves the source root', async () => {
         const harness = makeHarness();
         harness.throwConflictOnNextUpdate = true;
         harness.resolve = async () => ({ status: 'no-op' });
         const state = createState(harness);
         const before = makeRoot('before');
         state.setSourceRoot('file:///a.a', before);

         await state.updateSourceModel({ $type: 'TestRoot', label: 'edited' }, asSnapshotVersion(5));

         expect(harness.updateCalls).toHaveLength(1);
         expect(state.sourceRoot).toBe(before);
         expect(harness.debugs.some(msg => msg.includes('no-op'))).toBe(true);
      });

      it('on a conflict outcome, refreshes the source root from the document and warns', async () => {
         const harness = makeHarness();
         harness.throwConflictOnNextUpdate = true;
         harness.resolve = async () => ({ status: 'conflict', fresh: { $type: 'TestRoot', label: 'server' } });
         const refreshed = makeRoot('refreshed');
         harness.documents.set('file:///a.a', {
            uri: { toString: () => 'file:///a.a' },
            state: DocumentState.Validated,
            parseResult: { value: refreshed }
         });
         const state = createState(harness);
         state.setSourceRoot('file:///a.a', makeRoot('before'));

         await state.updateSourceModel({ $type: 'TestRoot', label: 'edited' }, asSnapshotVersion(5));

         expect(harness.updateCalls).toHaveLength(1);
         expect(state.sourceRoot).toBe(refreshed);
         expect(harness.warns.some(msg => msg.includes('conflict'))).toBe(true);
      });

      it('on an unavailable outcome, force-persists based on anything and warns', async () => {
         const harness = makeHarness();
         harness.throwConflictOnNextUpdate = true;
         harness.nextUpdatedRoot = makeRoot('forced');
         harness.resolve = async () => ({ status: 'unavailable' });
         const state = createState(harness);
         state.setSourceRoot('file:///a.a', makeRoot('before'));

         await state.updateSourceModel({ $type: 'TestRoot', label: 'edited' }, asSnapshotVersion(5));

         expect(harness.updateCalls).toHaveLength(2);
         expect(harness.updateCalls[1].basedOn).toBe('anything');
         expect(state.sourceRoot).toBe(harness.nextUpdatedRoot);
         expect(harness.warns.some(msg => msg.includes('unavailable') || msg.includes('forcing'))).toBe(true);
      });

      it('re-throws a non-conflict error from persist', async () => {
         const harness = makeHarness();
         const state = createState(harness);
         state.setSourceRoot('file:///a.a', makeRoot('before'));
         harness.resolve = async () => {
            throw new Error('resolver should not be consulted');
         };
         // Make update throw a plain (non-conflict) error.
         const services = (state as unknown as { sharedServices: { model: { ModelService: { update: () => Promise<never> } } } })
            .sharedServices;
         services.model.ModelService.update = () => Promise.reject(new Error('boom'));

         await expect(state.updateSourceModel({ $type: 'TestRoot', label: 'edited' })).rejects.toThrow('boom');
      });

      it('resolves the conflict against the captured baseline and a grammar-projection refetch', async () => {
         const harness = makeHarness();
         harness.throwConflictOnNextUpdate = true;
         harness.validatedRoot = makeRoot('server-current');
         let seenBaseline: TestSourceModel | undefined;
         let seenRefetch: TestSourceModel | undefined;
         harness.resolve = async (baseline, _attempted, refetch) => {
            seenBaseline = baseline;
            seenRefetch = await refetch();
            return { status: 'no-op' };
         };
         const state = createState(harness);
         state.setSourceRoot('file:///a.a', makeRoot('baseline-label'));

         await state.updateSourceModel({ $type: 'TestRoot', label: 'edited' }, asSnapshotVersion(5));

         expect(seenBaseline).toEqual({ $type: 'TestRoot', label: 'baseline-label' });
         expect(seenRefetch).toEqual({ $type: 'TestRoot', label: 'server-current' });
      });
   });

   describe('JsonModelState compatibility', () => {
      it('mirrors the source uri into the inherited properties map', () => {
         const state = createState(makeHarness());
         state.setSourceRoot('file:///a.a', makeRoot());
         expect(state.get<string>(SOURCE_URI_ARG)).toBe('file:///a.a');
      });
   });
});
