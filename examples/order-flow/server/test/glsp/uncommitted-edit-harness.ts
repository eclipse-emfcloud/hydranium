/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * Shared setup of the `process-uncommitted-edit-*` suites: each GLSP
 * operation is a transaction, editing copies of the built roots, writing once,
 * and invisible to other readers until that write commits. Every test opens a
 * diagram of its own over a scratch workspace; the module-level `setup` and
 * `scratch` belong to the importing test file, which vitest isolates.
 *
 * The other writer's change is applied to the text store and left unbuilt, as
 * an editor's debounced keystroke is, so the diagram's write conflicts at the
 * door and its reconcile has to wait for that change to build.
 */

import 'reflect-metadata';
import {
   type Action,
   ActionDispatcher,
   ActionDispatchScope,
   ChangeBoundsOperation,
   type Command,
   CommandStack,
   CompoundCommand,
   CreateNodeOperation,
   MessageAction,
   ModelSubmissionHandler,
   type Operation,
   type OperationHandler,
   OperationHandlerRegistry,
   RedoAction,
   type RequestAction,
   type ResponseAction,
   SaveModelAction,
   ServerModule,
   SetDirtyStateAction,
   SourceModelStorage,
   UndoAction
} from '@eclipse-glsp/server';
import { BrowserActionDispatchScope } from '@eclipse-glsp/server/browser.js';
import type { ScratchWorkspace } from '@hydranium/core/testing/node';
import { DataServer } from '@hydranium/data-server';
import { type DataServerHarness, makeDataServerHarness } from '@hydranium/data-server/testing';
import { HydraniumGlspAppModule, type HydraniumGlspSubmissionHandler } from '@hydranium/glsp-server';
import { type GlspHarness, makeGlspHarness } from '@hydranium/glsp-server/testing';
import { URI } from '@hydranium/langium';
import type { TransferElement } from '@hydranium/protocol';
import { waitFor } from '@hydranium/protocol/testing';
import { ContainerModule, type interfaces } from 'inversify';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, type MockInstance, vi } from 'vitest';
import { OrderFlowCommand } from '../../src/glsp/order-flow-command.js';
import type { OrderFlowGlspState } from '../../src/glsp/order-flow-glsp-state.js';
import { OrderFlowProcessDiagramModule } from '../../src/glsp/order-flow-process-diagram-module.js';
import { PROCESS_TASK_NODE_TYPE } from '../../src/glsp/order-flow-process-diagram-types.js';
import type { LayoutModel, ProcessModel } from '../../src/language-server/ast.js';
import { makeScratchWorkspaceHarness, type OrderFlowHarness, WORKSPACE_FILES } from '../order-flow-harness.js';

export type Head = DataServerHarness<DataServer<TransferElement>, TransferElement>;
export type Diagram = GlspHarness<OrderFlowGlspState>;

export interface Setup {
   readonly services: OrderFlowHarness;
   readonly diagram: Diagram;
   readonly head: Head;
   readonly processUri: string;
   readonly layoutUri: string;
}

let setup: Setup | undefined;
let scratch: ScratchWorkspace | undefined;

afterEach(() => {
   setup?.head.dispose();
   setup?.diagram.dispose();
   setup = undefined;
   scratch?.dispose();
   scratch = undefined;
});

/** A request the test answers as the client would; its kind is registered as a client action kind. */
export const ASK_CLIENT = 'askClient';

/** Open `fulfillment.process` in a diagram, with a data head on the same services. */
export async function openDiagram(
   prepare?: (workspace: ScratchWorkspace) => void,
   appModules: readonly interfaces.ContainerModule[] = [],
   awaitLayout = true
): Promise<Setup> {
   const { harness: services, workspace } = await makeScratchWorkspaceHarness(prepare);
   scratch = workspace;
   const sourcePath = workspace.resolve(WORKSPACE_FILES.fulfillmentProcess);
   const diagram = makeGlspHarness<OrderFlowGlspState>({
      serverModule: new ServerModule().configureDiagramModule(new OrderFlowProcessDiagramModule()),
      diagramType: 'order-flow-process',
      appModules: [new HydraniumGlspAppModule({ shared: services.shared }), ...appModules],
      additionalClientActionKinds: [ASK_CLIENT]
   });
   await diagram.start();
   await diagram.openDocument(sourcePath);
   const head: Head = makeDataServerHarness<DataServer<TransferElement>, TransferElement>({
      server: channel => new DataServer<TransferElement>(channel, services.shared)
   });
   setup = { services, diagram, head, processUri: URI.file(sourcePath).toString(), layoutUri: diagram.state.layoutUri };
   // The diagram's session opens the layout as it joins the write set, after the load.
   if (awaitLayout) {
      await waitFor(() => services.shared.workspace.TextDocuments.get(setup!.layoutUri) !== undefined, {
         message: 'the layout never opened'
      });
   }
   return setup;
}

/** Change the text of `uri` (default the `.process`) as another client, without building it. */
export async function changeTextUnbuilt(
   { services, diagram, processUri }: Setup,
   edit: (text: string) => string,
   uri: string = processUri
): Promise<void> {
   const models = services.shared.model.ModelService;
   const editor = models.getSession('text-editor') ?? models.createSession('text-editor', 'text-editor');
   await editor.open(uri);
   const store = services.shared.workspace.TextDocuments;
   const text = store.get(uri)?.getText() ?? '';
   store.applyContentChange(uri, edit(text), 'text-editor');
   // The diagram's base version is superseded, and the built root still predates the change.
   const baseVersion = diagram.state.baseVersionOf(uri);
   expect(store.version(uri)).toBeGreaterThan(baseVersion ?? Number.MAX_SAFE_INTEGER);
   expect(models.snapshot(uri)?.version).toBe(baseVersion);
}

/** Change the text of `uri` as another client, and wait until it is built. */
export async function changeTextBuilt({ services }: Setup, uri: string, edit: (text: string) => string): Promise<void> {
   const models = services.shared.model.ModelService;
   const editor = models.getSession('text-editor') ?? models.createSession('text-editor', 'text-editor');
   await editor.open(uri);
   const text = services.shared.workspace.TextDocuments.get(uri)?.getText() ?? '';
   await editor.update({ uri, model: edit(text), baseVersion: 'any' });
}

/** The built `.process` root other readers share. */
export function builtProcessRoot({ services, processUri }: Setup): ProcessModel {
   return services.shared.model.ModelService.snapshot(processUri)?.root as ProcessModel;
}

/** The built `.layout` root other readers share. */
export function builtLayoutRoot({ services, layoutUri }: Setup): LayoutModel | undefined {
   return services.shared.model.ModelService.getDocument(layoutUri)?.parseResult.value as LayoutModel | undefined;
}

/** The stored text of `uri`. */
export function textOf({ services }: Setup, uri: string): string {
   return services.shared.workspace.TextDocuments.get(uri)?.getText() ?? '';
}

/** Dispatch `action` and wait until the operation has submitted, its write landed or dropped. */
export async function apply(diagram: Diagram, action: Action): Promise<void> {
   const before = diagram.actions.length;
   diagram.dispatch(action);
   await waitFor(
      () => diagram.actions.slice(before).some(candidate => SetDirtyStateAction.is(candidate) && candidate.reason === 'operation'),
      { message: `no 'operation' dirty state after ${action.kind}` }
   );
}

/** Dispatch an undo or redo and wait until it has submitted. */
export async function replay(diagram: Diagram, action: UndoAction | RedoAction): Promise<void> {
   const reason = UndoAction.is(action) ? 'undo' : 'redo';
   const before = diagram.actions.length;
   diagram.dispatch(action);
   await waitFor(() => diagram.actions.slice(before).some(candidate => SetDirtyStateAction.is(candidate) && candidate.reason === reason), {
      message: `no '${reason}' dirty state`
   });
}

/** Dispatch `action`, expected to fail, and wait for the error message the client is sent. */
export async function applyFailing(diagram: Diagram, action: Action): Promise<MessageAction> {
   const before = diagram.actions.length;
   diagram.dispatch(action);
   let message: MessageAction | undefined;
   await waitFor(
      () => {
         message = diagram.actions
            .slice(before)
            .find((candidate): candidate is MessageAction => MessageAction.is(candidate) && candidate.severity === 'ERROR');
         return message !== undefined;
      },
      { message: `no error message after ${action.kind}` }
   );
   return message!;
}

/** Run `read` once the diagram's write has conflicted, before its reconcile refetches. */
export function readBeforeRefetch<T>(diagram: Diagram, read: () => Promise<T>): () => T | undefined {
   const state = diagram.state as unknown as { refetch(): Promise<unknown> };
   const refetch = state.refetch.bind(state);
   let observed: T | undefined;
   vi.spyOn(state, 'refetch').mockImplementationOnce(async () => {
      observed = await read();
      return refetch();
   });
   return () => observed;
}

/** The storage's protected resubmit path, entered the way its debounce timer enters it. */
export interface ResubmitPath {
   flushResubmit(): void;
}

/** Run the storage's resubmit now, as its debounce timer would. */
export function flushResubmit(diagram: Diagram): void {
   const storage = diagram.sessionContainer.get<SourceModelStorage>(SourceModelStorage) as unknown as ResubmitPath;
   storage.flushResubmit();
}

/** The diagram's submission handler, its external resubmits let through. */
export function allowExternalSubmits(diagram: Diagram): HydraniumGlspSubmissionHandler<ProcessModel> {
   // The harness never answers the initial bounds request, which holds every resubmit back.
   const submissions = diagram.sessionContainer.get<HydraniumGlspSubmissionHandler<ProcessModel>>(ModelSubmissionHandler);
   vi.spyOn(submissions, 'hasPendingInitialRequest').mockReturnValue(false);
   return submissions;
}

/** A move of the flow node `name` to `x`, `y`, at the size it is drawn at. */
export function move(diagram: Diagram, name: string, x: number, y: number): ChangeBoundsOperation {
   const node = diagram.state.sourceRoot.nodes.find(candidate => candidate.name === name)!;
   return ChangeBoundsOperation.create([
      { elementId: diagram.state.index.createId(node), newPosition: { x, y }, newSize: { width: 160, height: 60 } }
   ]);
}

export function createTask(): CreateNodeOperation {
   return CreateNodeOperation.create(PROCESS_TASK_NODE_TYPE, { location: { x: 320, y: 480 } });
}

/** Set the layout entry of the flow node `name` to `x`, `y`, in the root a handler edits. */
export function place(diagram: Diagram, name: string, x: number, y: number): void {
   const entry = diagram.state.layoutRoot.nodes.find(node => node.flowNode.$refText === name) as { x: number; y: number } | undefined;
   if (entry) {
      entry.x = x;
      entry.y = y;
   }
}

export function handlerOf(diagram: Diagram, operation: Operation): OperationHandler {
   return diagram.sessionContainer.get<OperationHandlerRegistry>(OperationHandlerRegistry).getOperationHandler(operation)!;
}

export function dispatcherOf(diagram: Diagram): ActionDispatcher {
   return diagram.sessionContainer.get<ActionDispatcher>(ActionDispatcher);
}

export function commandStackOf(diagram: Diagram): CommandStack {
   return diagram.sessionContainer.get<CommandStack>(CommandStack);
}

/** A pass-through spy on the state's protected write. */
export function spyOnPersist(diagram: Diagram): MockInstance<(...args: unknown[]) => Promise<unknown>> {
   const state = diagram.state as unknown as { persist(...args: unknown[]): Promise<unknown> };
   return vi.spyOn(state, 'persist');
}

/** A pass-through spy on the state's protected refetch, which only a conflicting write reaches. */
export function spyOnRefetch(diagram: Diagram): MockInstance<() => Promise<unknown>> {
   const state = diagram.state as unknown as { refetch(): Promise<unknown> };
   return vi.spyOn(state, 'refetch');
}

export interface Gate {
   readonly promise: Promise<void>;
   open(): void;
}

export function gate(): Gate {
   let open: () => void = () => undefined;
   const promise = new Promise<void>(resolve => {
      open = resolve;
   });
   return { promise, open };
}

/**
 * Run `body` inside an operation the diagram executes, as a handler's
 * `createCommand` would, and resolve with its result once the operation has
 * ended. The operation creates no command.
 */
export async function insideOperation<T>(diagram: Diagram, body: () => T): Promise<T> {
   const create = createTask();
   let result: { value: T } | undefined;
   vi.spyOn(handlerOf(diagram, create), 'createCommand').mockImplementationOnce(() => {
      result = { value: body() };
      return undefined;
   });
   diagram.dispatch(create);
   await waitFor(() => result !== undefined, { message: 'the operation never ran' });
   await diagram.state.runExclusive(() => undefined);
   return result!.value;
}

/** A recording command that executes another inside its runnable, each with a bridge counting into `sideEffects`. */
export function nestedCommand(diagram: Diagram, sideEffects: { outer: number; inner: number }): OrderFlowCommand {
   return new OrderFlowCommand(
      diagram.state,
      'Outer',
      async () => {
         sideEffects.outer++;
         place(diagram, 'Pay', 50, 110);
         await new OrderFlowCommand(
            diagram.state,
            'Inner',
            () => {
               sideEffects.inner++;
               place(diagram, 'Ship', 700, 220);
            },
            () => void sideEffects.inner--,
            () => void sideEffects.inner++
         ).execute();
      },
      () => void sideEffects.outer--,
      () => void sideEffects.outer++
   );
}

export const browserDispatchScope = new ContainerModule((_bind, _unbind, _isBound, rebind) => {
   rebind(ActionDispatchScope).to(BrowserActionDispatchScope).inSingletonScope();
});

/**
 * Ordering cells: what arrives (a client operation, an undo, a redo, the
 * storage's capture and render, a save) while the diagram is in a state
 * (executing, committing, rolling back, replaying an undo, rendering).
 */
export function describeOrdering(scope: 'Node' | 'browser', part: 'operation-arrivals' | 'undo-arrivals' | 'redo-arrivals' | 'rest'): void {
   const modules: interfaces.ContainerModule[] = scope === 'browser' ? [browserDispatchScope] : [];
   describe(`ordering on the ${scope} dispatch scope`, () => {
      /**
       * What happened, in order: `<reason>:end` per submission, `<reason>:render`
       * per external render, and what each cell pushes.
       */
      let events: string[];

      async function open(): Promise<Setup> {
         const opened = await openDiagram(undefined, modules);
         events = [];
         const submissions = allowExternalSubmits(opened.diagram);
         const submitModel = submissions.submitModel.bind(submissions);
         vi.spyOn(submissions, 'submitModel').mockImplementation(async (reason, layout) => {
            if (reason === 'external') {
               events.push('render');
               await beforeRender?.();
            }
            const actions = await submitModel(reason, layout);
            events.push(`${reason ?? 'initial'}:end`);
            return actions;
         });
         const stack = commandStackOf(opened.diagram);
         const undo = stack.undo.bind(stack);
         vi.spyOn(stack, 'undo').mockImplementation(async () => {
            events.push('undo');
            return undo();
         });
         const canRedo = stack.canRedo.bind(stack);
         vi.spyOn(stack, 'canRedo').mockImplementation(() => {
            events.push('redo');
            return canRedo();
         });
         const moveHandler = handlerOf(opened.diagram, move(opened.diagram, 'Pay', 0, 0));
         const execute = moveHandler.execute.bind(moveHandler);
         vi.spyOn(moveHandler, 'execute').mockImplementation(operation => {
            events.push('move');
            return execute(operation);
         });
         beforeRender = undefined;
         return opened;
      }

      let beforeRender: (() => Promise<void>) | undefined;

      interface Held {
         /** The event that ends the held section. */
         readonly end: string;
         release(): void;
      }

      /** Hold an operation that creates a task inside its `createCommand`. */
      async function holdExecuting({ diagram }: Setup): Promise<Held> {
         const create = createTask();
         const handler = handlerOf(diagram, create);
         const createCommand = handler.createCommand.bind(handler);
         const entered = gate();
         const release = gate();
         vi.spyOn(handler, 'createCommand').mockImplementationOnce(async (operation: Operation) => {
            entered.open();
            await release.promise;
            return createCommand(operation);
         });
         diagram.dispatch(create);
         await entered.promise;
         return { end: 'operation:end', release: release.open };
      }

      /** Hold an operation that creates a task while its write is in flight. */
      async function holdCommitting({ diagram }: Setup): Promise<Held> {
         const state = diagram.state as unknown as { persist(...args: unknown[]): Promise<unknown> };
         const persist = state.persist.bind(state);
         const entered = gate();
         const release = gate();
         vi.spyOn(state, 'persist').mockImplementationOnce(async (...args: unknown[]) => {
            entered.open();
            await release.promise;
            return persist(...args);
         });
         diagram.dispatch(createTask());
         await entered.promise;
         return { end: 'operation:end', release: release.open };
      }

      /** Hold an operation whose write failed while it reverts a command's side effect. */
      async function holdRollingBack({ diagram }: Setup): Promise<Held> {
         const create = createTask();
         const entered = gate();
         const release = gate();
         const sideEffect: Command = {
            execute: () => undefined,
            undo: async () => {
               entered.open();
               await release.promise;
               events.push('rollback:end');
            },
            redo: () => undefined
         };
         vi.spyOn(handlerOf(diagram, create), 'createCommand').mockImplementationOnce(
            () => new CompoundCommand([sideEffect, new OrderFlowCommand(diagram.state, 'Place', () => place(diagram, 'Pay', 50, 110))])
         );
         vi.spyOn(diagram.state, 'updateSourceModel').mockRejectedValueOnce(new Error('write failed'));
         diagram.dispatch(create);
         await entered.promise;
         return { end: 'rollback:end', release: release.open };
      }

      /** Hold the undo of a move of `Ship` while its write is in flight. */
      async function holdUndoing({ diagram }: Setup): Promise<Held> {
         await apply(diagram, move(diagram, 'Ship', 700, 220));
         events.length = 0;
         const state = diagram.state as unknown as { persist(...args: unknown[]): Promise<unknown> };
         const persist = state.persist.bind(state);
         const entered = gate();
         const release = gate();
         vi.spyOn(state, 'persist').mockImplementationOnce(async (...args: unknown[]) => {
            entered.open();
            await release.promise;
            return persist(...args);
         });
         diagram.dispatch(UndoAction.create());
         await entered.promise;
         return { end: 'undo:end', release: release.open };
      }

      /** Hold the storage's render of an external change. */
      async function holdRendering(opened: Setup): Promise<Held> {
         const entered = gate();
         const release = gate();
         beforeRender = async () => {
            beforeRender = undefined;
            entered.open();
            await release.promise;
         };
         await changeTextBuilt(opened, opened.processUri, text => text.replace('task Pick reads Order.id', 'task Pick reads Order.status'));
         flushResubmit(opened.diagram);
         await entered.promise;
         return { end: 'external:end', release: release.open };
      }

      const holds = [
         ['executing', holdExecuting],
         ['committing', holdCommitting],
         ['rolling back', holdRollingBack],
         ['replaying an undo', holdUndoing],
         ['rendering', holdRendering]
      ] as const;

      /** `first` happened, and `second` did not happen before it. */
      function ordered(first: string, second: string): boolean {
         const firstAt = events.indexOf(first);
         const secondAt = events.indexOf(second);
         return firstAt >= 0 && (secondAt < 0 || secondAt > firstAt);
      }

      /**
       * Send `action` the way `origin` names: as the client sends it, which GLSP
       * queues behind the action it is running on either scope, or through the
       * action dispatcher from outside any handler, as a timer or listener does,
       * which GLSP's browser scope runs at once while a handler awaits.
       */
      function send({ diagram }: Setup, origin: Origin, action: Action): void {
         if (origin === 'client') {
            diagram.dispatch(action);
         } else {
            void dispatcherOf(diagram).dispatch(action);
         }
      }

      const origins = ['client', 'server'] as const;
      type Origin = (typeof origins)[number];
      const holdsByOrigin = holds.flatMap(([held, hold]) => origins.map(origin => [held, origin, hold] as const));

      if (part === 'operation-arrivals') {
         it.each(holdsByOrigin)('runs an operation that arrives while %s, sent from the %s, after it', async (_held, origin, hold) => {
            const opened = await open();
            const { diagram, layoutUri } = opened;
            const movePay = move(diagram, 'Pay', 50, 110);
            const held = await hold(opened);

            send(opened, origin, movePay);
            await new Promise(resolve => setTimeout(resolve, 50));
            held.release();
            await waitFor(() => textOf(opened, layoutUri).includes('node Pay at 50, 110'), { message: 'the move never landed' });

            expect({ order: ordered(held.end, 'move') }).toEqual({ order: true });
         });
      }

      if (part === 'undo-arrivals') {
         it.each(holdsByOrigin.filter(([held]) => held !== 'replaying an undo'))(
            'runs an undo that arrives while %s, sent from the %s, after it, and it undoes the last step',
            async (held, origin, hold) => {
               const opened = await open();
               const { diagram, layoutUri } = opened;
               await apply(diagram, move(diagram, 'Pay', 50, 110));
               const holding = await hold(opened);

               send(opened, origin, UndoAction.create());
               await new Promise(resolve => setTimeout(resolve, 50));
               holding.release();
               await waitFor(() => events.includes('undo:end'), { message: 'the undo never submitted' });

               const pushed = held === 'executing' || held === 'committing';
               expect({
                  order: ordered(holding.end, 'undo'),
                  // An operation that pushed a step is what the undo reverts; otherwise the move is.
                  payMoved: textOf(opened, layoutUri).includes('node Pay at 50, 110'),
                  canUndo: commandStackOf(diagram).canUndo()
               }).toEqual({ order: true, payMoved: pushed, canUndo: pushed });
            }
         );
      }

      if (part === 'undo-arrivals') {
         it.each(origins)(
            'runs an undo that arrives while an undo replays, sent from the %s, after it, undoing the step before',
            async origin => {
               const opened = await open();
               const { diagram, layoutUri } = opened;
               await apply(diagram, move(diagram, 'Pay', 50, 110));
               const held = await holdUndoing(opened);

               send(opened, origin, UndoAction.create());
               await new Promise(resolve => setTimeout(resolve, 50));
               held.release();
               await waitFor(() => events.filter(event => event === 'undo:end').length === 2, { message: 'both undos did not submit' });

               expect({
                  order: events.filter(event => event === 'undo' || event === 'undo:end'),
                  pay: textOf(opened, layoutUri).includes('node Pay at 40, 100'),
                  ship: textOf(opened, layoutUri).includes('node Ship at 660, 200')
               }).toEqual({ order: ['undo', 'undo:end', 'undo', 'undo:end'], pay: true, ship: true });
            }
         );
      }

      if (part === 'redo-arrivals') {
         it.each(origins)(
            'runs a redo that arrives while an operation executes, sent from the %s, after it, when the operation has cleared the redo list',
            async origin => {
               const opened = await open();
               const { diagram, layoutUri } = opened;
               await apply(diagram, move(diagram, 'Pay', 50, 110));
               await replay(diagram, UndoAction.create());
               events.length = 0;
               const held = await holdExecuting(opened);

               send(opened, origin, RedoAction.create());
               await new Promise(resolve => setTimeout(resolve, 50));
               held.release();
               await waitFor(() => events.includes('redo') && events.includes('operation:end'), { message: 'the redo never ran' });

               expect({ order: ordered(held.end, 'redo'), payRedone: textOf(opened, layoutUri).includes('node Pay at 50, 110') }).toEqual({
                  order: true,
                  payRedone: false
               });
            }
         );
      }

      if (part === 'rest') {
         it.each(holds.filter(([held]) => held !== 'rendering'))(
            'renders an external change that arrives while %s after it',
            async (_held, hold) => {
               const opened = await open();
               const { diagram } = opened;
               const held = await hold(opened);

               await changeTextBuilt(opened, opened.processUri, text =>
                  text.replace('task Pick reads Order.id', 'task Pick reads Order.status')
               );
               flushResubmit(diagram);
               await new Promise(resolve => setTimeout(resolve, 50));
               held.release();
               await waitFor(() => events.includes('render'), { message: 'the render never ran' });

               expect(ordered(held.end, 'render')).toBe(true);
            }
         );
      }

      if (part === 'redo-arrivals') {
         it.each(holdsByOrigin.filter(([held]) => held !== 'executing'))(
            'runs a redo that arrives while %s, sent from the %s, after it',
            async (held, origin, hold) => {
               const opened = await open();
               const { diagram, layoutUri } = opened;
               await apply(diagram, move(diagram, 'Pay', 50, 110));
               await replay(diagram, UndoAction.create());
               events.length = 0;
               const holding = await hold(opened);

               send(opened, origin, RedoAction.create());
               await new Promise(resolve => setTimeout(resolve, 50));
               holding.release();
               await waitFor(() => events.includes(holding.end) && events.includes('redo'), { message: 'the redo never ran' });
               await new Promise(resolve => setTimeout(resolve, 100));

               // An operation that pushed a step, or the move of Ship the undo hold pushes, cleared the redo of Pay.
               const redone = held === 'rolling back' || held === 'rendering';
               expect({
                  order: ordered(holding.end, 'redo'),
                  payRedone: textOf(opened, layoutUri).includes('node Pay at 50, 110')
               }).toEqual({
                  order: true,
                  payRedone: redone
               });
            }
         );
      }

      if (part === 'rest') {
         it.each(holds.filter(([held]) => held !== 'rendering'))(
            'saves while %s without waiting for it, and saves only committed text',
            async (_held, hold) => {
               const opened = await open();
               const { diagram, processUri, layoutUri } = opened;
               const storage = diagram.sessionContainer.get<SourceModelStorage>(SourceModelStorage);
               const held = await hold(opened);
               const stored = { process: textOf(opened, processUri), layout: textOf(opened, layoutUri) };

               const saved = await Promise.race([
                  Promise.resolve(storage.saveSourceModel(SaveModelAction.create())).then(() => 'saved'),
                  new Promise<string>(resolve => setTimeout(() => resolve('blocked'), 1000))
               ]);
               const onDisk = {
                  process: readFileSync(URI.parse(processUri).fsPath, 'utf8'),
                  layout: readFileSync(URI.parse(layoutUri).fsPath, 'utf8')
               };
               held.release();

               expect({ saved, onDisk, newTask: onDisk.process.includes('NewTask') }).toEqual({
                  saved: 'saved',
                  onDisk: stored,
                  newTask: false
               });
            }
         );
      }

      if (part === 'rest') {
         it.each([
            ['rolls back', 'rollback:end'],
            ['replays an undo', 'undo:end']
         ])('queues an operation a side effect dispatches and awaits while the diagram %s, after it', async (phase, end) => {
            const opened = await open();
            const { diagram, layoutUri } = opened;
            const create = createTask();
            const sideEffect: Command = {
               execute: () => undefined,
               undo: async () => {
                  await dispatcherOf(diagram).dispatch(move(diagram, 'Pay', 50, 110));
                  events.push('dispatched');
                  if (phase === 'rolls back') {
                     events.push('rollback:end');
                  }
               },
               redo: () => undefined
            };
            vi.spyOn(handlerOf(diagram, create), 'createCommand').mockImplementationOnce(
               () => new CompoundCommand([sideEffect, new OrderFlowCommand(diagram.state, 'Place', () => place(diagram, 'Ship', 700, 220))])
            );
            if (phase === 'rolls back') {
               vi.spyOn(diagram.state, 'updateSourceModel').mockRejectedValueOnce(new Error('write failed'));
               diagram.dispatch(create);
            } else {
               await apply(diagram, create);
               diagram.dispatch(UndoAction.create());
            }

            await waitFor(() => textOf(opened, layoutUri).includes('node Pay at 50, 110'), { message: 'the dispatched move never landed' });

            expect({ dispatchedFirst: ordered('dispatched', 'move'), after: ordered(end, 'move') }).toEqual({
               dispatchedFirst: true,
               after: true
            });
         });
      }

      if (part === 'rest') {
         it('delivers the client response to a request a bridge awaits during an undo', async () => {
            const opened = await open();
            const { diagram, layoutUri } = opened;
            const create = createTask();
            let answered: ResponseAction | undefined;
            vi.spyOn(handlerOf(diagram, create), 'createCommand').mockImplementationOnce(
               () =>
                  new OrderFlowCommand(
                     diagram.state,
                     'Ask on undo',
                     () => place(diagram, 'Ship', 700, 220),
                     async () => {
                        const ask: RequestAction<ResponseAction> = { kind: ASK_CLIENT, requestId: '' };
                        answered = await dispatcherOf(diagram).request(ask);
                     }
                  )
            );
            await apply(diagram, create);

            diagram.dispatch(UndoAction.create());
            const ask = await diagram.nextAction<RequestAction<ResponseAction>>(ASK_CLIENT);
            diagram.dispatch({ kind: 'answer', responseId: ask.requestId } as ResponseAction);
            await waitFor(() => events.includes('undo:end'), { message: 'the undo never finished' });

            expect({ answered: answered?.kind, ship: textOf(opened, layoutUri).includes('node Ship at 660, 200') }).toEqual({
               answered: 'answer',
               ship: true
            });
         });
      }

      if (part === 'rest') {
         it('saves while the storage renders without waiting for it', async () => {
            const opened = await open();
            const { diagram } = opened;
            const storage = diagram.sessionContainer.get<SourceModelStorage>(SourceModelStorage);
            const save = storage.saveSourceModel.bind(storage);
            vi.spyOn(storage, 'saveSourceModel').mockImplementation(async action => {
               await save(action);
               events.push('saved');
            });
            const held = await holdRendering(opened);

            diagram.dispatch(SaveModelAction.create());
            await waitFor(() => events.includes('saved'), { message: 'the save waited' });
            held.release();
            await waitFor(() => events.includes(held.end), { message: 'the render never finished' });

            expect(ordered('saved', held.end)).toBe(true);
         });
      }

      if (part === 'rest') {
         it.each([
            ['awaited', true],
            ['not awaited', false]
         ])(
            'runs an operation a handler dispatches, %s, after the dispatching one, as its own write and undo step',
            async (_mode, awaited) => {
               const opened = await open();
               const { diagram, processUri, layoutUri } = opened;
               const create = createTask();
               const handler = handlerOf(diagram, create);
               const createCommand = handler.createCommand.bind(handler);
               const movePay = move(diagram, 'Pay', 50, 110);
               vi.spyOn(handler, 'createCommand').mockImplementationOnce(async (operation: Operation) => {
                  const dispatched = dispatcherOf(diagram).dispatch(movePay);
                  if (awaited) {
                     await dispatched;
                  }
                  events.push('dispatched');
                  return createCommand(operation);
               });
               const persist = spyOnPersist(diagram);

               await apply(diagram, create);
               await waitFor(() => textOf(opened, layoutUri).includes('node Pay at 50, 110'), {
                  message: 'the dispatched move never landed'
               });
               const done = {
                  writes: persist.mock.calls.length,
                  order: events.filter(event => ['dispatched', 'operation:end', 'move'].includes(event)).slice(0, 3)
               };
               await replay(diagram, UndoAction.create());

               expect({
                  done,
                  undone: {
                     task: textOf(opened, processUri).includes('task NewTask'),
                     pay: textOf(opened, layoutUri).includes('node Pay at 40, 100')
                  }
               }).toEqual({ done: { writes: 2, order: ['dispatched', 'operation:end', 'move'] }, undone: { task: true, pay: true } });
            }
         );
      }

      if (part === 'rest') {
         it('runs an operation dispatched during the write after it, as its own', async () => {
            const opened = await open();
            const { diagram, processUri, layoutUri } = opened;
            const movePay = move(diagram, 'Pay', 50, 110);
            const state = diagram.state as unknown as { persist(...args: unknown[]): Promise<unknown> };
            const persist = state.persist.bind(state);
            vi.spyOn(state, 'persist').mockImplementationOnce((...args: unknown[]) => {
               void dispatcherOf(diagram).dispatch(movePay);
               return persist(...args);
            });

            diagram.dispatch(createTask());
            await waitFor(() => events.filter(event => event === 'operation:end').length === 2, {
               message: 'both operations did not submit'
            });

            expect({
               order: ordered('operation:end', 'move'),
               task: textOf(opened, processUri).includes('task NewTask'),
               pay: textOf(opened, layoutUri).includes('node Pay at 50, 110')
            }).toEqual({ order: true, task: true, pay: true });
         });
      }

      if (part === 'rest') {
         it('reports a failed operation a handler dispatched to the client as GLSP reports a failed action', async () => {
            const opened = await open();
            const { diagram, processUri } = opened;
            const create = createTask();
            const handler = handlerOf(diagram, create);
            const createCommand = handler.createCommand.bind(handler);
            const movePay = move(diagram, 'Pay', 50, 110);
            vi.spyOn(handler, 'createCommand').mockImplementationOnce((operation: Operation) => {
               void dispatcherOf(diagram).dispatch(movePay);
               return createCommand(operation);
            });
            vi.spyOn(handlerOf(diagram, movePay), 'createCommand').mockImplementationOnce(() => {
               throw new Error('dispatched operation failed');
            });
            const unhandled: unknown[] = [];
            const onUnhandled = (reason: unknown): void => void unhandled.push(reason);
            process.on('unhandledRejection', onUnhandled);
            const before = diagram.actions.length;

            try {
               await apply(diagram, create);
               await waitFor(() => diagram.actions.slice(before).some(action => MessageAction.is(action) && action.severity === 'ERROR'), {
                  message: 'the client was not told'
               });
               await new Promise(resolve => setTimeout(resolve, 20));
            } finally {
               process.off('unhandledRejection', onUnhandled);
            }

            const message = diagram.actions
               .slice(before)
               .find((action): action is MessageAction => MessageAction.is(action) && action.severity === 'ERROR');
            expect({
               details: message?.details?.includes('dispatched operation failed'),
               task: textOf(opened, processUri).includes('task NewTask'),
               unhandled
            }).toEqual({
               details: true,
               task: true,
               unhandled: []
            });
         });
      }

      if (part === 'rest') {
         it('delivers the client response to a request a handler awaits', async () => {
            const opened = await open();
            const { diagram, processUri } = opened;
            const create = createTask();
            const handler = handlerOf(diagram, create);
            const createCommand = handler.createCommand.bind(handler);
            let answered: ResponseAction | undefined;
            vi.spyOn(handler, 'createCommand').mockImplementationOnce(async (operation: Operation) => {
               const ask: RequestAction<ResponseAction> = { kind: ASK_CLIENT, requestId: '' };
               answered = await dispatcherOf(diagram).request(ask);
               return createCommand(operation);
            });

            diagram.dispatch(create);
            const ask = await diagram.nextAction<RequestAction<ResponseAction>>(ASK_CLIENT);
            diagram.dispatch({ kind: 'answer', responseId: ask.requestId } as ResponseAction);
            await waitFor(() => textOf(opened, processUri).includes('task NewTask'), { message: 'the operation never finished' });

            expect(answered?.kind).toBe('answer');
         });
      }
   });
}
