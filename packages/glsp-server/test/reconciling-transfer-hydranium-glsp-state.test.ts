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
import { type AstNode, DocumentState, type LangiumDocument, URI } from '@hydranium/langium';
import { AstDocument, type ClientSession, DefaultModelLedger, type ServerSharedServices } from '@hydranium/core';
import { type BaseVersion, asModelVersion, ConflictError, type ConflictResolver, type ReconcileOutcome } from '@hydranium/protocol';
import { makeFakeAstNode, makeStubServiceRegistry } from '@hydranium/core/testing';
import { HydraniumGlspIndex } from '../src/state/hydranium-glsp-index.js';
import { ReconcilingTransferHydraniumGlspState } from '../src/state/reconciling-transfer-hydranium-glsp-state.js';
import { HydraniumTypes } from '../src/state/hydranium-shared-core-services.js';
import { HydraniumGlspOperationCommand, runOperation } from '../src/command/hydranium-glsp-operation-command.js';
import { HydraniumGlspRecordingCommand } from '../src/command/hydranium-glsp-recording-command.js';

interface TestRoot extends AstNode {
   readonly $type: 'TestRoot';
   readonly label: string;
}

interface TestSourceModel {
   $type: string;
   label: string;
   /** Set by {@link ProjectingState}. */
   projectedBy?: string;
}

/** The ledger every test's services share; a root is recorded once, so they never collide. */
const ledger = new DefaultModelLedger();

function makeRoot(label = 'r1'): TestRoot {
   return makeFakeAstNode<TestRoot>({ $type: 'TestRoot', label });
}

interface FakeDocument {
   uri: { toString(): string };
   state: DocumentState;
   parseResult: { value: AstNode };
   textDocument?: { version: number; getText?(): string };
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
   baseVersion: BaseVersion;
}

interface Harness {
   readonly warns: string[];
   readonly debugs: string[];
   readonly documents: Map<string, FakeDocument>;
   readonly updateCalls: UpdateCall[];
   throwConflictOnNextUpdate: boolean;
   /** Every update conflicts while set. */
   alwaysConflict: boolean;
   nextUpdatedRoot: TestRoot;
   validatedRoot: TestRoot;
   /** Text the store holds for every URI; the stub parser turns it into a root labelled with it. */
   storeText: string;
   resolve: (
      base: TestSourceModel,
      ours: TestSourceModel,
      refetch: () => Promise<TestSourceModel | undefined>
   ) => Promise<ReconcileOutcome<TestSourceModel>>;
}

@injectable()
class TestReconcilingState extends ReconcilingTransferHydraniumGlspState<TestRoot, TestSourceModel> {
   /** Expose the protected base for assertions. */
   get exposedBase(): TestSourceModel | undefined {
      return this.base;
   }
}

function makeHarness(): Harness {
   return {
      warns: [],
      debugs: [],
      documents: new Map(),
      updateCalls: [],
      throwConflictOnNextUpdate: false,
      alwaysConflict: false,
      nextUpdatedRoot: makeRoot('updated'),
      validatedRoot: makeRoot('validated'),
      storeText: 'stored',
      resolve: async (_base, ours) => ({ status: 'merged', merged: ours })
   };
}

/** Marks every projection it makes, so a test sees which ones bypassed it. */
@injectable()
class ProjectingState extends TestReconcilingState {
   protected override projectRoot(root: AstNode): TestSourceModel {
      return { ...super.projectRoot(root), projectedBy: 'override' };
   }
}

/** Fails to normalize every transition. */
@injectable()
class FailingNormalizationState extends TestReconcilingState {
   override async normalizeTransition(): Promise<never> {
      throw new Error('serializer unavailable');
   }
}

/** A diagram that gives up on the first conflicting write. */
class SingleWriteState extends TestReconcilingState {
   protected override readonly maxSourceModelWrites = 1;
}

function createState(harness: Harness, stateClass: new () => TestReconcilingState = TestReconcilingState): TestReconcilingState {
   const childLogger = {
      info: () => undefined,
      warn: (msg: string) => harness.warns.push(msg),
      error: () => undefined,
      debug: (msg: string) => harness.debugs.push(msg),
      async time<T>(_label: string, callback: () => Promise<T> | T): Promise<T> {
         return await callback();
      },
      for(): unknown {
         return childLogger;
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
         ModelLedger: ledger,
         DocumentUriPolicy: { canonicalUri: (uri: string) => uri },
         LangiumDocuments: {
            getDocument: (uri: { toString(): string }) => harness.documents.get(uri.toString())
         },
         TextDocuments: {
            get: (uri: string) => ({ version: harness.documents.get(uri)?.textDocument?.version ?? 0, getText: () => harness.storeText }),
            version: (uri: string) => harness.documents.get(uri)?.textDocument?.version ?? 0
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
            async update(args: UpdateCall): Promise<{ root: TestRoot }> {
               harness.updateCalls.push(args);
               if (harness.throwConflictOnNextUpdate || harness.alwaysConflict) {
                  harness.throwConflictOnNextUpdate = false;
                  throw new ConflictError(args.uri, asModelVersion(1), 2);
               }
               return { root: harness.nextUpdatedRoot };
            },
            async validated(): Promise<{ root: TestRoot }> {
               return { root: harness.validatedRoot };
            },
            // A serializer that normalizes: it trims the label it writes.
            async modelToText(_uri: string, model: TestSourceModel): Promise<string> {
               return model.label.trim();
            }
         }
      }
   };
   const conflictResolver: ConflictResolver = {
      resolve: (base, ours, refetch) =>
         harness.resolve(
            base as TestSourceModel,
            ours as TestSourceModel,
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
   container.bind(ModelState).to(stateClass).inSingletonScope();
   container.bind(TestReconcilingState).toService(ModelState);
   const state = container.get(TestReconcilingState);
   // The diagram's session is stubbed to record through the service double,
   // stamping its own id, so the recorded calls carry that id.
   state.modelSession = {
      clientId: 'test-client',
      update: (args: object) => sharedServices.model.ModelService.update({ ...args, clientId: 'test-client' } as UpdateCall)
   } as unknown as ClientSession<AstNode>;
   return state;
}

describe('ReconcilingTransferHydraniumGlspState', () => {
   describe('sourceModel', () => {
      it('returns the grammar-mode projection of the current source root', () => {
         const state = createState(makeHarness());
         state.setSourceRoot('file:///a.a', makeRoot('Alpha'));
         expect(state.sourceModel).toEqual({ $type: 'TestRoot', label: 'Alpha' });
      });
   });

   describe('base', () => {
      it('captures the source-model projection on setSourceRoot', () => {
         const state = createState(makeHarness());
         state.setSourceRoot('file:///a.a', makeRoot('Alpha'));
         expect(state.exposedBase).toEqual({ $type: 'TestRoot', label: 'Alpha' });
      });

      it('recaptures the base when setSourceRoot runs again', () => {
         const state = createState(makeHarness());
         state.setSourceRoot('file:///a.a', makeRoot('First'));
         state.setSourceRoot('file:///a.a', makeRoot('Second'));
         expect(state.exposedBase).toEqual({ $type: 'TestRoot', label: 'Second' });
      });
   });

   describe('updateSourceModel', () => {
      it('refuses to write without a session, rather than writing under an id it does not hold', async () => {
         // Without a session the state has nothing to write through; looking
         // the id up would write as whoever holds it.
         const harness = makeHarness();
         const state = createState(harness);
         state.setSourceRoot('file:///a.a', makeRoot('before'));
         state.modelSession = undefined;

         await expect(state.updateSourceModel({ $type: 'TestRoot', label: 'edited' }, asModelVersion(5))).rejects.toThrow(
            /No client session/
         );
         expect(harness.updateCalls).toEqual([]);
      });

      it('persists through the diagram session with uri/model/baseVersion and captures the returned root', async () => {
         const harness = makeHarness();
         harness.nextUpdatedRoot = makeRoot('persisted');
         const state = createState(harness);
         state.setSourceRoot('file:///a.a', makeRoot('before'));

         await state.updateSourceModel({ $type: 'TestRoot', label: 'edited' }, asModelVersion(5));

         expect(harness.updateCalls).toEqual([
            {
               uri: 'file:///a.a',
               model: { $type: 'TestRoot', label: 'edited' },
               clientId: 'test-client',
               baseVersion: asModelVersion(5)
            }
         ]);
         expect(state.sourceRoot).toBe(harness.nextUpdatedRoot);
      });

      it('defaults baseVersion to the state model version when the caller passes none', async () => {
         const harness = makeHarness();
         const parsed = makeRoot('before');
         ledger.record(parsed, 7);
         harness.documents.set('file:///a.a', {
            uri: { toString: () => 'file:///a.a' },
            state: DocumentState.Validated,
            parseResult: { value: parsed },
            textDocument: { version: 7 }
         });
         const state = createState(harness);
         state.setSourceRoot('file:///a.a', parsed);

         await state.updateSourceModel({ $type: 'TestRoot', label: 'edited' });

         // v7 and not `'any'`: the parameter is optional only because GLSP's
         // one-argument `JsonModelState.updateSourceModel` has to stay satisfiable,
         // so the default is what decides whether an ungated write is the easy one.
         expect(harness.updateCalls).toHaveLength(1);
         expect(harness.updateCalls[0].baseVersion).toBe(asModelVersion(7));
      });

      it('on a merged outcome that refetched nothing, re-persists the merged model based on any version', async () => {
         const harness = makeHarness();
         harness.throwConflictOnNextUpdate = true;
         harness.nextUpdatedRoot = makeRoot('merged-root');
         harness.resolve = async () => ({ status: 'merged', merged: { $type: 'TestRoot', label: 'merged' } });
         const state = createState(harness);
         state.setSourceRoot('file:///a.a', makeRoot('before'));

         await state.updateSourceModel({ $type: 'TestRoot', label: 'edited' }, asModelVersion(5));

         expect(harness.updateCalls).toHaveLength(2);
         expect(harness.updateCalls[0].baseVersion).toBe(5);
         expect(harness.updateCalls[1]).toEqual({
            uri: 'file:///a.a',
            model: { $type: 'TestRoot', label: 'merged' },
            clientId: 'test-client',
            baseVersion: 'any'
         });
         expect(state.sourceRoot).toBe(harness.nextUpdatedRoot);
      });

      it('gates the merged write on the version the refetch read with its text', async () => {
         const harness = makeHarness();
         harness.throwConflictOnNextUpdate = true;
         harness.documents.set('file:///a.a', {
            uri: { toString: () => 'file:///a.a' },
            state: DocumentState.Validated,
            parseResult: { value: makeRoot('built') },
            textDocument: { version: 9 }
         });
         harness.resolve = async (_base, ours, refetch) => {
            await refetch();
            return { status: 'merged', merged: ours };
         };
         const state = createState(harness);
         state.setSourceRoot('file:///a.a', makeRoot('before'));

         await state.updateSourceModel({ $type: 'TestRoot', label: 'edited' }, asModelVersion(5));

         expect(harness.updateCalls.map(call => call.baseVersion)).toEqual([5, 9]);
      });

      it('drops the edit with a warning once the merged writes keep conflicting', async () => {
         const harness = makeHarness();
         harness.alwaysConflict = true;
         harness.resolve = async (_base, ours, refetch) => {
            await refetch();
            return { status: 'merged', merged: ours };
         };
         const refreshed = makeRoot('refreshed');
         harness.documents.set('file:///a.a', {
            uri: { toString: () => 'file:///a.a' },
            state: DocumentState.Validated,
            parseResult: { value: refreshed },
            textDocument: { version: 2, getText: () => 'stored' }
         });
         const state = createState(harness);
         state.setSourceRoot('file:///a.a', makeRoot('before'));

         await state.updateSourceModel({ $type: 'TestRoot', label: 'edited' }, asModelVersion(1));

         expect(harness.updateCalls).toHaveLength(3);
         expect(state.sourceRoot).toBe(refreshed);
         expect(harness.warns.filter(msg => msg.includes('still conflicting'))).toEqual([
            'updateSourceModel still conflicting after 3 writes (model v1 / text v2); dropping the diagram edit'
         ]);
      });

      it('drops the edit after as many writes as the subclass allows', async () => {
         const harness = makeHarness();
         harness.alwaysConflict = true;
         harness.resolve = async (_base, ours, refetch) => {
            await refetch();
            return { status: 'merged', merged: ours };
         };
         const state = createState(harness, SingleWriteState);
         state.setSourceRoot('file:///a.a', makeRoot('before'));

         await state.updateSourceModel({ $type: 'TestRoot', label: 'edited' }, asModelVersion(1));

         expect(harness.updateCalls).toHaveLength(1);
         expect(harness.warns.filter(msg => msg.includes('still conflicting after 1 write '))).toHaveLength(1);
      });

      it('on a no-op outcome, does not persist again and leaves the source root', async () => {
         const harness = makeHarness();
         harness.throwConflictOnNextUpdate = true;
         harness.resolve = async () => ({ status: 'no-op' });
         const state = createState(harness);
         const before = makeRoot('before');
         state.setSourceRoot('file:///a.a', before);

         await state.updateSourceModel({ $type: 'TestRoot', label: 'edited' }, asModelVersion(5));

         expect(harness.updateCalls).toHaveLength(1);
         expect(state.sourceRoot).toBe(before);
         expect(harness.debugs.some(msg => msg.includes('no-op'))).toBe(true);
      });

      it('on a conflict outcome, refreshes the source root from the document and warns', async () => {
         const harness = makeHarness();
         harness.throwConflictOnNextUpdate = true;
         harness.resolve = async () => ({ status: 'conflict', theirs: { $type: 'TestRoot', label: 'server' } });
         const refreshed = makeRoot('refreshed');
         harness.documents.set('file:///a.a', {
            uri: { toString: () => 'file:///a.a' },
            state: DocumentState.Validated,
            parseResult: { value: refreshed },
            textDocument: { version: 0, getText: () => 'stored' }
         });
         const state = createState(harness);
         state.setSourceRoot('file:///a.a', makeRoot('before'));

         await state.updateSourceModel({ $type: 'TestRoot', label: 'edited' }, asModelVersion(5));

         expect(harness.updateCalls).toHaveLength(1);
         expect(state.sourceRoot).toBe(refreshed);
         expect(harness.warns.some(msg => msg.includes('conflict'))).toBe(true);
      });

      it('on an unavailable outcome, writes nothing more, throws the conflict and warns', async () => {
         const harness = makeHarness();
         harness.throwConflictOnNextUpdate = true;
         harness.resolve = async () => ({ status: 'unavailable' });
         const state = createState(harness);
         const before = makeRoot('before');
         state.setSourceRoot('file:///a.a', before);

         await expect(state.updateSourceModel({ $type: 'TestRoot', label: 'edited' }, asModelVersion(5))).rejects.toBeInstanceOf(
            ConflictError
         );

         expect(harness.updateCalls).toHaveLength(1);
         expect(state.sourceRoot).toBe(before);
         expect(harness.warns.some(msg => msg.includes('unavailable'))).toBe(true);
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

      it('resolves the conflict against the captured base and a refetch parsed from the stored text', async () => {
         // Not the built root: operation handlers edit that one in place.
         const harness = makeHarness();
         harness.throwConflictOnNextUpdate = true;
         harness.validatedRoot = makeRoot('built');
         harness.storeText = 'server-current';
         let seenBase: TestSourceModel | undefined;
         let seenRefetch: TestSourceModel | undefined;
         harness.resolve = async (base, _ours, refetch) => {
            seenBase = base;
            seenRefetch = await refetch();
            return { status: 'no-op' };
         };
         const state = createState(harness);
         state.setSourceRoot('file:///a.a', makeRoot('base-label'));

         await state.updateSourceModel({ $type: 'TestRoot', label: 'edited' }, asModelVersion(5));

         expect(seenBase).toEqual({ $type: 'TestRoot', label: 'base-label' });
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

describe('ReconcilingTransferHydraniumGlspState under an operation', () => {
   it('writes the projection of the copy once when the operation ends, and leaves the built root unedited', async () => {
      const harness = makeHarness();
      const built = makeRoot('built');
      const state = createState(harness);
      state.setSourceRoot('file:///a.a', built);
      let during: { copy: boolean; writes: number } | undefined;
      const command = new HydraniumGlspRecordingCommand<TestSourceModel>(state, 'Edit', () => {
         (state.sourceRoot as { label: string }).label = 'first';
         (state.sourceRoot as { label: string }).label = 'second';
         during = { copy: state.sourceRoot !== built, writes: harness.updateCalls.length };
      });

      const executed = await runOperation(new HydraniumGlspOperationCommand<TestSourceModel>(state), () => command);

      expect({ executed, during, writes: harness.updateCalls.map(call => call.model.label), builtLabel: built.label }).toEqual({
         executed: 'executed',
         during: { copy: true, writes: 0 },
         writes: ['second'],
         builtLabel: 'built'
      });
   });

   it('writes nothing and captures the built root again when a command throws', async () => {
      const harness = makeHarness();
      const built = makeRoot('built');
      const state = createState(harness);
      state.setSourceRoot('file:///a.a', built);
      const command = new HydraniumGlspRecordingCommand<TestSourceModel>(state, 'Fail', () => {
         (state.sourceRoot as { label: string }).label = 'edited';
         throw new Error('command failed');
      });

      const run = runOperation(new HydraniumGlspOperationCommand<TestSourceModel>(state), () => command);

      await expect(run).rejects.toThrow('command failed');
      expect({ writes: harness.updateCalls.length, sourceRoot: state.sourceRoot === built, label: built.label }).toEqual({
         writes: 0,
         sourceRoot: true,
         label: 'built'
      });
   });

   it('records the transition as the serializer writes it, projected through a projectRoot override', async () => {
      const harness = makeHarness();
      // The write leaves the label as the trimming serializer writes it.
      harness.nextUpdatedRoot = makeRoot('edited');
      const resolved: Array<{ base: TestSourceModel; ours: TestSourceModel }> = [];
      harness.resolve = async (base, ours) => {
         resolved.push({ base, ours });
         return { status: 'merged', merged: ours };
      };
      const state = createState(harness, ProjectingState);
      state.setSourceRoot('file:///a.a', makeRoot(' built '));
      const operation = new HydraniumGlspOperationCommand<TestSourceModel>(state);
      await runOperation(
         operation,
         () =>
            new HydraniumGlspRecordingCommand<TestSourceModel>(state, 'Edit', () => {
               (state.sourceRoot as { label: string }).label = ' edited ';
            })
      );

      await state.runExclusive(() => operation.undo());

      expect(resolved).toEqual([
         {
            base: { $type: 'TestRoot', label: 'edited', projectedBy: 'override' },
            ours: { $type: 'TestRoot', label: 'built', projectedBy: 'override' }
         }
      ]);
   });

   it('keeps the operation and its transition as recorded, with a warning, when normalizing fails after the write', async () => {
      const harness = makeHarness();
      const resolved: Array<{ base: string; ours: string }> = [];
      harness.resolve = async (base, ours) => {
         resolved.push({ base: base.label, ours: ours.label });
         return { status: 'merged', merged: ours };
      };
      const state = createState(harness, FailingNormalizationState);
      state.setSourceRoot('file:///a.a', makeRoot(' built '));
      const operation = new HydraniumGlspOperationCommand<TestSourceModel>(state);

      const outcome = await runOperation(
         operation,
         () =>
            new HydraniumGlspRecordingCommand<TestSourceModel>(state, 'Edit', () => {
               (state.sourceRoot as { label: string }).label = ' edited ';
            })
      );
      await state.runExclusive(() => operation.undo());

      expect({
         outcome,
         writes: harness.updateCalls.length,
         warned: harness.warns.filter(message => message.includes("Normalizing an operation's transition failed")).length,
         resolved
      }).toEqual({ outcome: 'executed', writes: 2, warned: 1, resolved: [{ base: ' edited ', ours: ' built ' }] });
   });

   it('refuses setSourceRoot while an operation is open', async () => {
      const state = createState(makeHarness());
      state.setSourceRoot('file:///a.a', makeRoot('built'));

      const run = runOperation(new HydraniumGlspOperationCommand<TestSourceModel>(state), () => {
         state.setSourceRoot('file:///a.a', makeRoot('other'));
         return undefined;
      });

      await expect(run).rejects.toThrow('setSourceRoot');
   });

   it('gives two spellings of one document one working copy', async () => {
      const state = createState(makeHarness());
      const services = (state as unknown as { sharedServices: { workspace: { DocumentUriPolicy: unknown } } }).sharedServices;
      services.workspace.DocumentUriPolicy = { canonicalUri: (uri: string) => uri.toLowerCase() };
      state.setSourceRoot('file:///a.a', makeRoot('built'));
      let same: boolean | undefined;

      await runOperation(new HydraniumGlspOperationCommand<TestSourceModel>(state), () => {
         same = state.workingRootOf('file:///A.A') === state.sourceRoot;
         return undefined;
      });

      expect(same).toBe(true);
   });

   it('asks the reference builder about the built nodes and points the reference at the copy', async () => {
      const state = createState(makeHarness());
      const asked: AstNode[][] = [];
      const builder = {
         getReferenceName: (target: AstNode, source: AstNode) => {
            asked.push([target, source]);
            return 'qualified';
         },
         toOwnReference: (target: AstNode & { name?: string }) => (target.name ? { ref: target, $refText: target.name } : undefined)
      };
      const services = (state as unknown as { sharedServices: { ServiceRegistry: unknown } }).sharedServices;
      services.ServiceRegistry = { getServicesFor: () => ({ references: { ReferenceBuilder: builder } }) };
      const item = makeFakeAstNode<AstNode>({ $type: 'Item', name: 'a' });
      const built = makeFakeAstNode<TestRoot>({ $type: 'TestRoot', label: 'r', members: [item] });
      state.setSourceRoot('file:///a.a', built);
      let observed: { visible: unknown[]; own: string | undefined } | undefined;

      await runOperation(new HydraniumGlspOperationCommand<TestSourceModel>(state), () => {
         const copy = state.sourceRoot as unknown as { members: Array<AstNode & { name: string }> };
         copy.members[0].name = 'renamed';
         const visible = state.referenceTo(copy.members[0], state.sourceRoot);
         const own = state.referenceTo(copy.members[0], undefined, { tier: 'own' });
         observed = { visible: [visible?.$refText, visible?.ref === copy.members[0]], own: own?.$refText };
         return undefined;
      });

      expect({ observed, asked: asked.map(([target, source]) => [target === item, source === built]) }).toEqual({
         observed: { visible: ['qualified', true], own: 'renamed' },
         asked: [[true, true]]
      });
   });

   it('asks about the nearest built container of a source the operation created', async () => {
      const state = createState(makeHarness());
      const asked: AstNode[] = [];
      const builder = {
         getReferenceName: (_target: AstNode, source: AstNode) => {
            asked.push(source);
            return 'qualified';
         }
      };
      const services = (state as unknown as { sharedServices: { ServiceRegistry: unknown } }).sharedServices;
      services.ServiceRegistry = { getServicesFor: () => ({ references: { ReferenceBuilder: builder } }) };
      const item = makeFakeAstNode<AstNode>({ $type: 'Item', name: 'a' });
      const built = makeFakeAstNode<TestRoot>({ $type: 'TestRoot', label: 'r', members: [item] });
      state.setSourceRoot('file:///a.a', built);

      await runOperation(new HydraniumGlspOperationCommand<TestSourceModel>(state), () => {
         const copy = state.sourceRoot as unknown as AstNode & { members: AstNode[] };
         const fresh = makeFakeAstNode<AstNode>({ $type: 'Item', name: 'new', $container: copy });
         copy.members.push(fresh);
         state.referenceTo(copy.members[0], fresh);
         return undefined;
      });

      expect(asked.map(source => source === built)).toEqual([true]);
   });

   it('queries candidates from the built node of a copy, and from a created node under the built nodes it sits in', async () => {
      const state = createState(makeHarness());
      const built = makeFakeAstNode<TestRoot>({
         $type: 'TestRoot',
         label: 'r',
         $document: { uri: URI.parse('file:///a.a') } as unknown as LangiumDocument,
         members: []
      });
      const item = makeFakeAstNode<AstNode>({
         $type: 'Item',
         name: 'a',
         $container: built,
         $containerProperty: 'members',
         $containerIndex: 0,
         children: []
      });
      (built as unknown as { members: AstNode[] }).members.push(item);
      state.setSourceRoot('file:///a.a', built);
      (state as unknown as { sharedServices: { AstReflection: unknown } }).sharedServices.AstReflection = {
         getTypeMetaData: () => undefined
      };
      type Copy = AstNode & { members: Copy[]; children: Copy[] };
      // Each container up to the root, so a chain that skips one shows.
      const chainOf = (node: AstNode | undefined): unknown[] => {
         const chain: unknown[] = [];
         for (let current = node; current; current = current.$container) {
            chain.push(
               current === built ? 'built root' : current === item ? 'built item' : `${current.$type}:${current.$containerProperty}`
            );
         }
         return chain;
      };
      let observed: unknown;

      await runOperation(new HydraniumGlspOperationCommand<TestSourceModel>(state), () => {
         const copy = state.sourceRoot as unknown as Copy;
         const copyItem = copy.members[0];
         const created = makeFakeAstNode<Copy>({ $type: 'Item', $container: copy, $containerProperty: 'members', children: [] });
         copy.members.push(created);
         const nested = makeFakeAstNode<Copy>({ $type: 'Item', $container: copyItem, $containerProperty: 'children', children: [] });
         copyItem.children.push(nested);
         const deep = makeFakeAstNode<Copy>({ $type: 'Leaf', $container: nested, $containerProperty: 'children' });
         nested.children.push(deep);
         // Built by the handler and not yet attached anywhere.
         const loose = makeFakeAstNode<AstNode>({ $type: 'Item' });
         const infoOf = (node: AstNode): unknown => {
            const info = state.referenceInfoOf(node, 'target');
            return info && { property: info.property, chain: chainOf(info.container) };
         };
         observed = { copy: infoOf(copyItem), created: infoOf(created), nested: infoOf(nested), deep: infoOf(deep), loose: infoOf(loose) };
         return undefined;
      });

      expect(observed).toEqual({
         copy: { property: 'target', chain: ['built item', 'built root'] },
         created: { property: 'target', chain: ['Item:members', 'built root'] },
         nested: { property: 'target', chain: ['Item:children', 'built item', 'built root'] },
         deep: { property: 'target', chain: ['Leaf:children', 'Item:children', 'built item', 'built root'] },
         loose: undefined
      });
   });

   it('runs the next exclusive call after one that threw', async () => {
      const state = createState(makeHarness());
      const failed = state.runExclusive(() => {
         throw new Error('run failed');
      });
      const next = state.runExclusive(() => 'ran');

      await expect(failed).rejects.toThrow('run failed');
      await expect(next).resolves.toBe('ran');
   });

   it('gives a copied multi-reference targets in the copy, not shared with the built root', async () => {
      const state = createState(makeHarness());
      const item = makeFakeAstNode<AstNode>({ $type: 'Item', name: 'a' });
      const link = { $refText: 'a', items: [{ ref: item }] };
      const built = makeFakeAstNode<TestRoot>({ $type: 'TestRoot', label: 'r', members: [item], link, links: [link] });
      state.setSourceRoot('file:///a.a', built);
      let observed: { shared: boolean; target: boolean; arrayTarget: boolean } | undefined;

      await runOperation(new HydraniumGlspOperationCommand<TestSourceModel>(state), () => {
         const copy = state.sourceRoot as unknown as {
            members: AstNode[];
            link: { items: Array<{ ref: AstNode }> };
            links: Array<{ items: Array<{ ref: AstNode }> }>;
         };
         observed = {
            shared: copy.link === link || copy.links[0] === link,
            target: copy.link.items[0].ref === copy.members[0],
            arrayTarget: copy.links[0].items[0].ref === copy.members[0]
         };
         return undefined;
      });

      expect(observed).toEqual({ shared: false, target: true, arrayTarget: true });
   });
});

/** A node of `$type` contained in `root`'s `members`, so it routes by `root`'s document. */
function memberOf(root: AstNode, $type: string): AstNode {
   const members = (root as unknown as { members: AstNode[] }).members;
   const member = makeFakeAstNode<AstNode>({ $type, $container: root, $containerProperty: 'members', $containerIndex: members.length });
   members.push(member);
   return member;
}

describe('the copy nodes of an operation', () => {
   it('take their language from the index, so an override of its routing reaches the state too', () => {
      const state = createState(makeHarness());
      const routed = { LanguageMetaData: { languageId: 'routed' } } as unknown as ReturnType<typeof state.languageServicesFor>;
      const index = state.index as unknown as { languageServicesFor(node?: AstNode): unknown };
      index.languageServicesFor = () => routed;

      expect(state.languageServicesFor(makeFakeAstNode<AstNode>({ $type: 'Item' }))).toBe(routed);
   });

   it('answer every node-routed seam as the built node they were copied from, on the primary and a foreign-language secondary', async () => {
      const harness = makeHarness();
      const state = createState(harness);
      const keyProviderFor = (prefix: string): { getElementKey(node?: AstNode): string | undefined } => ({
         getElementKey: node => (node ? `${prefix}:${node.$type}` : undefined)
      });
      const services = (state as unknown as { sharedServices: { ServiceRegistry: unknown } }).sharedServices;
      services.ServiceRegistry = makeStubServiceRegistry([
         { languageId: 'test', fileExtensions: ['.a'], services: { references: { ElementKeyProvider: keyProviderFor('dgm') } } },
         { languageId: 'other', fileExtensions: ['.other'], services: { references: { ElementKeyProvider: keyProviderFor('other') } } }
      ]);
      const foreignUri = 'file:///b.other';
      const foreignRoot = makeFakeAstNode<AstNode>({
         $type: 'ForeignRoot',
         $document: { uri: URI.parse(foreignUri) } as unknown as LangiumDocument,
         members: []
      });
      const foreignItem = memberOf(foreignRoot, 'ForeignItem');
      harness.documents.set(foreignUri, {
         uri: { toString: () => foreignUri },
         state: DocumentState.Validated,
         parseResult: { value: foreignRoot }
      });
      const primaryRoot = makeFakeAstNode<TestRoot>({
         $type: 'TestRoot',
         label: 'r',
         $document: { uri: URI.parse('file:///a.a') } as unknown as LangiumDocument,
         members: []
      });
      const primaryItem = memberOf(primaryRoot, 'PrimaryItem');
      state.setSourceRoot('file:///a.a', primaryRoot);
      state.index.indexSemanticElement(state.index.findId(foreignItem)!, foreignItem);
      const seams = (node: AstNode): unknown => ({
         findId: state.index.findId(node),
         createId: state.index.createId(node),
         resolves: state.index.findSemanticElement(state.index.findId(node) ?? '') !== undefined,
         language: state.languageServicesFor(node)?.LanguageMetaData.languageId,
         indexLanguage: state.index.languageServicesFor(node)?.LanguageMetaData.languageId
      });
      const built = { primary: seams(primaryItem), foreign: seams(foreignItem) };
      let copied: unknown;

      await runOperation(new HydraniumGlspOperationCommand<TestSourceModel>(state), () => {
         const primaryCopy = (state.sourceRoot as unknown as { members: AstNode[] }).members[0];
         const foreignCopy = (state.workingRootOf(foreignUri) as unknown as { members: AstNode[] }).members[0];
         copied = {
            copies: primaryCopy !== primaryItem && foreignCopy !== foreignItem,
            primary: seams(primaryCopy),
            foreign: seams(foreignCopy),
            resolvesToCopy: state.index.findSemanticElement(state.index.findId(foreignCopy) ?? '') === foreignCopy
         };
         return undefined;
      });

      expect(copied).toEqual({ copies: true, primary: built.primary, foreign: built.foreign, resolvesToCopy: true });
   });
});
