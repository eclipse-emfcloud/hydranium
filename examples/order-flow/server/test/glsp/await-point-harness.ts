/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * Await-point fault injection for diagram operations and their undo and redo.
 *
 * A gesture runs once to enumerate the points it awaits at: the operation's
 * own checkpoints (creating the command, each side effect, projecting the
 * copies, resolving a replay, each replayed side effect), the state's write
 * (`persist`) and the model submit. It then runs again once per point and
 * variant, landing an unrelated foreign edit, a same-field foreign edit or a
 * failure at that point, and checks the invariants every outcome must keep.
 * Points only a failure reaches, such as a rollback's steps or a conflicting
 * write's refetch, are not enumerated.
 */

import 'reflect-metadata';
import {
   type Action,
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
   ServerModule,
   SetDirtyStateAction,
   UndoAction
} from '@eclipse-glsp/server';
import type { ScratchWorkspace } from '@hydranium/core/testing/node';
import { HydraniumGlspAppModule, HydraniumGlspOperationCommand, type HydraniumGlspSubmissionHandler } from '@hydranium/glsp-server';
import { type GlspHarness, makeGlspHarness } from '@hydranium/glsp-server/testing';
import { type AstNode, URI } from '@hydranium/langium';
import { waitFor } from '@hydranium/protocol/testing';
import { describe, expect, it, vi } from 'vitest';
import { OrderFlowCommand } from '../../src/glsp/order-flow-command.js';
import { type OrderFlowGlspState } from '../../src/glsp/order-flow-glsp-state.js';
import { OrderFlowProcessDiagramModule } from '../../src/glsp/order-flow-process-diagram-module.js';
import { PROCESS_TASK_NODE_TYPE } from '../../src/glsp/order-flow-process-diagram-types.js';
import { makeScratchWorkspaceHarness, type OrderFlowHarness, WORKSPACE_FILES } from '../order-flow-harness.js';

type Diagram = GlspHarness<OrderFlowGlspState>;

export interface Opened {
   readonly services: OrderFlowHarness;
   readonly diagram: Diagram;
   readonly workspace: ScratchWorkspace;
   readonly processUri: string;
   readonly layoutUri: string;
}

export type Phase = 'do' | 'undo' | 'redo';
/**
 * What lands at a point: an unrelated or a same-field foreign edit, a
 * failure, an unrelated foreign edit whose conflict then reads no current
 * text, or, with the phase's write failing, a failure of one cleanup step (a
 * rollback's or a compensation's).
 */
export type Variant = 'unrelated' | 'same-field' | 'throw' | 'unavailable' | 'cleanup-throw';

/** The message the failing write of a `cleanup-throw` run carries. */
const WRITE_FAILURE = 'injected write failure';

/** A side-effect counter a gesture's commands move. */
export interface Counter {
   count: number;
}

export interface Gesture {
   readonly name: string;
   /** How many side effects the gesture's commands apply; each moves the counter by one. */
   readonly sideEffects: number;
   /** Whether the gesture's own edit is in the text: the marker it writes. */
   applied(texts: Texts): boolean;
   /** Change, as another client, the field the gesture writes; and whether that change is in the text. */
   readonly sameField: { readonly uri: 'process' | 'layout'; edit(text: string): string; kept(texts: Texts): boolean };
   /** Prepare the diagram and answer the action that performs the gesture. */
   prepare(opened: Opened, counter: Counter): Action;
}

export interface Texts {
   readonly process: string;
   readonly layout: string;
}

/** The result of one run, and every invariant it broke. */
export interface RunResult {
   readonly points: string[];
   readonly violations: string[];
   readonly count: number;
}

const UNRELATED = {
   edit: (text: string): string => text.replace('node PaymentOk at 260, 90', 'node PaymentOk at 270, 95'),
   kept: (texts: Texts): boolean => texts.layout.includes('node PaymentOk at 270, 95')
};

function handlerOf(diagram: Diagram, operation: Operation): OperationHandler {
   return diagram.sessionContainer.get<OperationHandlerRegistry>(OperationHandlerRegistry).getOperationHandler(operation)!;
}

function movePay(diagram: Diagram): ChangeBoundsOperation {
   const node = diagram.state.sourceRoot.nodes.find(candidate => candidate.name === 'Pay')!;
   return ChangeBoundsOperation.create([
      { elementId: diagram.state.index.createId(node), newPosition: { x: 50, y: 110 }, newSize: { width: 160, height: 60 } }
   ]);
}

function place(diagram: Diagram, name: string, x: number, y: number): void {
   const entry = diagram.state.layoutRoot.nodes.find(node => node.flowNode.$refText === name) as { x: number; y: number } | undefined;
   if (entry) {
      entry.x = x;
      entry.y = y;
   }
}

const PAY_MOVED = (texts: Texts): boolean => texts.layout.includes('node Pay at 50, 110');
const PAY_SAME_FIELD = {
   uri: 'layout' as const,
   edit: (text: string): string => text.replace(/node Pay at \d+, \d+/, 'node Pay at 55, 115'),
   kept: (texts: Texts): boolean => texts.layout.includes('node Pay at 55, 115')
};

/** The gestures the matrix runs. */
export const GESTURES: readonly Gesture[] = [
   {
      name: 'move',
      sideEffects: 0,
      applied: PAY_MOVED,
      sameField: PAY_SAME_FIELD,
      prepare: ({ diagram }) => movePay(diagram)
   },
   {
      name: 'create node',
      sideEffects: 0,
      applied: texts => texts.process.includes('task NewTask'),
      sameField: {
         uri: 'process',
         edit: text => text.replace('process Fulfillment for Order {', 'process Fulfillment for Order {\n   task NewTask reads Order.id'),
         // Re-serialized after a write, the effect moves to a line of its own.
         kept: texts => /task NewTask\s+reads Order\.id/.test(texts.process)
      },
      prepare: () => CreateNodeOperation.create(PROCESS_TASK_NODE_TYPE, { location: { x: 320, y: 480 } })
   },
   {
      name: 'compound with a plain and a bridged recording child',
      sideEffects: 2,
      applied: PAY_MOVED,
      sameField: PAY_SAME_FIELD,
      prepare: ({ diagram }, counter) => {
         const create = CreateNodeOperation.create(PROCESS_TASK_NODE_TYPE, { location: { x: 320, y: 480 } });
         const plain: Command = { execute: () => void counter.count++, undo: () => void counter.count--, redo: () => void counter.count++ };
         vi.spyOn(handlerOf(diagram, create), 'createCommand').mockImplementationOnce(
            () =>
               new CompoundCommand([
                  plain,
                  new OrderFlowCommand(
                     diagram.state,
                     'Bridged',
                     () => {
                        counter.count++;
                        place(diagram, 'Pay', 50, 110);
                     },
                     () => void counter.count--,
                     () => void counter.count++
                  )
               ])
         );
         return create;
      }
   },
   {
      name: 'nested recording command',
      sideEffects: 2,
      applied: PAY_MOVED,
      sameField: PAY_SAME_FIELD,
      prepare: ({ diagram }, counter) => {
         const create = CreateNodeOperation.create(PROCESS_TASK_NODE_TYPE, { location: { x: 320, y: 480 } });
         vi.spyOn(handlerOf(diagram, create), 'createCommand').mockImplementationOnce(
            () =>
               new OrderFlowCommand(
                  diagram.state,
                  'Outer',
                  async () => {
                     counter.count++;
                     place(diagram, 'Pay', 50, 110);
                     await new OrderFlowCommand(
                        diagram.state,
                        'Inner',
                        () => {
                           counter.count++;
                           place(diagram, 'Ship', 700, 220);
                        },
                        () => void counter.count--,
                        () => void counter.count++
                     ).execute();
                  },
                  () => void counter.count--,
                  () => void counter.count++
               )
         );
         return create;
      }
   },
   {
      name: 'document tracked mid-operation',
      sideEffects: 0,
      applied: PAY_MOVED,
      sameField: PAY_SAME_FIELD,
      prepare: ({ diagram, layoutUri }) => {
         diagram.state.untrackSecondaryDocuments();
         const move = movePay(diagram);
         const handler = handlerOf(diagram, move);
         const createCommand = handler.createCommand.bind(handler);
         vi.spyOn(handler, 'createCommand').mockImplementationOnce((operation: Operation) => {
            diagram.state.trackSecondaryDocument(layoutUri);
            return createCommand(operation);
         });
         return move;
      }
   }
];

async function open(): Promise<Opened> {
   const { harness: services, workspace } = await makeScratchWorkspaceHarness();
   const sourcePath = workspace.resolve(WORKSPACE_FILES.fulfillmentProcess);
   const diagram = makeGlspHarness<OrderFlowGlspState>({
      serverModule: new ServerModule().configureDiagramModule(new OrderFlowProcessDiagramModule()),
      diagramType: 'order-flow-process',
      appModules: [new HydraniumGlspAppModule({ shared: services.shared })]
   });
   await diagram.start();
   await diagram.openDocument(sourcePath);
   const layoutUri = diagram.state.layoutUri;
   await waitFor(() => services.shared.workspace.TextDocuments.get(layoutUri) !== undefined, { message: 'the layout never opened' });
   return { services, diagram, workspace, processUri: URI.file(sourcePath).toString(), layoutUri };
}

function textsOf({ services, processUri, layoutUri }: Opened): Texts {
   const store = services.shared.workspace.TextDocuments;
   return { process: store.get(processUri)?.getText() ?? '', layout: store.get(layoutUri)?.getText() ?? '' };
}

/** Change `uri` as another client and wait until it is built; throws when `edit` changes nothing, a harness defect. */
async function changeTextBuilt({ services }: Opened, uri: string, edit: (text: string) => string): Promise<void> {
   const models = services.shared.model.ModelService;
   const editor = models.getSession('text-editor') ?? models.createSession('text-editor', 'text-editor');
   await editor.open(uri);
   const text = services.shared.workspace.TextDocuments.get(uri)?.getText() ?? '';
   const edited = edit(text);
   if (edited === text) {
      throw new Error(`harness: the foreign edit of ${uri} matched nothing in:\n${text}`);
   }
   await editor.update({ uri, model: edited, baseVersion: 'any' });
}

/** Dispatch `action` and wait until it has submitted or failed. */
async function perform(diagram: Diagram, action: Action, reason: string): Promise<void> {
   const before = diagram.actions.length;
   diagram.dispatch(action);
   await waitFor(
      () =>
         diagram.actions
            .slice(before)
            .some(
               sent => (SetDirtyStateAction.is(sent) && sent.reason === reason) || (MessageAction.is(sent) && sent.severity === 'ERROR')
            ),
      { timeoutMs: 3000 }
   ).catch(() => undefined);
}

interface BuiltSnapshot {
   readonly root: AstNode | undefined;
   readonly projection: string;
}

function builtSnapshot({ services }: Opened, uri: string): BuiltSnapshot {
   const root = services.shared.model.ModelService.getDocument(uri)?.parseResult.value;
   return { root, projection: root ? JSON.stringify(services.shared.model.TransferEncoder.toTransfer(root, 'grammar')) : '' };
}

/**
 * Run `gesture`'s `phase` once, landing `variant` at `target` (a point as the
 * enumeration names it, `<point>#<occurrence>`), or at nowhere to enumerate.
 * With `failWrite`, the phase's write throws, which a `cleanup-throw` target
 * implies.
 */
export async function runOnce(
   gesture: Gesture,
   phase: Phase,
   target?: { point: string; variant: Variant },
   failWrite = target?.variant === 'cleanup-throw'
): Promise<RunResult> {
   const opened = await open();
   const { diagram } = opened;
   const counter: Counter = { count: 0 };
   const unhandled: unknown[] = [];
   const onUnhandled = (reason: unknown): void => void unhandled.push(reason);
   process.on('unhandledRejection', onUnhandled);
   const restore: Array<{ mockRestore(): void }> = [];
   try {
      const action = gesture.prepare(opened, counter);
      if (phase !== 'do') {
         await perform(diagram, action, 'operation');
         if (phase === 'redo') {
            await perform(diagram, UndoAction.create(), 'undo');
         }
      }
      const points: string[] = [];
      const seen = new Map<string, number>();
      let landedForeign = false;
      const hit = async (name: string): Promise<void> => {
         const occurrence = (seen.get(name) ?? 0) + 1;
         seen.set(name, occurrence);
         const point = `${name}#${occurrence}`;
         points.push(point);
         if (target?.point !== point) {
            return;
         }
         if (target.variant === 'throw' || target.variant === 'cleanup-throw') {
            throw new Error(`injected at ${point}`);
         }
         landedForeign = true;
         if (target.variant === 'unrelated' || target.variant === 'unavailable') {
            await changeTextBuilt(opened, opened.layoutUri, UNRELATED.edit);
         } else {
            await changeTextBuilt(
               opened,
               gesture.sameField.uri === 'layout' ? opened.layoutUri : opened.processUri,
               gesture.sameField.edit
            );
         }
      };
      const prototype = HydraniumGlspOperationCommand.prototype as unknown as { checkpoint(point: string): Promise<void> };
      restore.push(vi.spyOn(prototype, 'checkpoint').mockImplementation(point => hit(point)));
      const state = diagram.state as unknown as { persist(...args: unknown[]): Promise<unknown> };
      const persist = state.persist.bind(state);
      restore.push(
         vi.spyOn(state, 'persist').mockImplementation(async (...args: unknown[]) => {
            await hit('persist');
            if (failWrite) {
               throw new Error(WRITE_FAILURE);
            }
            return persist(...args);
         })
      );
      let refetchedNothing = false;
      const refetching = diagram.state as unknown as { refetch(): Promise<unknown> };
      const refetch = refetching.refetch.bind(refetching);
      restore.push(
         vi.spyOn(refetching, 'refetch').mockImplementation(async () => {
            if (landedForeign && target?.variant === 'unavailable') {
               refetchedNothing = true;
               return undefined;
            }
            return refetch();
         })
      );
      const submissions = diagram.sessionContainer.get<HydraniumGlspSubmissionHandler<AstNode>>(ModelSubmissionHandler);
      const submitModel = submissions.submitModel.bind(submissions);
      restore.push(
         vi.spyOn(submissions, 'submitModel').mockImplementation(async (reason, layout) => {
            if (reason === 'operation' || reason === 'undo' || reason === 'redo') {
               await hit('submit');
            }
            return submitModel(reason, layout);
         })
      );
      const builtBefore = { process: builtSnapshot(opened, opened.processUri), layout: builtSnapshot(opened, opened.layoutUri) };
      const startTexts = textsOf(opened);
      const before = diagram.actions.length;

      const phaseAction = phase === 'do' ? action : phase === 'undo' ? UndoAction.create() : RedoAction.create();
      await perform(diagram, phaseAction, phase === 'do' ? 'operation' : phase);
      const released = await Promise.race([
         diagram.state.runExclusive(() => true),
         new Promise<boolean>(resolve => setTimeout(() => resolve(false), 2000))
      ]);
      restore.splice(0).forEach(spy => spy.mockRestore());

      const violations: string[] = [];
      const texts = textsOf(opened);
      const stack = diagram.sessionContainer.get<CommandStack>(CommandStack);
      if (!released) {
         violations.push('the boundary was not released');
      }
      if (landedForeign) {
         const kept = target?.variant === 'same-field' ? gesture.sameField.kept(texts) : UNRELATED.kept(texts);
         if (!kept) {
            violations.push('the foreign edit was lost');
         }
      }
      if (failWrite) {
         const failed = { texts: startTexts, reported: WRITE_FAILURE, tolerance: 1 };
         violations.push(...failedCleanly(gesture, phase, texts, failed, stack, counter.count, diagram.actions.slice(before)));
      } else if (refetchedNothing) {
         const failed = { texts: { ...startTexts, layout: UNRELATED.edit(startTexts.layout) }, reported: 'was not applied', tolerance: 0 };
         violations.push(...failedCleanly(gesture, phase, texts, failed, stack, counter.count, diagram.actions.slice(before)));
      } else {
         violations.push(...consistency(gesture, phase, target?.variant, texts, stack, counter.count));
      }
      for (const [name, before] of Object.entries(builtBefore)) {
         const after = builtSnapshot(opened, name === 'process' ? opened.processUri : opened.layoutUri);
         if (before.root !== undefined && after.root === before.root && after.projection !== before.projection) {
            violations.push(`the built ${name} root was edited in place`);
         }
      }
      const next = movePay(diagram);
      next.newBounds[0].elementId = diagram.state.index.createId(diagram.state.sourceRoot.nodes.find(node => node.name === 'Cancel')!);
      next.newBounds[0].newPosition = { x: 300, y: 300 };
      await perform(diagram, next, 'operation');
      if (!textsOf(opened).layout.includes('node Cancel at 300, 300')) {
         violations.push('the next operation did not land');
      }
      if (unhandled.length > 0) {
         violations.push(`unhandled rejection: ${unhandled.map(String).join('; ')}`);
      }
      return { points, violations, count: counter.count };
   } finally {
      restore.forEach(spy => spy.mockRestore());
      process.off('unhandledRejection', onUnhandled);
      diagram.dispose();
      opened.workspace.dispose();
   }
}

/**
 * Whether the text, the side-effect counter and the command stack agree on
 * whether the phase landed. A same-field foreign edit can overwrite the
 * gesture's own marker, so the text is not consulted for that variant.
 */
function consistency(
   gesture: Gesture,
   phase: Phase,
   variant: Variant | undefined,
   texts: Texts,
   stack: CommandStack,
   count: number
): string[] {
   const violations: string[] = [];
   const applied = gesture.applied(texts);
   const canUndo = stack.canUndo();
   const canRedo = stack.canRedo();
   const forward = phase !== 'undo';
   const landed = phase === 'do' ? canUndo : forward ? canUndo && !canRedo : canRedo && !canUndo;
   const failed = phase === 'do' ? !canUndo : !canUndo && !canRedo;
   if (!landed && !failed) {
      violations.push(`the ${phase} neither landed nor failed: canUndo=${canUndo} canRedo=${canRedo}`);
      return violations;
   }
   const expectApplied = landed === forward;
   if (variant !== 'same-field' && applied !== expectApplied) {
      violations.push(
         `the stack says the ${phase} ${landed ? 'landed' : 'failed'}, the text says the gesture is ${applied ? '' : 'not '}applied`
      );
   }
   const expectCount = expectApplied ? gesture.sideEffects : 0;
   if (count !== expectCount) {
      violations.push(
         `the stack says the ${phase} ${landed ? 'landed' : 'failed'}, but ${count} of ${gesture.sideEffects} side effects are applied`
      );
   }
   return violations;
}

/**
 * A phase whose write failed: the text is `failed.texts`, the stack holds no
 * entry for it, the failure reported carries `failed.reported`, and every
 * side effect is reverted to where the phase began, but for at most
 * `failed.tolerance` cleanup steps the run fails itself.
 */
function failedCleanly(
   gesture: Gesture,
   phase: Phase,
   texts: Texts,
   failed: { readonly texts: Texts; readonly reported: string; readonly tolerance: number },
   stack: CommandStack,
   count: number,
   sent: readonly Action[]
): string[] {
   const violations: string[] = [];
   if (texts.process !== failed.texts.process || texts.layout !== failed.texts.layout) {
      violations.push('the failed phase wrote');
   }
   if (stack.canUndo() || (phase !== 'do' && stack.canRedo())) {
      violations.push(`the failed ${phase} left the stack canUndo=${stack.canUndo()} canRedo=${stack.canRedo()}`);
   }
   const reported = sent.find((action): action is MessageAction => MessageAction.is(action) && action.severity === 'ERROR');
   if (!reported?.details?.includes(failed.reported)) {
      violations.push(`the reported failure is not the write's: ${reported?.details ?? 'none'}`);
   }
   const expected = phase === 'undo' ? gesture.sideEffects : 0;
   if (Math.abs(count - expected) > failed.tolerance) {
      violations.push(`side effects stayed unreverted: ${count}, expected ${expected}`);
   }
   return violations;
}

const PHASES: readonly Phase[] = ['do', 'undo', 'redo'];
const VARIANTS: readonly Variant[] = ['unrelated', 'same-field', 'throw', 'unavailable'];

/**
 * Register the matrix for the gesture named `name`: each phase with the
 * write failing and every cleanup step failing in turn, and each phase with
 * every variant at every await point. One file per gesture lets the runner
 * run the gestures in parallel; every run opens a workspace of its own.
 */
export function describeAwaitPoints(name: string): void {
   const gesture = GESTURES.find(candidate => candidate.name === name);
   if (!gesture) {
      throw new Error(`harness: no gesture named '${name}'`);
   }
   describe(`await points of a diagram operation: ${name}`, () => {
      it.each(PHASES)(
         '%s: with the write failing, a failure at every cleanup step leaves the other steps reverted',
         async phase => {
            const enumeration = await runOnce(gesture, phase, undefined, true);
            const cleanup = enumeration.points.filter(point => point.startsWith('rollback#') || point.startsWith('compensate#'));
            expect(enumeration.violations).toEqual([]);
            const failures: Record<string, string[]> = {};
            for (const point of cleanup) {
               const { violations } = await runOnce(gesture, phase, { point, variant: 'cleanup-throw' });
               if (violations.length > 0) {
                  failures[point] = violations;
               }
            }

            expect({ cleanup: cleanup.length > 0, failures }).toEqual({ cleanup: true, failures: {} });
         },
         120_000
      );

      it.each(PHASES.flatMap(phase => VARIANTS.map(variant => [phase, variant] as const)))(
         '%s: %s at every await point keeps the invariants',
         async (phase, variant) => {
            const enumeration = await runOnce(gesture, phase);
            expect(enumeration.violations).toEqual([]);
            const failures: Record<string, string[]> = {};
            for (const point of enumeration.points) {
               const { violations } = await runOnce(gesture, phase, { point, variant });
               if (violations.length > 0) {
                  failures[point] = violations;
               }
            }

            expect({ points: enumeration.points.length > 0, failures }).toEqual({ points: true, failures: {} });
         },
         120_000
      );
   });
}
