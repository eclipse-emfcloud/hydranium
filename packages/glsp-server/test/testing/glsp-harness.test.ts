/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, expect, it } from 'vitest';
import 'reflect-metadata';
import {
   type BindingTarget,
   type Command,
   type CreateNodeOperationHandler,
   CreateNodeOperation,
   type DiagramConfiguration,
   DiagramModule,
   GGraph,
   GLSPClientProxy,
   GLSPServer,
   type GModelFactory,
   type GModelIndex,
   GNode,
   type InstanceMultiBinding,
   ModelState,
   type ModelSubmissionHandler,
   OperationHandler,
   type OperationHandlerConstructor,
   RequestBoundsAction,
   RequestModelAction,
   type RequestModelAction as RequestModelActionType,
   SOURCE_URI_ARG,
   ServerLayoutKind,
   ServerModule,
   SetModelAction,
   type SourceModelStorage,
   type TriggerNodeCreationAction,
   UpdateModelAction,
   getDefaultMapping
} from '@eclipse-glsp/server';
import { ContainerModule, inject, injectable } from 'inversify';
import { type AstNode } from '@hydranium/langium';
import type { ElementKeyProvider, ServerSharedServices } from '@hydranium/core';
import { makeStubServiceRegistry } from '@hydranium/core/testing';
import { ReconcilingConflictResolver } from '@hydranium/protocol';
import { HydraniumGlspIndex } from '../../src/state/hydranium-glsp-index.js';
import { AbstractHydraniumGlspState } from '../../src/state/abstract-hydranium-glsp-state.js';
import { HydraniumTypes } from '../../src/state/hydranium-shared-core-services.js';
import { HydraniumGlspSubmissionHandler } from '../../src/submission/hydranium-glsp-submission-handler.js';
import { makeGlspHarness } from '../../src/testing/glsp-harness.js';

// ---------------------------------------------------------------------------
// Grammar-free GLSP fixture. GLSP needs no Langium grammar to round-trip — a
// plain source model + a GModelFactory + handlers suffice — so the framework
// package proves the harness mechanics itself, non-vacuously (the factory,
// storage, and operation handler below are real, not stubs).
// ---------------------------------------------------------------------------

const TEST_DIAGRAM_TYPE = 'test-diagram';
const TEST_NODE_TYPE = 'test:node';
const FIXTURE_URI = 'test://fixture';

interface TestNode extends AstNode {
   readonly $type: 'TestNode';
   name: string;
}

interface TestRoot extends AstNode {
   readonly $type: 'TestRoot';
   nodes: TestNode[];
}

function testRoot(...names: string[]): TestRoot {
   return { $type: 'TestRoot', nodes: names.map(name => ({ $type: 'TestNode', name })) };
}

@injectable()
class TestState extends AbstractHydraniumGlspState<TestRoot> {
   // Persistence is out of scope for the framework fixture — the round-trip
   // asserts the in-memory source-model mutation + emitted action, not a
   // write-back.
   async updateSourceModel(): Promise<void> {
      /* no-op */
   }
}

/** Real factory: projects the source root's nodes into a GGraph (one GNode per node). */
@injectable()
class TestGModelFactory implements GModelFactory {
   @inject(ModelState) protected readonly modelState!: TestState;

   createModel(): void {
      const builder = GGraph.builder().id(this.modelState.sourceUri);
      for (const node of this.modelState.sourceRoot.nodes) {
         builder.add(GNode.builder().type(TEST_NODE_TYPE).id(`node:${node.name}`).build());
      }
      this.modelState.updateRoot(builder.build());
   }
}

/**
 * Source URIs the fixture storage was asked to load, in order. Lets a test
 * assert the VALUE `openDocument` threaded rather than merely that a load
 * happened — a wrong option key would otherwise pass here, since the fixture
 * ignores the URI when seeding.
 */
const requestedSourceUris: (string | undefined)[] = [];

/** Real storage: seeds a two-node source root on load (the read side of the round-trip). */
@injectable()
class TestStorage implements SourceModelStorage {
   @inject(ModelState) protected readonly modelState!: TestState;

   loadSourceModel(action: RequestModelActionType): void {
      requestedSourceUris.push(action.options?.[SOURCE_URI_ARG] as string | undefined);
      this.modelState.setSourceRoot(FIXTURE_URI, testRoot('A', 'B'));
   }

   saveSourceModel(): void {
      /* no-op */
   }
}

/** Opt out of the document-readiness gate — the fixture has no real Langium document. */
@injectable()
class TestSubmissionHandler extends HydraniumGlspSubmissionHandler<TestRoot> {
   protected override readyEvent = undefined;
}

/** Real create handler: appends a node to the source root (the write side of the round-trip). */
@injectable()
class TestCreateNodeOperationHandler extends OperationHandler implements CreateNodeOperationHandler {
   override readonly label = 'Create Test Node';
   readonly elementTypeIds = [TEST_NODE_TYPE];
   readonly operationType = CreateNodeOperation.KIND;

   declare protected modelState: TestState;

   getTriggerActions(): TriggerNodeCreationAction[] {
      return [];
   }

   createCommand(_operation: CreateNodeOperation): Command {
      const state = this.modelState;
      return {
         execute: () => {
            state.sourceRoot.nodes.push({ $type: 'TestNode', name: `N${state.sourceRoot.nodes.length}` });
         },
         undo: () => {
            state.sourceRoot.nodes.pop();
         },
         redo: () => {
            state.sourceRoot.nodes.push({ $type: 'TestNode', name: `N${state.sourceRoot.nodes.length}` });
         }
      };
   }
}

@injectable()
class TestDiagramConfiguration implements DiagramConfiguration {
   readonly layoutKind = ServerLayoutKind.NONE;
   readonly needsClientLayout = false;
   readonly animatedUpdate = false;
   readonly typeMapping = getDefaultMapping();
   readonly shapeTypeHints = [
      { elementTypeId: TEST_NODE_TYPE, deletable: true, reparentable: false, repositionable: true, resizable: true }
   ];
   readonly edgeTypeHints = [];
}

class TestDiagramModule extends DiagramModule {
   readonly diagramType = TEST_DIAGRAM_TYPE;

   protected override bindModelState(): BindingTarget<ModelState> {
      return { service: TestState };
   }
   protected override bindGModelIndex(): BindingTarget<GModelIndex> {
      return { service: HydraniumGlspIndex };
   }
   protected override bindSourceModelStorage(): BindingTarget<SourceModelStorage> {
      return TestStorage;
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
   protected override configureOperationHandlers(binding: InstanceMultiBinding<OperationHandlerConstructor>): void {
      super.configureOperationHandlers(binding);
      binding.add(TestCreateNodeOperationHandler);
   }
}

/** Same fixture, but `needsClientLayout` — exercises the client-side-layout path (RequestModel → RequestBounds). */
@injectable()
class ClientLayoutTestDiagramConfiguration implements DiagramConfiguration {
   readonly layoutKind = ServerLayoutKind.NONE;
   readonly needsClientLayout = true;
   readonly animatedUpdate = false;
   readonly typeMapping = getDefaultMapping();
   readonly shapeTypeHints = [
      { elementTypeId: TEST_NODE_TYPE, deletable: true, reparentable: false, repositionable: true, resizable: true }
   ];
   readonly edgeTypeHints = [];
}

class ClientLayoutTestDiagramModule extends TestDiagramModule {
   protected override bindDiagramConfiguration(): BindingTarget<DiagramConfiguration> {
      return ClientLayoutTestDiagramConfiguration;
   }
}

/** No-op child logger conforming to the surface `AbstractHydraniumGlspState` reaches for. */
function noopChildLogger(): unknown {
   return {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      debug: () => undefined,
      async time<T>(_label: string, fn: () => T | Promise<T>): Promise<T> {
         return fn();
      }
   };
}

function stubSharedServices(): ServerSharedServices {
   const childLogger = noopChildLogger();
   return {
      // The index resolves its ElementKeyProvider through the registry per
      // node, so the stub language carries it rather than an app-tier binding.
      ServiceRegistry: makeStubServiceRegistry([
         {
            languageId: 'test',
            fileExtensions: ['.test'],
            services: { references: { ElementKeyProvider: stubElementKeyProvider() } }
         }
      ]),
      Tracer: { for: () => ({ withUri: () => childLogger }) },
      workspace: { LangiumDocuments: { getDocument: () => undefined } },
      model: { ModelService: { waitForDocumentState: () => Promise.resolve(), getDocument: () => undefined } }
   } as unknown as ServerSharedServices;
}

function stubElementKeyProvider(): ElementKeyProvider {
   const counters = new Map<string, number>();
   const ids = new WeakMap<object, string>();
   return {
      getElementKey(node) {
         if (!node) {
            return undefined;
         }
         const cached = ids.get(node);
         if (cached) {
            return cached;
         }
         const counter = counters.get(node.$type) ?? 0;
         counters.set(node.$type, counter + 1);
         const fresh = `id-${node.$type}-${counter}`;
         ids.set(node, fresh);
         return fresh;
      }
   } as ElementKeyProvider;
}

function testAppModule(): ContainerModule {
   return new ContainerModule(bind => {
      bind(HydraniumTypes.SharedCoreServices).toConstantValue(stubSharedServices());
      bind(HydraniumTypes.ConflictResolver).toConstantValue(new ReconcilingConflictResolver());
   });
}

function makeFixtureHarness() {
   return makeGlspHarness<TestState>({
      serverModule: new ServerModule().configureDiagramModule(new TestDiagramModule()),
      diagramType: TEST_DIAGRAM_TYPE,
      appModules: [testAppModule()]
      // The standard client action kinds (SetModel / UpdateModel / progress / …)
      // are declared by the harness by default, so this fixture needs none.
   });
}

describe('makeGlspHarness', () => {
   it('composes a container that binds the GLSP server and the capture proxy', () => {
      const harness = makeFixtureHarness();
      try {
         expect(harness.container.isBound(GLSPServer)).toBe(true);
         expect(harness.container.isBound(GLSPClientProxy)).toBe(true);
         expect(harness.actions).toHaveLength(0);
      } finally {
         harness.dispose();
      }
   });

   it('start() initializes the server and resolves state from the session container', async () => {
      const harness = makeFixtureHarness();
      try {
         await harness.start();
         expect(harness.state).toBeInstanceOf(TestState);
         expect(harness.sessionContainer.get(ModelState)).toBe(harness.state);
      } finally {
         harness.dispose();
      }
   });

   it('throws when state is read before start()', () => {
      const harness = makeFixtureHarness();
      try {
         expect(() => harness.state).toThrow(/after start/);
         expect(() => harness.sessionContainer).toThrow(/after start/);
      } finally {
         harness.dispose();
      }
   });

   it('round-trips RequestModelAction to SetModelAction with the projected GModel', async () => {
      const harness = makeFixtureHarness();
      try {
         await harness.start();
         harness.dispatch(RequestModelAction.create());
         const setModel = await harness.nextAction<SetModelAction>(SetModelAction.KIND);
         expect(setModel.newRoot.children).toHaveLength(2);
      } finally {
         harness.dispose();
      }
   });

   it('round-trips to a RequestBoundsAction when the diagram lays out client-side', async () => {
      // needsClientLayout flips the server's first response from SetModel to
      // RequestBounds, carrying the GModel for the client to measure. Confirms
      // the harness observes it, and that RequestBounds is a default kind.
      const harness = makeGlspHarness<TestState>({
         serverModule: new ServerModule().configureDiagramModule(new ClientLayoutTestDiagramModule()),
         diagramType: TEST_DIAGRAM_TYPE,
         appModules: [testAppModule()]
      });
      try {
         await harness.start();
         harness.dispatch(RequestModelAction.create());
         const requestBounds = await harness.nextAction<RequestBoundsAction>(RequestBoundsAction.KIND);
         expect(requestBounds.newRoot.children).toHaveLength(2);
      } finally {
         harness.dispose();
      }
   });

   it('drives a create operation that mutates the source model and emits an update', async () => {
      const harness = makeFixtureHarness();
      try {
         await harness.start();
         harness.dispatch(RequestModelAction.create());
         await harness.nextAction(SetModelAction.KIND);
         const before = harness.state.sourceRoot.nodes.length;

         harness.dispatch(CreateNodeOperation.create(TEST_NODE_TYPE));
         await harness.nextAction(UpdateModelAction.KIND);

         expect(harness.state.sourceRoot.nodes.length).toBe(before + 1);
      } finally {
         harness.dispose();
      }
   });

   it('nextAction rejects when no matching action arrives within the timeout', async () => {
      const harness = makeFixtureHarness();
      try {
         await harness.start();
         await expect(harness.nextAction('no-such-kind', 50)).rejects.toThrow(/no 'no-such-kind' action/);
         // And it says nothing arrived, rather than only what was missing: a
         // bare "no X within 50ms" reads as a transport hang when the usual
         // cause is a handler that threw or declined.
         await expect(harness.nextAction('no-such-kind', 50)).rejects.toThrow(/no actions were captured at all/);
      } finally {
         harness.dispose();
      }
   });

   it('dispose() is idempotent — the second call shuts the server down no further', async () => {
      const harness = makeFixtureHarness();
      await harness.start();
      let shutdowns = 0;
      harness.server.addListener({
         serverShutDown: () => {
            shutdowns += 1;
         }
      });
      harness.dispose();
      expect(() => harness.dispose()).not.toThrow();
      // not.toThrow() cannot see the guard: `server.shutdown()` and
      // `container.unbindAll()` are both double-safe on their own, so a second
      // teardown is silent. The shutdown fan-out is not — `serverListeners`
      // survives shutdown, so an unguarded second dispose notifies twice.
      expect(shutdowns).toBe(1);
   });

   it('openDocument threads the source URI and resolves on SetModel when the server lays out', async () => {
      const harness = makeFixtureHarness();
      requestedSourceUris.length = 0;
      try {
         await harness.start();
         const submission = await harness.openDocument('file:///some/model.test');

         expect(submission.kind).toBe(SetModelAction.KIND);
         // The VALUE, not just that a load happened: a wrong option key would
         // still seed the fixture root and produce a submission.
         expect(requestedSourceUris).toEqual(['file:///some/model.test']);
      } finally {
         harness.dispose();
      }
   });

   it('openDocument resolves on RequestBounds when the diagram lays out client-side', async () => {
      // The point of the helper: the SAME call settles on whichever submission
      // the diagram configuration produces. A test awaiting a fixed kind here
      // would time out and blame the wrong subsystem.
      const harness = makeGlspHarness<TestState>({
         serverModule: new ServerModule().configureDiagramModule(new ClientLayoutTestDiagramModule()),
         diagramType: TEST_DIAGRAM_TYPE,
         appModules: [testAppModule()]
      });
      try {
         await harness.start();
         const submission = await harness.openDocument('file:///some/model.test');
         expect(submission.kind).toBe(RequestBoundsAction.KIND);
      } finally {
         harness.dispose();
      }
   });

   it('nextModelSubmission resolves undefined on timeout when asked not to reject', async () => {
      const harness = makeFixtureHarness();
      try {
         await harness.start();
         // Nothing dispatched, so nothing is submitted — the shape a REJECTED
         // operation produces, since a handler returning no command emits no
         // action at all.
         await expect(harness.nextModelSubmission({ timeoutMs: 50, rejectOnTimeout: false })).resolves.toBeUndefined();
      } finally {
         harness.dispose();
      }
   });

   it('nextModelSubmission rejects on timeout by default, naming the kinds it waited for', async () => {
      const harness = makeFixtureHarness();
      try {
         await harness.start();
         await expect(harness.nextModelSubmission({ timeoutMs: 50 })).rejects.toThrow(/'setModel'.*'updateModel'.*'requestBounds'/);
      } finally {
         harness.dispose();
      }
   });

   it('lists what DID arrive when a wait times out after other actions', async () => {
      const harness = makeFixtureHarness();
      try {
         await harness.start();
         await harness.openDocument('file:///some/model.test');

         // The diagnostic case that matters: something happened, just not the
         // awaited thing. Naming it separates "handler declined" from "nothing
         // reached the server at all".
         await expect(harness.nextAction('no-such-kind', 50)).rejects.toThrow(/captured since start: .*setModel/);
      } finally {
         harness.dispose();
      }
   });

   it('openDocument rejects before start()', async () => {
      const harness = makeFixtureHarness();
      try {
         // Rejects rather than throwing synchronously: it is an async method, so
         // a caller only has one place to handle failure.
         await expect(harness.openDocument('file:///x.test')).rejects.toThrow(/after start/);
      } finally {
         harness.dispose();
      }
   });
});
