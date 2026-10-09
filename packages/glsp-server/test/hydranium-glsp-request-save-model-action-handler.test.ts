/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { afterEach, describe, expect, it } from 'vitest';
import 'reflect-metadata';
import {
   type ActionHandlerConstructor,
   type BindingTarget,
   type DiagramConfiguration,
   DiagramModule,
   GGraph,
   type GModelFactory,
   type InstanceMultiBinding,
   MessageAction,
   ModelState,
   type ModelSubmissionHandler,
   RejectAction,
   SaveModelAction,
   ServerLayoutKind,
   ServerModule,
   SetDirtyStateAction,
   type SourceModelStorage,
   getDefaultMapping
} from '@eclipse-glsp/server';
import { ContainerModule, inject, injectable } from 'inversify';
import { type AstNode } from '@hydranium/langium';
import type { ServerSharedServices } from '@hydranium/core';
import { ModelSavedAction, ReconcilingConflictResolver, RequestSaveModelAction } from '@hydranium/protocol';
import { waitFor } from '@hydranium/protocol/testing';
import { AbstractHydraniumGlspState } from '../src/state/abstract-hydranium-glsp-state.js';
import { HydraniumTypes } from '../src/state/hydranium-shared-core-services.js';
import { HydraniumGlspRequestSaveModelActionHandler } from '../src/storage/hydranium-glsp-request-save-model-action-handler.js';
import { HydraniumGlspSubmissionHandler } from '../src/submission/hydranium-glsp-submission-handler.js';
import { type GlspHarness, makeGlspHarness } from '../src/testing/glsp-harness.js';

// Grammar-free: the handler's contract is the round trip through the server,
// so the storage records what it was asked to save instead of writing.

const TEST_DIAGRAM_TYPE = 'test-diagram';

interface TestRoot extends AstNode {
   readonly $type: 'TestRoot';
}

/** The save actions the storage was handed, in order. */
let savedActions: SaveModelAction[] = [];
/** Thrown by the next save when set. */
let saveFailure: Error | undefined;

@injectable()
class TestState extends AbstractHydraniumGlspState<TestRoot> {
   async updateSourceModel(): Promise<void> {
      /* no-op: nothing edits this fixture */
   }
}

@injectable()
class RecordingStorage implements SourceModelStorage {
   loadSourceModel(): void {
      /* no-op: the save needs no model */
   }
   async saveSourceModel(action: SaveModelAction): Promise<void> {
      const failure = saveFailure;
      saveFailure = undefined;
      if (failure) {
         throw failure;
      }
      savedActions.push(action);
   }
}

@injectable()
class TestGModelFactory implements GModelFactory {
   @inject(ModelState) protected readonly modelState!: TestState;

   createModel(): void {
      this.modelState.updateRoot(GGraph.builder().id('test').build());
   }
}

@injectable()
class TestSubmissionHandler extends HydraniumGlspSubmissionHandler<TestRoot> {
   protected override readyEvent = undefined;
}

@injectable()
class TestDiagramConfiguration implements DiagramConfiguration {
   readonly layoutKind = ServerLayoutKind.NONE;
   readonly needsClientLayout = false;
   readonly animatedUpdate = false;
   readonly typeMapping = getDefaultMapping();
   readonly shapeTypeHints = [];
   readonly edgeTypeHints = [];
}

class TestDiagramModule extends DiagramModule {
   readonly diagramType = TEST_DIAGRAM_TYPE;

   protected override bindModelState(): BindingTarget<ModelState> {
      return { service: TestState };
   }
   protected override bindSourceModelStorage(): BindingTarget<SourceModelStorage> {
      return RecordingStorage;
   }
   protected override bindDiagramConfiguration(): BindingTarget<DiagramConfiguration> {
      return TestDiagramConfiguration;
   }
   protected override bindGModelFactory(): BindingTarget<GModelFactory> {
      return TestGModelFactory;
   }
   protected override bindModelSubmissionHandler(): BindingTarget<ModelSubmissionHandler> {
      return TestSubmissionHandler;
   }
   protected override configureActionHandlers(binding: InstanceMultiBinding<ActionHandlerConstructor>): void {
      super.configureActionHandlers(binding);
      binding.add(HydraniumGlspRequestSaveModelActionHandler);
   }
}

function stubSharedServices(): ServerSharedServices {
   const childLogger = {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      debug: () => undefined,
      async time<T>(_label: string, fn: () => T | Promise<T>): Promise<T> {
         return fn();
      }
   };
   return {
      Tracer: { for: () => ({ withUri: () => childLogger }) },
      workspace: { LangiumDocuments: { getDocument: () => undefined } },
      model: { ModelService: { ensureDocumentState: () => Promise.resolve(), snapshot: () => undefined, getDocument: () => undefined } }
   } as unknown as ServerSharedServices;
}

let harness: GlspHarness<TestState> | undefined;

async function startServer(): Promise<GlspHarness<TestState>> {
   savedActions = [];
   saveFailure = undefined;
   harness = makeGlspHarness<TestState>({
      serverModule: new ServerModule().configureDiagramModule(new TestDiagramModule()),
      diagramType: TEST_DIAGRAM_TYPE,
      appModules: [
         new ContainerModule(bind => {
            bind(HydraniumTypes.SharedCoreServices).toConstantValue(stubSharedServices());
            bind(HydraniumTypes.ConflictResolver).toConstantValue(new ReconcilingConflictResolver());
         })
      ]
   });
   await harness.start();
   return harness;
}

afterEach(() => {
   harness?.dispose();
   harness = undefined;
});

describe('HydraniumGlspRequestSaveModelActionHandler', () => {
   it('saves as a SaveModelAction would, then answers the request it saved', async () => {
      const server = await startServer();

      server.dispatch(RequestSaveModelAction.create({ requestId: 'save-1', fileUri: 'test://target' }));
      const saved = await server.nextAction<ModelSavedAction>(ModelSavedAction.KIND);

      expect(saved.responseId).toBe('save-1');
      expect(savedActions).toEqual([expect.objectContaining({ kind: SaveModelAction.KIND, fileUri: 'test://target' })]);
      // The dirty-state change comes first, so a client is clean when the answer arrives.
      const kinds = server.actions.map(action => action.kind);
      expect(kinds.indexOf(SetDirtyStateAction.KIND)).toBeLessThan(kinds.indexOf(ModelSavedAction.KIND));
      expect(server.actions).toContainEqual(expect.objectContaining({ kind: SetDirtyStateAction.KIND, isDirty: false, reason: 'save' }));
   });

   it('answers each request with its own id', async () => {
      const server = await startServer();

      server.dispatch(RequestSaveModelAction.create({ requestId: 'save-1' }));
      server.dispatch(RequestSaveModelAction.create({ requestId: 'save-2' }));
      // Read from the capture: a wait matches only after the last dispatch, and
      // the first answer is to the one before it.
      const answers = (): ModelSavedAction[] =>
         server.actions.filter((action): action is ModelSavedAction => action.kind === ModelSavedAction.KIND);
      await waitFor(() => answers().length === 2);

      expect(answers().map(answer => answer.responseId)).toEqual(['save-1', 'save-2']);
   });

   it('rejects a request whose save fails, shows the failure, and saves the next one', async () => {
      const server = await startServer();
      saveFailure = new Error('disk full');

      server.dispatch(RequestSaveModelAction.create({ requestId: 'save-1' }));
      const rejected = await server.nextAction<RejectAction>(RejectAction.KIND);

      expect(rejected.responseId).toBe('save-1');
      expect(rejected.detail).toContain('disk full');
      // The same notification a failed SaveModelAction raises, since a rejected
      // request reaches only the client's log.
      const shown = await server.nextAction<MessageAction>(MessageAction.KIND);
      expect(shown.severity).toBe('ERROR');
      expect(server.actions.some(action => action.kind === ModelSavedAction.KIND)).toBe(false);

      server.dispatch(RequestSaveModelAction.create({ requestId: 'save-2' }));
      await expect(server.nextAction<ModelSavedAction>(ModelSavedAction.KIND)).resolves.toMatchObject({ responseId: 'save-2' });
   });

   it('leaves GLSP’s SaveModelAction unanswered, as upstream does', async () => {
      const server = await startServer();

      server.dispatch(SaveModelAction.create());
      await server.nextAction(SetDirtyStateAction.KIND);

      expect(savedActions).toHaveLength(1);
      expect(server.actions.some(action => action.kind === ModelSavedAction.KIND)).toBe(false);
   });
});
