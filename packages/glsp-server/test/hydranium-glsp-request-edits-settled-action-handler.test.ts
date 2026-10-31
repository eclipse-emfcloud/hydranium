/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import 'reflect-metadata';
import {
   type Action,
   ActionDispatchScope,
   ActionDispatcher,
   type ActionHandler,
   type ActionHandlerConstructor,
   type BindingTarget,
   ChangeBoundsOperation,
   type Command,
   type DiagramConfiguration,
   DiagramModule,
   GGraph,
   type GModelFactory,
   type InstanceMultiBinding,
   type MaybePromise,
   MessageAction,
   ModelState,
   type ModelSubmissionHandler,
   type Operation,
   OperationActionHandler,
   OperationHandler,
   RejectAction,
   type OperationHandlerConstructor,
   ServerLayoutKind,
   ServerModule,
   SetDirtyStateAction,
   type SourceModelStorage,
   getDefaultMapping
} from '@eclipse-glsp/server';
import { BrowserActionDispatchScope } from '@eclipse-glsp/server/browser.js';
import { ContainerModule, inject, injectable } from 'inversify';
import { type AstNode } from '@hydranium/langium';
import type { ServerSharedServices } from '@hydranium/core';
import {
   asModelVersion,
   ConflictError,
   Deferred,
   EditsSettledAction,
   ReconcilingConflictResolver,
   RequestEditsSettledAction
} from '@hydranium/protocol';
import { type FakeClock, makeFakeClock, tick, waitFor } from '@hydranium/protocol/testing';
import { DiagramWriteRanOutError } from '../src/command/diagram-edit-dropped-error.js';
import { HydraniumGlspOperationActionHandler } from '../src/command/hydranium-glsp-operation-action-handler.js';
import { HydraniumGlspServerActionDispatcher } from '../src/dispatcher/server-action-dispatcher.js';
import { AbstractHydraniumGlspState } from '../src/state/abstract-hydranium-glsp-state.js';
import { HydraniumTypes } from '../src/state/hydranium-shared-core-services.js';
import { HydraniumGlspRequestEditsSettledActionHandler } from '../src/storage/hydranium-glsp-request-edits-settled-action-handler.js';
import { takeSettleFailureLogged } from '../src/storage/logged-settle-failures.js';
import { HydraniumGlspStorage } from '../src/storage/hydranium-glsp-storage.js';
import { HydraniumGlspSubmissionHandler } from '../src/submission/hydranium-glsp-submission-handler.js';
import { type GlspHarness, makeGlspHarness } from '../src/testing/glsp-harness.js';
import { type CapturingGlspLogger, makeCapturingGlspLogger } from '../src/testing/make-noop-glsp-logger.js';

// Grammar-free: the handler's contract is its order against the edits before
// it and its wait for the language client, so the settle is a double a test
// holds and releases.

const TEST_DIAGRAM_TYPE = 'test-diagram';
const CLIENT_DOCUMENTS = new Set(['file:///a.x', 'file:///b.x']);

interface TestRoot extends AstNode {
   readonly $type: 'TestRoot';
}

/** The documents each settle was asked for, in order. */
let settledUris: string[] = [];
/** Settles a test holds; one not listed resolves at once. */
let heldSettles = new Map<string, Deferred<void>>();
/** Holds the operation's handler when set, until the test resolves it. */
let heldOperation: Deferred<void> | undefined;

@injectable()
class TestState extends AbstractHydraniumGlspState<TestRoot> {
   async updateSourceModel(): Promise<void> {
      /* no-op: nothing edits this fixture */
   }
}

@injectable()
class NoStorage implements SourceModelStorage {
   loadSourceModel(): void {
      /* no-op: the request needs no model */
   }
   saveSourceModel(): void {
      /* no-op */
   }
}

/** What the framework storage below says a save writes. */
let storageWriteSet: string[] = [];

@injectable()
class WriteSetStorage extends HydraniumGlspStorage<TestRoot> {
   override openWriteSet(): string[] {
      return storageWriteSet;
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

/** Thrown by the next operation when set. */
let operationFailure: Error | undefined;
/**
 * Operations each dispatched, without awaiting, by the handler of the one
 * before, the first by any other operation's, so the server queues each behind
 * the one running. The last answers {@link queuedAnswers}.
 */
let queueChain: Operation[] = [];
/** What the queued operation answers, in place of a model update. */
let queuedAnswers: Action[] = [];
/** Refuses the queued operation when set, whose resync then answers {@link queuedAnswers}. */
let queuedRefusal: Error | undefined;
/** Holds the handling of a {@link HELD_KIND} action, a delivered answer, until the test resolves it. */
let heldDelivery: Deferred<void> | undefined;
const HELD_KIND = 'heldDelivery';

/** Resolves once a {@link HELD_KIND} action is being handled. */
let deliveryEntered: Deferred<void>;
/** How many {@link HELD_KIND} actions have been handled so far. */
let deliveriesEntered = 0;
/** Dispatched, without awaiting, by the next {@link HELD_KIND} handling once {@link deliveryDispatchGate} opens. */
let deliveryDispatch: Operation | undefined;
let deliveryDispatchGate: Deferred<void>;

/** Answers the last of {@link queueChain} with {@link queuedAnswers}, and runs any other operation as the framework does. */
@injectable()
class QueuingOperationActionHandler extends HydraniumGlspOperationActionHandler {
   protected override runOperation(operation: Operation, handler: OperationHandler): Promise<Action[]> {
      if (operation !== queueChain.at(-1)) {
         return super.runOperation(operation, handler);
      }
      return queuedRefusal === undefined ? Promise.resolve(queuedAnswers) : Promise.reject(queuedRefusal);
   }

   protected override submitModel(): MaybePromise<Action[]> {
      return queuedRefusal === undefined ? super.submitModel() : queuedAnswers;
   }
}

/** A server-side handler of a delivered answer, held by {@link heldDelivery}. */
@injectable()
class HeldDeliveryHandler implements ActionHandler {
   readonly actionKinds = [HELD_KIND];
   @inject(ActionDispatcher) protected readonly actionDispatcher!: ActionDispatcher;

   async execute(): Promise<Action[]> {
      deliveriesEntered++;
      deliveryEntered.resolve();
      const dispatched = deliveryDispatch;
      deliveryDispatch = undefined;
      if (dispatched !== undefined) {
         await deliveryDispatchGate.promise;
         void this.actionDispatcher.dispatch(dispatched);
      }
      await heldDelivery?.promise;
      return [];
   }
}
/** Resolves once the operation has started. */
let operationEntered: Deferred<void>;

/** An operation that changes nothing, which the server answers with no action at all, or fails when told to. */
@injectable()
class NoCommandChangeBoundsHandler extends OperationHandler {
   readonly operationType = ChangeBoundsOperation.KIND;
   @inject(ActionDispatcher) protected readonly actionDispatcher!: ActionDispatcher;

   // Upstream's also asks for a model root, which this fixture never loads.
   override handles(operation: Operation): boolean {
      return operation.kind === this.operationType;
   }

   async createCommand(operation: Operation): Promise<Command | undefined> {
      const next = queueChain[queueChain.indexOf(operation) + 1];
      if (next !== undefined) {
         void this.actionDispatcher.dispatch(next);
      }
      operationEntered.resolve();
      await heldOperation?.promise;
      if (operationFailure) {
         throw operationFailure;
      }
      return undefined;
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

   constructor(protected readonly storage: BindingTarget<SourceModelStorage>) {
      super();
   }

   protected override bindModelState(): BindingTarget<ModelState> {
      return { service: TestState };
   }
   // The framework's, as its diagram module binds, which the handler asks whether the server awaits its answer.
   protected override bindActionDispatcher(): BindingTarget<ActionDispatcher> {
      return HydraniumGlspServerActionDispatcher;
   }
   protected override bindSourceModelStorage(): BindingTarget<SourceModelStorage> {
      return this.storage;
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
      binding.rebind(OperationActionHandler, QueuingOperationActionHandler);
      binding.add(HydraniumGlspRequestEditsSettledActionHandler);
      binding.add(HeldDeliveryHandler);
   }
   protected override configureOperationHandlers(binding: InstanceMultiBinding<OperationHandlerConstructor>): void {
      super.configureOperationHandlers(binding);
      binding.add(NoCommandChangeBoundsHandler);
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
      Clock: clock,
      Tracer: { for: () => ({ withUri: () => childLogger }) },
      workspace: {
         LangiumDocuments: { getDocument: () => undefined },
         // The harness's default client session.
         TextDocuments: { isOpenInClient: (uri: string, clientId: string) => clientId === 'test-session' && CLIENT_DOCUMENTS.has(uri) }
      },
      model: {
         ModelService: {
            ensureDocumentState: () => Promise.resolve(),
            snapshot: () => undefined,
            getDocument: () => undefined,
            settleLanguageClient: (uri: string) => {
               settledUris.push(uri);
               return heldSettles.get(uri)?.promise ?? Promise.resolve();
            }
         }
      }
   } as unknown as ServerSharedServices;
}

let harness: GlspHarness<TestState> | undefined;
/** What the server logged, the handler's lines among them. */
let logged: CapturingGlspLogger = makeCapturingGlspLogger();
/** The handler's clock, which only a test moves. */
let clock: FakeClock = makeFakeClock();

async function startServer(
   sourceUri: string | undefined,
   secondaryUris: readonly string[] = [],
   storage: BindingTarget<SourceModelStorage> = NoStorage
): Promise<GlspHarness<TestState>> {
   settledUris = [];
   heldSettles = new Map();
   heldOperation = undefined;
   operationFailure = undefined;
   queueChain = [];
   clock = makeFakeClock();
   logged = makeCapturingGlspLogger();
   queuedAnswers = [];
   queuedRefusal = undefined;
   heldDelivery = undefined;
   operationEntered = new Deferred<void>();
   deliveryEntered = new Deferred<void>();
   deliveriesEntered = 0;
   deliveryDispatch = undefined;
   deliveryDispatchGate = new Deferred<void>();
   harness = makeGlspHarness<TestState>({
      serverModule: new ServerModule().configureDiagramModule(new TestDiagramModule(storage)),
      diagramType: TEST_DIAGRAM_TYPE,
      createLogger: () => logged.logger,
      appModules: [
         new ContainerModule((bind, _unbind, _isBound, rebind) => {
            if (dispatchScope === 'browser') {
               rebind(ActionDispatchScope).to(BrowserActionDispatchScope);
            }
            bind(HydraniumTypes.SharedCoreServices).toConstantValue(stubSharedServices());
            bind(HydraniumTypes.ConflictResolver).toConstantValue(new ReconcilingConflictResolver());
         })
      ]
   });
   await harness.start();
   // Left unset for no URI: before a model loads, the state really has none.
   if (sourceUri !== undefined) {
      vi.spyOn(harness.state, 'sourceUri', 'get').mockReturnValue(sourceUri);
   }
   vi.spyOn(harness.state, 'secondaryUris', 'get').mockReturnValue(secondaryUris);
   // The framework's operation run remaps the semantic index, which this grammar-free fixture lacks.
   Object.assign(harness.state.index, { remapSemanticAliases: () => undefined });
   return harness;
}

const answers = (server: GlspHarness<TestState>): EditsSettledAction[] =>
   server.actions.filter((action): action is EditsSettledAction => action.kind === EditsSettledAction.KIND);

afterEach(() => {
   harness?.dispose();
   harness = undefined;
   vi.restoreAllMocks();
});

/** The dispatch scope {@link startServer} binds: GLSP's Node one, or the browser worker's. */
let dispatchScope: 'node' | 'browser' = 'node';

describe.each(['node', 'browser'] as const)('HydraniumGlspRequestEditsSettledActionHandler, %s dispatch scope', scope => {
   beforeEach(() => {
      dispatchScope = scope;
   });
   // Under the browser scope an operation one queued dispatches, and a held
   // delivery, wait in GLSP's own queue, which a hung handler stops for all.
   const underNodeScope = it.runIf(scope === 'node');

   it('answers the request with its own id', async () => {
      const server = await startServer('file:///a.x');

      server.dispatch(RequestEditsSettledAction.create({ requestId: 'settle-1' }));

      await expect(server.nextAction<EditsSettledAction>(EditsSettledAction.KIND)).resolves.toMatchObject({ responseId: 'settle-1' });
   });

   it('rejects the request when finding the documents to settle fails, which ends the count as an answer would', async () => {
      const server = await startServer('file:///a.x');
      vi.spyOn(
         HydraniumGlspRequestEditsSettledActionHandler.prototype as unknown as { documentsToSettle(): string[] },
         'documentsToSettle'
      ).mockImplementation(() => {
         throw new Error('no write set');
      });

      server.dispatch(RequestEditsSettledAction.create({ requestId: 'settle-1' }));

      // The cause once, as a request that throws directly is answered.
      await expect(server.nextAction<RejectAction>(RejectAction.KIND)).resolves.toMatchObject({
         responseId: 'settle-1',
         message: expect.stringContaining('settle-1'),
         detail: 'Error: no write set'
      });
      expect(answers(server)).toEqual([]);
      // Once, with the cause's stack, which the server's rejection does not carry.
      const errors = logged.lines.filter(line => line.level === 'error');
      expect(errors).toHaveLength(1);
      expect(errors[0]?.message).toMatch(/no write set\n\s+at /);
   });

   it('logs a failure once when the request carries a timeout that has not passed', async () => {
      const server = await startServer('file:///a.x');
      vi.spyOn(
         HydraniumGlspRequestEditsSettledActionHandler.prototype as unknown as { documentsToSettle(): string[] },
         'documentsToSettle'
      ).mockImplementation(() => {
         throw new Error('no write set');
      });

      const request: RequestEditsSettledAction = { ...RequestEditsSettledAction.create({ requestId: 'settle-1' }), timeout: 60_000 };
      server.dispatch(request);

      await expect(server.nextAction<RejectAction>(RejectAction.KIND)).resolves.toMatchObject({ responseId: 'settle-1' });
      expect(logged.lines.filter(line => line.level === 'error')).toHaveLength(1);
   });

   it('leaves no mark for a failure after the timeout the server rejected the request on', async () => {
      const server = await startServer('file:///a.x');
      const held = new Deferred<void>();
      heldSettles.set('file:///a.x', held);

      const request: RequestEditsSettledAction = { ...RequestEditsSettledAction.create({ requestId: 'settle-1' }), timeout: 20 };
      server.dispatch(request);
      await expect(server.nextAction<RejectAction>(RejectAction.KIND)).resolves.toMatchObject({
         responseId: 'settle-1',
         detail: expect.stringContaining('timed out')
      });
      held.reject(new Error('late'));

      await waitFor(() => logged.lines.some(line => /settle request 'settle-1' failed/i.test(line.message)));
      expect(takeSettleFailureLogged(server.state.clientId, 'settle-1')).toBe(false);
      expect(answers(server)).toEqual([]);
   });

   it('logs a failure once when the request fails before the handler waits, which the server then logs', async () => {
      const server = await startServer('file:///a.x');
      vi.spyOn(server.state, 'runExclusive').mockImplementation(() => {
         throw new Error('no exclusive section');
      });

      server.dispatch(RequestEditsSettledAction.create({ requestId: 'settle-1' }));

      await expect(server.nextAction<RejectAction>(RejectAction.KIND)).resolves.toMatchObject({ responseId: 'settle-1' });
      const errors = logged.lines.filter(line => line.level === 'error');
      expect(errors).toHaveLength(1);
      expect(errors[0]?.message).toMatch(/no exclusive section\n\s+at /);
   });

   it('answers nothing and warns of nothing when its session ends while it waits', async () => {
      const server = await startServer('file:///a.x');
      const held = new Deferred<void>();
      heldSettles.set('file:///a.x', held);
      server.dispatch(RequestEditsSettledAction.create({ requestId: 'settle-1' }));
      await waitFor(() => settledUris.includes('file:///a.x'));

      await server.shutdown();
      held.resolve();

      // The handler's own lines; the server logs the request ending with its session too.
      const aboutRequest = () => logged.lines.filter(line => /settle request 'settle-1'/i.test(line.message));
      await waitFor(() => aboutRequest().length > 0 || answers(server).length > 0);
      expect(answers(server)).toEqual([]);
      expect(aboutRequest().map(line => line.level)).toEqual(['debug']);
   });

   it("answers, over a storage of another kind, only once the language client has the text of each of the diagram's documents this client has open", async () => {
      const server = await startServer('file:///a.x', ['file:///b.x', 'file:///c.x']);
      const held = new Deferred<void>();
      heldSettles.set('file:///b.x', held);

      server.dispatch(RequestEditsSettledAction.create({ requestId: 'settle-1' }));
      await waitFor(() => settledUris.length === 2);
      // Not a delay: the settles are asked for, and the answer can only follow them.
      expect(settledUris).toEqual(['file:///a.x', 'file:///b.x']);
      expect(answers(server)).toEqual([]);

      held.resolve();
      await expect(server.nextAction<EditsSettledAction>(EditsSettledAction.KIND)).resolves.toMatchObject({ responseId: 'settle-1' });
   });

   it("waits for the documents the framework's storage says a save writes, one that left the diagram's set included", async () => {
      storageWriteSet = ['file:///a.x', 'file:///d.x'];
      const server = await startServer('file:///a.x', ['file:///b.x'], WriteSetStorage);

      server.dispatch(RequestEditsSettledAction.create({ requestId: 'settle-1' }));

      await expect(server.nextAction<EditsSettledAction>(EditsSettledAction.KIND)).resolves.toMatchObject({ responseId: 'settle-1' });
      expect(settledUris).toEqual(['file:///a.x', 'file:///d.x']);
   });

   it('answers before a model is loaded, with nothing to wait for', async () => {
      const server = await startServer(undefined);

      server.dispatch(RequestEditsSettledAction.create({ requestId: 'settle-1' }));

      await expect(server.nextAction<EditsSettledAction>(EditsSettledAction.KIND)).resolves.toMatchObject({ responseId: 'settle-1' });
      expect(settledUris).toEqual([]);
   });

   it('answers after the operation sent before it, which the server answers with nothing at all', async () => {
      const server = await startServer('file:///a.x');
      heldOperation = new Deferred<void>();
      const before = server.actions.length;

      server.dispatch(ChangeBoundsOperation.create([]));
      server.dispatch(RequestEditsSettledAction.create({ requestId: 'settle-1' }));
      // A request the server takes up while the operation runs would settle now.
      await operationEntered.promise;
      await tick();
      expect(settledUris).toEqual([]);
      expect(answers(server)).toEqual([]);

      heldOperation.resolve();
      await server.nextAction(EditsSettledAction.KIND);
      // The operation answered nothing, so the settle's answer is the only action after it.
      expect(server.actions.slice(before).map(action => action.kind)).toEqual([EditsSettledAction.KIND]);
   });

   it('answers only once an operation the server queued outside its action queue has run', async () => {
      const server = await startServer('file:///a.x');
      const queued = new Deferred<void>();
      // Where a queued operation runs: in the state's exclusive section, which the server's action queue does not await.
      const run = server.state.runExclusive(() => queued.promise);

      server.dispatch(RequestEditsSettledAction.create({ requestId: 'settle-1' }));
      await tick();
      expect(settledUris).toEqual([]);
      expect(answers(server)).toEqual([]);

      queued.resolve();
      await run;
      await expect(server.nextAction<EditsSettledAction>(EditsSettledAction.KIND)).resolves.toMatchObject({ responseId: 'settle-1' });
   });

   it('answers only once the answers of an operation the server queued have been delivered, its dirty state included', async () => {
      const server = await startServer('file:///a.x');
      queueChain = [ChangeBoundsOperation.create([])];
      queuedAnswers = [{ kind: HELD_KIND }, SetDirtyStateAction.create(true)];
      heldDelivery = new Deferred<void>();

      const before = server.actions.length;
      server.dispatch(ChangeBoundsOperation.create([]));
      server.dispatch(RequestEditsSettledAction.create({ requestId: 'settle-1' }));
      await deliveryEntered.promise;
      await tick(5);
      expect(answers(server)).toEqual([]);

      heldDelivery.resolve();
      await server.nextAction(EditsSettledAction.KIND);
      const kinds = server.actions.slice(before).map(action => action.kind);
      expect(kinds).toContain(SetDirtyStateAction.KIND);
      expect(kinds.indexOf(SetDirtyStateAction.KIND)).toBeLessThan(kinds.indexOf(EditsSettledAction.KIND));
   });

   it('answers only once the resync of an operation the server queued and refused has been delivered', async () => {
      const server = await startServer('file:///a.x');
      // The resync needs a session, which this fixture never loads.
      Object.assign(server.state, { modelSession: {} });
      queueChain = [ChangeBoundsOperation.create([])];
      queuedRefusal = new DiagramWriteRanOutError('the document kept changing', new ConflictError('file:///a.x', asModelVersion(1), 2));
      queuedAnswers = [{ kind: HELD_KIND }];
      heldDelivery = new Deferred<void>();

      server.dispatch(ChangeBoundsOperation.create([]));
      server.dispatch(RequestEditsSettledAction.create({ requestId: 'settle-1' }));
      await deliveryEntered.promise;
      await tick(5);
      expect(answers(server)).toEqual([]);

      heldDelivery.resolve();
      await expect(server.nextAction<EditsSettledAction>(EditsSettledAction.KIND)).resolves.toMatchObject({ responseId: 'settle-1' });
   });

   it('answers a second request only once the delivery the first is waiting for is done too', async () => {
      const server = await startServer('file:///a.x');
      queueChain = [ChangeBoundsOperation.create([])];
      queuedAnswers = [{ kind: HELD_KIND }, SetDirtyStateAction.create(true)];
      heldDelivery = new Deferred<void>();

      const before = server.actions.length;
      server.dispatch(ChangeBoundsOperation.create([]));
      server.dispatch(RequestEditsSettledAction.create({ requestId: 'settle-1' }));
      server.dispatch(RequestEditsSettledAction.create({ requestId: 'settle-2' }));
      await deliveryEntered.promise;
      await tick(5);
      expect(answers(server)).toEqual([]);

      heldDelivery.resolve();
      await waitFor(() => answers(server).length === 2);
      const kinds = server.actions.slice(before).map(action => action.kind);
      expect(kinds.indexOf(SetDirtyStateAction.KIND)).toBeGreaterThan(-1);
      expect(kinds.indexOf(SetDirtyStateAction.KIND)).toBeLessThan(kinds.indexOf(EditsSettledAction.KIND));
   });

   underNodeScope('answers only once an operation queued by a queued operation has been delivered too', async () => {
      const server = await startServer('file:///a.x');
      queueChain = [ChangeBoundsOperation.create([]), ChangeBoundsOperation.create([])];
      queuedAnswers = [{ kind: HELD_KIND }, SetDirtyStateAction.create(true)];
      heldDelivery = new Deferred<void>();

      const before = server.actions.length;
      server.dispatch(ChangeBoundsOperation.create([]));
      server.dispatch(RequestEditsSettledAction.create({ requestId: 'settle-1' }));
      await deliveryEntered.promise;
      await tick(5);
      expect(answers(server)).toEqual([]);

      heldDelivery.resolve();
      await server.nextAction(EditsSettledAction.KIND);
      const kinds = server.actions.slice(before).map(action => action.kind);
      expect(kinds).toContain(SetDirtyStateAction.KIND);
      expect(kinds.indexOf(SetDirtyStateAction.KIND)).toBeLessThan(kinds.indexOf(EditsSettledAction.KIND));
   });

   underNodeScope('answers past its bound while a delivery hangs, and the next request without waiting for that one again', async () => {
      const server = await startServer('file:///a.x');
      queueChain = [ChangeBoundsOperation.create([])];
      queuedAnswers = [{ kind: HELD_KIND }];
      heldDelivery = new Deferred<void>();

      server.dispatch(ChangeBoundsOperation.create([]));
      server.dispatch(RequestEditsSettledAction.create({ requestId: 'settle-1' }));
      await deliveryEntered.promise;
      // Not a delay: the request has taken up its wait by the time the delivery runs.
      await tick(5);
      clock.advance(4_999);
      await tick(5);
      expect(answers(server)).toEqual([]);
      clock.advance(1);
      await expect(server.nextAction<EditsSettledAction>(EditsSettledAction.KIND)).resolves.toMatchObject({ responseId: 'settle-1' });

      server.dispatch(RequestEditsSettledAction.create({ requestId: 'settle-2' }));
      await expect(server.nextAction<EditsSettledAction>(EditsSettledAction.KIND)).resolves.toMatchObject({ responseId: 'settle-2' });
   });

   underNodeScope('waits, after giving up on a hung delivery, for an operation queued while it waited', async () => {
      const server = await startServer('file:///a.x');
      // Once settle-1 waits, the held delivery starts an operation, which queues the chain's again behind it.
      queueChain = [ChangeBoundsOperation.create([])];
      queuedAnswers = [{ kind: HELD_KIND }];
      heldDelivery = new Deferred<void>();
      deliveryDispatch = ChangeBoundsOperation.create([]);

      server.dispatch(ChangeBoundsOperation.create([]));
      server.dispatch(RequestEditsSettledAction.create({ requestId: 'settle-1' }));
      await deliveryEntered.promise;
      await tick(5);
      deliveryDispatchGate.resolve();
      await tick(5);
      expect(deliveriesEntered).toBe(2);
      clock.advance(5_000);
      await expect(server.nextAction<EditsSettledAction>(EditsSettledAction.KIND)).resolves.toMatchObject({ responseId: 'settle-1' });

      server.dispatch(RequestEditsSettledAction.create({ requestId: 'settle-2' }));
      await tick(5);
      expect(answers(server).map(answer => answer.responseId)).toEqual(['settle-1']);
      heldDelivery.resolve();
      await expect(server.nextAction<EditsSettledAction>(EditsSettledAction.KIND)).resolves.toMatchObject({ responseId: 'settle-2' });
   });

   it('answers after an operation that failed, which the server answers with an error message only', async () => {
      const server = await startServer('file:///a.x');
      operationFailure = new Error('no such element');
      const before = server.actions.length;

      server.dispatch(ChangeBoundsOperation.create([]));
      server.dispatch(RequestEditsSettledAction.create({ requestId: 'settle-1' }));
      await server.nextAction(EditsSettledAction.KIND);

      expect(server.actions.slice(before).map(action => action.kind)).toEqual([MessageAction.KIND, EditsSettledAction.KIND]);
   });
});
