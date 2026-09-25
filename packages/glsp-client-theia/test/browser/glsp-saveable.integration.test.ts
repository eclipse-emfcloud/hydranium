/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

// The saveable between GLSP's real client dispatcher and editor context and the
// framework's real GLSP server. The unit tests model both ends; this one is
// where a wrong model of either shows: the client editor context drops a
// dirty-state change that changes nothing, and only the real server decides
// what is answered and in which order.
vi.hoisted(() => {
   const { createRequire } = globalThis.process.getBuiltinModule('node:module');
   createRequire(__filename).extensions['.css'] = module => {
      module.exports = {};
   };
});

import 'reflect-metadata';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
   type Action,
   ActionHandlerRegistry,
   DefaultModelInitializationConstraint,
   EditorContextService,
   GLSPActionDispatcher,
   NullLogger,
   SaveModelAction,
   SetDirtyStateAction
} from '@eclipse-glsp/client';
import {
   type ActionHandlerConstructor,
   type BindingTarget,
   type Command,
   DefaultGLSPServer,
   type DiagramConfiguration,
   DiagramModule,
   GGraph,
   type GModelFactory,
   type GModelIndex,
   type InstanceMultiBinding,
   ModelState,
   type ModelSubmissionHandler,
   type Operation,
   OperationHandler,
   type OperationHandlerConstructor,
   ServerLayoutKind,
   ServerModule,
   type SourceModelStorage,
   getDefaultMapping
} from '@eclipse-glsp/server';
import {
   AbstractHydraniumGlspState,
   HydraniumGlspIndex,
   HydraniumGlspRequestSaveModelActionHandler,
   HydraniumGlspSubmissionHandler,
   HydraniumTypes
} from '@hydranium/glsp-server';
import { type GlspHarness, makeGlspHarness } from '@hydranium/glsp-server/lib/testing';
import type { ServerSharedServices } from '@hydranium/core';
import { ReconcilingConflictResolver, RequestSaveModelAction } from '@hydranium/protocol';
import { ContainerModule, inject, injectable } from 'inversify';
import { HydraniumGlspSaveable } from '../../src/browser/glsp-saveable';

const TEST_DIAGRAM_TYPE = 'test-diagram';
const EDIT_KIND = 'testEdit';

interface TestRoot {
   readonly $type: 'TestRoot';
   /** How many edits the model has taken; a save records it. */
   edits: number;
}

/** The edit count each save wrote, in order. */
let savedEdits: number[] = [];
/** Thrown by the next save when set. */
let saveFailure: Error | undefined;

@injectable()
class TestState extends AbstractHydraniumGlspState<TestRoot> {
   async updateSourceModel(): Promise<void> {
      /* no-op: the edit changes the root in place */
   }
}

@injectable()
class RecordingStorage implements SourceModelStorage {
   @inject(ModelState) protected readonly modelState!: TestState;

   loadSourceModel(): void {
      this.modelState.setSourceRoot('test://fixture', { $type: 'TestRoot', edits: 0 });
   }
   async saveSourceModel(): Promise<void> {
      const failure = saveFailure;
      saveFailure = undefined;
      if (failure) {
         throw failure;
      }
      savedEdits.push(this.modelState.sourceRoot.edits);
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

/** An edit: one more on the model's count, through the command stack, so the model turns dirty. */
@injectable()
class TestEditOperationHandler extends OperationHandler {
   readonly operationType = EDIT_KIND;

   declare protected modelState: TestState;

   createCommand(): Command {
      const root = this.modelState.sourceRoot;
      return {
         execute: () => void root.edits++,
         undo: () => void root.edits--,
         redo: () => void root.edits++
      };
   }
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
   protected override bindGModelIndex(): BindingTarget<GModelIndex> {
      return { service: HydraniumGlspIndex };
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
   protected override configureOperationHandlers(binding: InstanceMultiBinding<OperationHandlerConstructor>): void {
      super.configureOperationHandlers(binding);
      binding.add(TestEditOperationHandler);
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
   // The index keys the root through its language; one key serves the fixture.
   const language = { references: { ElementKeyProvider: { getElementKey: () => 'root' } } };
   return {
      ServiceRegistry: { getServicesFor: () => language },
      Tracer: { for: () => ({ withUri: () => childLogger }) },
      workspace: { LangiumDocuments: { getDocument: () => undefined } },
      model: { ModelService: { waitForDocumentState: () => Promise.resolve(), snapshot: () => undefined, getDocument: () => undefined } }
   } as unknown as ServerSharedServices;
}

/**
 * GLSP's client dispatcher with the wiring a diagram container gives it: the
 * editor context takes dirty-state changes, and the kinds the server says it
 * handles go to the server, as GLSP's model source forwards them. A kind the
 * server does not advertise has no handler here, so the save request only
 * reaches the server if the server advertises it.
 */
class WiredDispatcher extends GLSPActionDispatcher {
   constructor(context: EditorContextService, serverKinds: readonly string[], toServer: (action: Action) => void) {
      super();
      const registry = new ActionHandlerRegistry([], []);
      registry.register(SetDirtyStateAction.KIND, context);
      for (const kind of serverKinds) {
         registry.register(kind, { handle: action => void toServer(action) });
      }
      this.actionHandlerRegistry = registry;
      this.initializationConstraint = new DefaultModelInitializationConstraint();
      this.diagramLocker = { isAllowed: () => true };
      this.logger = new NullLogger();
      this.initialized = Promise.resolve();
   }
}

interface Diagram {
   readonly saveable: HydraniumGlspSaveable;
   readonly context: EditorContextService;
   readonly server: GlspHarness<TestState>;
   /** The kinds the client sent to the server, in order. */
   readonly sent: readonly string[];
   /** Edit through the client, as a user would, and wait until the client knows it is dirty. */
   edit(): Promise<void>;
   /** Hold the server's actions back from the client until {@link release}, as a slow link would. */
   hold(): void;
   release(): void;
}

let harness: GlspHarness<TestState> | undefined;
let pump: ReturnType<typeof setInterval> | undefined;

afterEach(() => {
   clearInterval(pump);
   harness?.dispose();
   harness = undefined;
});

/**
 * @param answersSaves whether the server advertises the save request; a server
 *    whose diagram module does not register its handler does not.
 */
async function openDiagram(answersSaves = true): Promise<Diagram> {
   savedEdits = [];
   saveFailure = undefined;
   const server = makeGlspHarness<TestState>({
      serverModule: new ServerModule().configureDiagramModule(new TestDiagramModule()),
      diagramType: TEST_DIAGRAM_TYPE,
      appModules: [
         new ContainerModule(bind => {
            bind(HydraniumTypes.SharedCoreServices).toConstantValue(stubSharedServices());
            bind(HydraniumTypes.ConflictResolver).toConstantValue(new ReconcilingConflictResolver());
         })
      ]
   });
   harness = server;
   await server.start();
   await server.openDocument('test://fixture');

   const context = new EditorContextService();
   const initialized = await server.server.initialize({ applicationId: 'test-app', protocolVersion: DefaultGLSPServer.PROTOCOL_VERSION });
   const serverKinds = initialized.serverActions[TEST_DIAGRAM_TYPE].filter(kind => answersSaves || kind !== RequestSaveModelAction.KIND);
   const sent: string[] = [];
   const dispatcher = new WiredDispatcher(context, serverKinds, action => {
      sent.push(action.kind);
      void server.dispatch(action);
   });
   // The server's actions reach the client in the order it sent them, as over
   // a socket; the harness captures them, and this hands each one on.
   let delivered = server.actions.length;
   let held = false;
   pump = setInterval(() => {
      while (!held && delivered < server.actions.length) {
         void dispatcher.dispatch(server.actions[delivered++]).catch(() => undefined);
      }
   }, 1);
   const saveable = new HydraniumGlspSaveable(dispatcher, context);
   return {
      saveable,
      context,
      server,
      sent,
      hold: () => (held = true),
      release: () => (held = false),
      async edit(): Promise<void> {
         const edit: Operation = { kind: EDIT_KIND, isOperation: true };
         const edits = server.state.sourceRoot.edits;
         void dispatcher.dispatch(edit);
         await vi.waitFor(() => {
            expect(server.state.sourceRoot.edits).toBe(edits + 1);
            expect(context.isDirty).toBe(true);
         });
      }
   };
}

describe('HydraniumGlspSaveable against the GLSP client and server', () => {
   it('resolves both saves of a double save with no edit between', async () => {
      const { saveable, edit } = await openDiagram();
      await edit();

      const saves = Promise.all([saveable.save(), saveable.save()]);

      await expect(saves).resolves.toEqual([undefined, undefined]);
      expect(savedEdits).toEqual([1, 1]);
      expect(saveable.dirty).toBe(false);
   });

   it('saves an edit made between two saves', async () => {
      const { saveable, edit, hold, release } = await openDiagram();
      await edit();
      // The first save is still unanswered on the client when the edit and the
      // second save are made.
      hold();
      const first = saveable.save();
      await edit();
      const second = saveable.save();
      release();

      await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
      expect(savedEdits.at(-1)).toBe(2);
      expect(saveable.dirty).toBe(false);
   });

   it('rejects a failed save and saves on the next attempt', async () => {
      const { saveable, edit } = await openDiagram();
      await edit();
      saveFailure = new Error('disk full');

      await expect(saveable.save()).rejects.toThrow();
      expect(saveable.dirty).toBe(true);

      await expect(saveable.save()).resolves.toBeUndefined();
      expect(savedEdits).toEqual([1]);
      expect(saveable.dirty).toBe(false);
   });

   it('saves as GLSP does when the server does not advertise the save request', async () => {
      const { saveable, edit, sent } = await openDiagram(false);
      await edit();

      await expect(saveable.save()).resolves.toBeUndefined();

      expect(sent).toContain(SaveModelAction.KIND);
      expect(sent).not.toContain(RequestSaveModelAction.KIND);
      expect(savedEdits).toEqual([1]);
      expect(saveable.dirty).toBe(false);
   });
});
