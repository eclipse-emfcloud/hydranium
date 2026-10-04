/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/** The exits of an operation, the index after each, and composition inside one. */

import {
   type Command,
   CompoundCommand,
   CompoundOperation,
   MessageAction,
   ModelSubmissionHandler,
   type Operation,
   UndoAction
} from '@eclipse-glsp/server';
import { DiagramStatus, type HydraniumGlspSubmissionHandler } from '@hydranium/glsp-server';
import { waitFor } from '@hydranium/protocol/testing';
import { describe, expect, it, vi } from 'vitest';
import { OrderFlowCommand } from '../../src/glsp/order-flow-command.js';
import { type ProcessModel, isTask } from '../../src/language-server/ast.js';
import {
   type Setup,
   apply,
   applyFailing,
   builtProcessRoot,
   changeTextUnbuilt,
   commandStackOf,
   createTask,
   dispatcherOf,
   handlerOf,
   move,
   nestedCommand,
   openDiagram,
   place,
   replay,
   spyOnPersist,
   textOf
} from './uncommitted-edit-harness.js';

describe('the exits of an operation', () => {
   it('success: writes once, pushes one undo step and submits', async () => {
      const opened = await openDiagram();
      const { diagram, processUri, layoutUri } = opened;
      const persist = spyOnPersist(diagram);

      await apply(diagram, createTask());

      expect({
         writes: persist.mock.calls.length,
         process: textOf(opened, processUri).includes('task NewTask'),
         layout: textOf(opened, layoutUri).includes('node NewTask'),
         canUndo: commandStackOf(diagram).canUndo()
      }).toEqual({ writes: 1, process: true, layout: true, canUndo: true });
   });

   it('createCommand throws: the built root keeps nothing the handler did, and the client is told', async () => {
      const opened = await openDiagram();
      const { diagram, processUri } = opened;
      const textBefore = textOf(opened, processUri);
      const create = createTask();
      vi.spyOn(handlerOf(diagram, create), 'createCommand').mockImplementationOnce(() => {
         const pay = diagram.state.sourceRoot.nodes.find(node => node.name === 'Pay') as { name: string };
         pay.name = 'Renamed';
         throw new Error('createCommand failed');
      });
      const submissions = vi.spyOn(
         diagram.sessionContainer.get<HydraniumGlspSubmissionHandler<ProcessModel>>(ModelSubmissionHandler),
         'submitModel'
      );

      const message = await applyFailing(diagram, create);

      expect({
         message: message.details?.includes('createCommand failed'),
         builtNames: builtProcessRoot(opened).nodes.map(node => node.name),
         sourceRootNames: diagram.state.sourceRoot.nodes.map(node => node.name),
         text: textOf(opened, processUri) === textBefore,
         canUndo: commandStackOf(diagram).canUndo(),
         submits: submissions.mock.calls.length
      }).toEqual({
         message: true,
         builtNames: ['Pay', 'PaymentOk', 'Pick', 'Ship', 'Cancel'],
         sourceRootNames: ['Pay', 'PaymentOk', 'Pick', 'Ship', 'Cancel'],
         text: true,
         canUndo: false,
         submits: 0
      });
   });

   it('a compound child throws after an earlier one succeeded: nothing written, its side effect reverted, the next operation runs', async () => {
      const opened = await openDiagram();
      const { diagram, layoutUri } = opened;
      const layoutBefore = textOf(opened, layoutUri);
      const create = createTask();
      let sideEffects = 0;
      vi.spyOn(handlerOf(diagram, create), 'createCommand').mockImplementationOnce(
         () =>
            new CompoundCommand([
               new OrderFlowCommand(
                  diagram.state,
                  'With a side effect',
                  () => {
                     sideEffects++;
                     place(diagram, 'Pay', 50, 110);
                  },
                  () => void sideEffects--,
                  () => void sideEffects++
               ),
               new OrderFlowCommand(diagram.state, 'Fail', () => {
                  throw new Error('second command failed');
               })
            ])
      );

      await applyFailing(diagram, create);
      const afterFailure = { layout: textOf(opened, layoutUri) === layoutBefore, sideEffects, canUndo: commandStackOf(diagram).canUndo() };
      await apply(diagram, move(diagram, 'Cancel', 300, 300));

      expect({ afterFailure, next: textOf(opened, layoutUri).includes('node Cancel at 300, 300') }).toEqual({
         afterFailure: { layout: true, sideEffects: 0, canUndo: false },
         next: true
      });
   });

   it('the write merges: a compound operation lands as one write onto a foreign edit', async () => {
      const opened = await openDiagram();
      const { diagram, layoutUri } = opened;
      // A foreign edit to another entry, so the write conflicts and merges.
      await changeTextUnbuilt(opened, text => text.replace('node PaymentOk at 260, 90', 'node PaymentOk at 270, 95'), layoutUri);
      const persist = spyOnPersist(diagram);

      await apply(diagram, CompoundOperation.create([move(diagram, 'Pay', 50, 110), move(diagram, 'Ship', 700, 220)]));

      const layout = textOf(opened, layoutUri);
      expect({
         // The conflicting write and its merged retry.
         writes: persist.mock.calls.length,
         pay: layout.includes('node Pay at 50, 110'),
         ship: layout.includes('node Ship at 700, 220'),
         foreign: layout.includes('node PaymentOk at 270, 95'),
         pick: layout.includes('node Pick at 440, 200'),
         canUndo: commandStackOf(diagram).canUndo()
      }).toEqual({ writes: 2, pay: true, ship: true, foreign: true, pick: true, canUndo: true });
   });

   it('the write is dropped: nothing lands, the side effects are reverted, no undo step is pushed, and the client view is submitted', async () => {
      const opened = await openDiagram();
      const { diagram, layoutUri } = opened;
      await apply(diagram, move(diagram, 'Cancel', 300, 300));
      // A foreign move of the node the second command moves: a same-field collision.
      await changeTextUnbuilt(opened, text => text.replace('node Ship at 660, 200', 'node Ship at 665, 205'), layoutUri);
      const create = createTask();
      let sideEffects = 0;
      vi.spyOn(handlerOf(diagram, create), 'createCommand').mockImplementationOnce(
         () =>
            new OrderFlowCommand(
               diagram.state,
               'Collide',
               () => {
                  sideEffects++;
                  (diagram.state.sourceRoot.nodes.find(node => node.name === 'Cancel') as { name: string }).name = 'Abort';
                  place(diagram, 'Pay', 50, 110);
                  place(diagram, 'Ship', 700, 220);
               },
               () => void sideEffects--,
               () => void sideEffects++
            )
      );

      await apply(diagram, create);
      const layout = textOf(opened, layoutUri);
      const dropped = {
         pay: layout.includes('node Pay at 40, 100'),
         ship: layout.includes('node Ship at 665, 205'),
         builtNames: builtProcessRoot(opened).nodes.map(node => node.name),
         sideEffects
      };
      // The one undo step there is the move of Cancel.
      await replay(diagram, UndoAction.create());

      expect({
         dropped,
         cancelUndone: !textOf(opened, layoutUri).includes('node Cancel at 300, 300'),
         canUndo: commandStackOf(diagram).canUndo()
      }).toEqual({
         dropped: { pay: true, ship: true, builtNames: ['Pay', 'PaymentOk', 'Pick', 'Ship', 'Cancel'], sideEffects: 0 },
         cancelUndone: true,
         canUndo: false
      });
   });

   it('rolls back the bridge of a recording command nested in another, when the operation fails', async () => {
      const opened = await openDiagram();
      const { diagram } = opened;
      const create = createTask();
      const sideEffects = { outer: 0, inner: 0 };
      vi.spyOn(handlerOf(diagram, create), 'createCommand').mockImplementationOnce(() => nestedCommand(diagram, sideEffects));
      vi.spyOn(diagram.state, 'updateSourceModel').mockRejectedValueOnce(new Error('write failed'));

      await applyFailing(diagram, create);

      expect(sideEffects).toEqual({ outer: 0, inner: 0 });
   });

   it('the write throws: the built root and the index stay on it, the stack is unchanged, nothing is submitted', async () => {
      const opened = await openDiagram();
      const { diagram, layoutUri } = opened;
      await apply(diagram, move(diagram, 'Pay', 50, 110));
      vi.spyOn(diagram.state, 'updateSourceModel').mockRejectedValueOnce(new Error('write failed'));
      const submissions = vi.spyOn(
         diagram.sessionContainer.get<HydraniumGlspSubmissionHandler<ProcessModel>>(ModelSubmissionHandler),
         'submitModel'
      );

      await applyFailing(diagram, createTask());
      const built = builtProcessRoot(opened);
      const pay = built.nodes.find(node => node.name === 'Pay')!;
      const afterFailure = {
         sourceRootIsBuilt: diagram.state.sourceRoot === built,
         builtNames: built.nodes.map(node => node.name),
         indexedPayIsBuilt: diagram.state.index.findSemanticElement(diagram.state.index.createId(pay)) === pay,
         submits: submissions.mock.calls.length
      };
      // The one undo there is reverts the move that landed, not the operation that failed.
      await replay(diagram, UndoAction.create());

      expect({
         afterFailure,
         undone: textOf(opened, layoutUri).includes('node Pay at 40, 100'),
         canUndo: commandStackOf(diagram).canUndo()
      }).toEqual({
         afterFailure: {
            sourceRootIsBuilt: true,
            builtNames: ['Pay', 'PaymentOk', 'Pick', 'Ship', 'Cancel'],
            indexedPayIsBuilt: true,
            submits: 0
         },
         undone: true,
         canUndo: false
      });
   });

   it.each([
      ['the operation', 'do'],
      ['an undo', 'undo']
   ] as const)(
      'fails %s whose write conflicts and cannot read the current text, writing nothing and keeping the foreign edit',
      async (_what, phase) => {
         const opened = await openDiagram();
         const { diagram, layoutUri } = opened;
         const create = createTask();
         let count = 0;
         const counted: Command = { execute: () => void count++, undo: () => void count--, redo: () => void count++ };
         vi.spyOn(handlerOf(diagram, create), 'createCommand').mockImplementationOnce(
            () => new CompoundCommand([counted, new OrderFlowCommand(diagram.state, 'Move Pay', () => place(diagram, 'Pay', 50, 110))])
         );
         if (phase === 'undo') {
            await apply(diagram, create);
         }
         // A foreign edit to another entry makes the write conflict; its refetch then reads nothing.
         await changeTextUnbuilt(opened, text => text.replace('node PaymentOk at 260, 90', 'node PaymentOk at 270, 95'), layoutUri);
         const state = diagram.state as unknown as { refetch(): Promise<unknown> };
         vi.spyOn(state, 'refetch').mockResolvedValueOnce(undefined);
         const layoutBefore = textOf(opened, layoutUri);

         const message = await applyFailing(diagram, phase === 'do' ? create : UndoAction.create());

         expect({
            reported: message.details?.includes('was not applied'),
            layout: textOf(opened, layoutUri) === layoutBefore,
            count,
            canUndo: commandStackOf(diagram).canUndo(),
            canRedo: commandStackOf(diagram).canRedo()
         }).toEqual({ reported: true, layout: true, count: phase === 'do' ? 0 : 1, canUndo: false, canRedo: false });
      }
   );

   it('a failed operation rolls back the side effects of every command that executed', async () => {
      const opened = await openDiagram();
      const { diagram, layoutUri } = opened;
      const layoutBefore = textOf(opened, layoutUri);
      const create = createTask();
      const sideEffects = { plain: 0, bridge: 0 };
      const plain: Command = {
         execute: () => void sideEffects.plain++,
         undo: () => void sideEffects.plain--,
         redo: () => void sideEffects.plain++
      };
      vi.spyOn(handlerOf(diagram, create), 'createCommand').mockImplementationOnce(
         () =>
            new CompoundCommand([
               plain,
               new OrderFlowCommand(
                  diagram.state,
                  'Bridged',
                  () => {
                     sideEffects.bridge++;
                     place(diagram, 'Pay', 50, 110);
                  },
                  () => void sideEffects.bridge--,
                  () => void sideEffects.bridge++
               )
            ])
      );
      vi.spyOn(diagram.state, 'updateSourceModel').mockRejectedValueOnce(new Error('write failed'));

      await applyFailing(diagram, create);

      expect({ sideEffects, layout: textOf(opened, layoutUri) === layoutBefore }).toEqual({
         sideEffects: { plain: 0, bridge: 0 },
         layout: true
      });
   });
});

describe('the index after each exit of an operation', () => {
   const exits: ReadonlyArray<readonly [string, (opened: Setup) => Promise<void>]> = [
      [
         'createCommand throws',
         async ({ diagram }) => {
            const create = createTask();
            vi.spyOn(handlerOf(diagram, create), 'createCommand').mockImplementationOnce(() => {
               throw new Error('createCommand failed');
            });
            await applyFailing(diagram, create);
         }
      ],
      [
         'a compound child throws',
         async ({ diagram }) => {
            const create = createTask();
            vi.spyOn(handlerOf(diagram, create), 'createCommand').mockImplementationOnce(
               () =>
                  new CompoundCommand([
                     new OrderFlowCommand(diagram.state, 'Place', () => place(diagram, 'Pay', 50, 110)),
                     new OrderFlowCommand(diagram.state, 'Fail', () => {
                        throw new Error('second command failed');
                     })
                  ])
            );
            await applyFailing(diagram, create);
         }
      ],
      [
         'the write merges',
         async opened => {
            await changeTextUnbuilt(
               opened,
               text => text.replace('node PaymentOk at 260, 90', 'node PaymentOk at 270, 95'),
               opened.layoutUri
            );
            await apply(opened.diagram, move(opened.diagram, 'Pay', 50, 110));
         }
      ],
      [
         'the write is dropped',
         async opened => {
            await changeTextUnbuilt(opened, text => text.replace('node Ship at 660, 200', 'node Ship at 665, 205'), opened.layoutUri);
            await apply(opened.diagram, move(opened.diagram, 'Ship', 700, 220));
         }
      ],
      [
         'the write throws',
         async ({ diagram }) => {
            vi.spyOn(diagram.state, 'updateSourceModel').mockRejectedValueOnce(new Error('write failed'));
            await applyFailing(diagram, createTask());
         }
      ]
   ];

   it.each(exits)('keeps the aliases and marker registrations after %s, and the next operation lands', async (_exit, exit) => {
      const opened = await openDiagram();
      const { diagram, layoutUri } = opened;
      const index = diagram.state.index;
      const pay = (): ProcessModel['nodes'][number] => builtProcessRoot(opened).nodes.find(node => node.name === 'Pay')!;
      const payNode = pay();
      const field = isTask(payNode) ? payNode.effects[0]?.field?.ref : undefined;
      index.indexSemanticElement('alias-pay', payNode);
      const state = (): unknown => ({
         alias: index.findSemanticElement('alias-pay') === pay(),
         indexed: index.findSemanticElement(index.createId(pay())) === pay(),
         markerIds: index.findElementIds(field).length > 0,
         documents: [...index.renderedDocumentUris()].sort()
      });
      const before = state();

      await exit(opened);
      const after = state();
      await apply(diagram, move(diagram, 'Cancel', 300, 300));

      expect({ before, after, next: textOf(opened, layoutUri).includes('node Cancel at 300, 300') }).toEqual({
         before: { alias: true, indexed: true, markerIds: true, documents: expect.any(Array) },
         after: before,
         next: true
      });
   });
});

describe('composition inside one operation', () => {
   it('lands a command composed through the operation handler registry as one write and one undo step', async () => {
      const opened = await openDiagram();
      const { diagram, processUri, layoutUri } = opened;
      const create = createTask();
      const handler = handlerOf(diagram, create);
      const createCommand = handler.createCommand.bind(handler);
      const moveShip = move(diagram, 'Ship', 700, 220);
      vi.spyOn(handler, 'createCommand').mockImplementationOnce(async (operation: Operation) => {
         const composed = await handlerOf(diagram, moveShip).execute(moveShip);
         const own = await createCommand(operation);
         return new CompoundCommand([own!, composed!]);
      });
      const persist = spyOnPersist(diagram);

      await apply(diagram, create);
      const done = {
         writes: persist.mock.calls.length,
         task: textOf(opened, processUri).includes('task NewTask'),
         ship: textOf(opened, layoutUri).includes('node Ship at 700, 220')
      };
      await replay(diagram, UndoAction.create());

      expect({
         done,
         undone: {
            task: textOf(opened, processUri).includes('task NewTask'),
            ship: textOf(opened, layoutUri).includes('node Ship at 700, 220')
         },
         canUndo: commandStackOf(diagram).canUndo()
      }).toEqual({ done: { writes: 1, task: true, ship: true }, undone: { task: false, ship: false }, canUndo: false });
   });

   it('gives the delete of a handler shaped like GLSP cut, which dispatches it and makes no command, one write and one undo step', async () => {
      const opened = await openDiagram();
      const { diagram, layoutUri } = opened;
      const create = createTask();
      vi.spyOn(handlerOf(diagram, create), 'createCommand').mockImplementationOnce(() => {
         void dispatcherOf(diagram).dispatch(move(diagram, 'Pay', 50, 110));
         return undefined;
      });
      const persist = spyOnPersist(diagram);

      await apply(diagram, create);
      const done = { writes: persist.mock.calls.length, moved: textOf(opened, layoutUri).includes('node Pay at 50, 110') };
      await replay(diagram, UndoAction.create());

      expect({
         done,
         undone: textOf(opened, layoutUri).includes('node Pay at 40, 100'),
         canUndo: commandStackOf(diagram).canUndo()
      }).toEqual({
         done: { writes: 1, moved: true },
         undone: true,
         canUndo: false
      });
   });
});

describe('an operation queued behind another', () => {
   it('does not run once the diagram turned read-only, and the client is warned', async () => {
      const opened = await openDiagram();
      const { diagram, layoutUri } = opened;
      const create = createTask();
      const handler = handlerOf(diagram, create);
      const createCommand = handler.createCommand.bind(handler);
      vi.spyOn(handler, 'createCommand').mockImplementationOnce((operation: Operation) => {
         void dispatcherOf(diagram).dispatch(move(diagram, 'Pay', 50, 110));
         diagram.state.setStatus(DiagramStatus.CLIENT_REQUEST, { readonly: true });
         return createCommand(operation);
      });
      const before = diagram.actions.length;

      await apply(diagram, create);
      await waitFor(() => diagram.actions.slice(before).some(action => MessageAction.is(action) && action.severity === 'WARNING'), {
         message: 'the client was not warned'
      });

      expect(textOf(opened, layoutUri).includes('node Pay at 50, 110')).toBe(false);
   });
});
