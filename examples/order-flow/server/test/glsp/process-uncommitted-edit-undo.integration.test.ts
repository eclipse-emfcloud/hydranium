/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/** Undo and redo of an operation, and the order of its side effects. */

import { type Command, CompoundCommand, CompoundOperation, RedoAction, UndoAction } from '@eclipse-glsp/server';
import { describe, expect, it, vi } from 'vitest';
import { OrderFlowCommand } from '../../src/glsp/order-flow-command.js';
import {
   type Diagram,
   type Setup,
   apply,
   applyFailing,
   builtLayoutRoot,
   builtProcessRoot,
   changeTextBuilt,
   changeTextUnbuilt,
   commandStackOf,
   createTask,
   handlerOf,
   move,
   nestedCommand,
   openDiagram,
   place,
   replay,
   spyOnPersist,
   textOf
} from './uncommitted-edit-harness.js';

describe('the side effects of an operation, in order', () => {
   /** A compound of a command that does not record and a recording one with a bridge, each logging into `log`. */
   function mixedCompound(diagram: Diagram, log: string[], ...rest: Command[]): CompoundCommand {
      const plain: Command = {
         execute: () => void log.push('plain:execute'),
         undo: () => void log.push('plain:undo'),
         redo: () => void log.push('plain:redo')
      };
      const recording = new OrderFlowCommand(
         diagram.state,
         'Bridged',
         () => {
            log.push('recording:execute');
            place(diagram, 'Pay', 50, 110);
         },
         () => void log.push('bridge:undo'),
         () => void log.push('bridge:redo')
      );
      return new CompoundCommand([plain, recording, ...rest]);
   }

   it('undoes in reverse execution order and redoes in execution order', async () => {
      const opened = await openDiagram();
      const { diagram } = opened;
      const create = createTask();
      const log: string[] = [];
      vi.spyOn(handlerOf(diagram, create), 'createCommand').mockImplementationOnce(() => mixedCompound(diagram, log));
      await apply(diagram, create);

      await replay(diagram, UndoAction.create());
      await replay(diagram, RedoAction.create());

      expect(log).toEqual(['plain:execute', 'recording:execute', 'bridge:undo', 'plain:undo', 'plain:redo', 'bridge:redo']);
   });

   it('rolls back in reverse execution order when a later compound child throws', async () => {
      const opened = await openDiagram();
      const { diagram } = opened;
      const create = createTask();
      const log: string[] = [];
      const failing = new OrderFlowCommand(diagram.state, 'Fail', () => {
         throw new Error('third command failed');
      });
      vi.spyOn(handlerOf(diagram, create), 'createCommand').mockImplementationOnce(() => mixedCompound(diagram, log, failing));

      await applyFailing(diagram, create);

      expect(log).toEqual(['plain:execute', 'recording:execute', 'bridge:undo', 'plain:undo']);
   });

   it('reverts an earlier compound child that does not record when a later one throws', async () => {
      const opened = await openDiagram();
      const { diagram } = opened;
      const create = createTask();
      let sideEffects = 0;
      const plain: Command = { execute: () => void sideEffects++, undo: () => void sideEffects--, redo: () => void sideEffects++ };
      vi.spyOn(handlerOf(diagram, create), 'createCommand').mockImplementationOnce(
         () =>
            new CompoundCommand([
               plain,
               new OrderFlowCommand(diagram.state, 'Fail', () => {
                  throw new Error('second command failed');
               })
            ])
      );

      await applyFailing(diagram, create);

      expect({ sideEffects, canUndo: commandStackOf(diagram).canUndo() }).toEqual({ sideEffects: 0, canUndo: false });
   });

   it('keeps rolling back the earlier side effects when one step fails to undo, and reports the original failure', async () => {
      const opened = await openDiagram();
      const { diagram } = opened;
      const create = createTask();
      let count = 0;
      const counted: Command = { execute: () => void count++, undo: () => void count--, redo: () => void count++ };
      const failingUndo: Command = {
         execute: () => undefined,
         undo: () => {
            throw new Error('undo step failed');
         },
         redo: () => undefined
      };
      vi.spyOn(handlerOf(diagram, create), 'createCommand').mockImplementationOnce(
         () =>
            new CompoundCommand([
               counted,
               failingUndo,
               new OrderFlowCommand(diagram.state, 'Move Pay', () => place(diagram, 'Pay', 50, 110))
            ])
      );
      vi.spyOn(diagram.state, 'updateSourceModel').mockRejectedValueOnce(new Error('write failed'));

      const message = await applyFailing(diagram, create);

      expect({ count, reported: message.details?.includes('write failed') }).toEqual({ count: 0, reported: true });
   });

   it('keeps redoing the replayed side effects when one step fails to redo after a failed undo write', async () => {
      const opened = await openDiagram();
      const { diagram } = opened;
      const create = createTask();
      let count = 0;
      const counted: Command = { execute: () => void count++, undo: () => void count--, redo: () => void count++ };
      const failingRedo: Command = {
         execute: () => undefined,
         undo: () => undefined,
         redo: () => {
            throw new Error('redo step failed');
         }
      };
      vi.spyOn(handlerOf(diagram, create), 'createCommand').mockImplementationOnce(
         () =>
            new CompoundCommand([
               failingRedo,
               counted,
               new OrderFlowCommand(diagram.state, 'Move Pay', () => place(diagram, 'Pay', 50, 110))
            ])
      );
      await apply(diagram, create);
      vi.spyOn(diagram.state, 'updateSourceModel').mockRejectedValueOnce(new Error('undo write failed'));

      const message = await applyFailing(diagram, UndoAction.create());

      expect({ count, reported: message.details?.includes('undo write failed') }).toEqual({ count: 1, reported: true });
   });

   it('runs no side effect when an undo collides', async () => {
      const opened = await openDiagram();
      const { diagram, layoutUri } = opened;
      const create = createTask();
      let sideEffects = 0;
      vi.spyOn(handlerOf(diagram, create), 'createCommand').mockImplementationOnce(
         () =>
            new OrderFlowCommand(
               diagram.state,
               'Move Ship',
               () => {
                  sideEffects++;
                  place(diagram, 'Ship', 700, 220);
               },
               () => void sideEffects--,
               () => void sideEffects++
            )
      );
      await apply(diagram, create);
      // A foreign move of the same entry: the undo's revert collides.
      await changeTextBuilt(opened, layoutUri, text => text.replace('node Ship at 700, 220', 'node Ship at 705, 225'));
      const persist = spyOnPersist(diagram);

      await replay(diagram, UndoAction.create());

      expect({ sideEffects, writes: persist.mock.calls.length, ship: textOf(opened, layoutUri).includes('node Ship at 705, 225') }).toEqual(
         {
            sideEffects: 1,
            writes: 0,
            ship: true
         }
      );
   });

   it('undoes an operation whose write merged onto a foreign edit, keeping the foreign edit', async () => {
      const opened = await openDiagram();
      const { diagram, layoutUri } = opened;
      await changeTextUnbuilt(opened, text => text.replace('node PaymentOk at 260, 90', 'node PaymentOk at 270, 95'), layoutUri);
      await apply(diagram, CompoundOperation.create([move(diagram, 'Pay', 50, 110), move(diagram, 'Ship', 700, 220)]));

      await replay(diagram, UndoAction.create());

      const layout = textOf(opened, layoutUri);
      expect({
         pay: layout.includes('node Pay at 40, 100'),
         ship: layout.includes('node Ship at 660, 200'),
         foreign: layout.includes('node PaymentOk at 270, 95')
      }).toEqual({ pay: true, ship: true, foreign: true });
   });
});

describe('undo and redo of an operation', () => {
   it('undoes and redoes a compound operation as one write, all or nothing', async () => {
      const opened = await openDiagram();
      const { diagram, layoutUri } = opened;
      await apply(diagram, CompoundOperation.create([move(diagram, 'Pay', 50, 110), move(diagram, 'Ship', 700, 220)]));
      const layout = (): string => textOf(opened, layoutUri);
      const persist = spyOnPersist(diagram);

      await replay(diagram, UndoAction.create());
      const undone = {
         writes: persist.mock.calls.length,
         pay: layout().includes('node Pay at 40, 100'),
         ship: layout().includes('node Ship at 660, 200')
      };
      await replay(diagram, RedoAction.create());
      const redone = {
         writes: persist.mock.calls.length,
         pay: layout().includes('node Pay at 50, 110'),
         ship: layout().includes('node Ship at 700, 220')
      };
      // A foreign edit to one child's field: its revert collides, so the whole undo is skipped.
      await changeTextBuilt(opened, layoutUri, text => text.replace('node Ship at 700, 220', 'node Ship at 705, 225'));
      await replay(diagram, UndoAction.create());

      expect({
         undone,
         redone,
         afterCollision: { pay: layout().includes('node Pay at 50, 110'), writes: persist.mock.calls.length }
      }).toEqual({
         undone: { writes: 1, pay: true, ship: true },
         redone: { writes: 2, pay: true, ship: true },
         afterCollision: { pay: true, writes: 2 }
      });
   });

   it('runs an undo side effect that edits sourceRoot on a copy, and reverts the text with the one write', async () => {
      const opened = await openDiagram();
      const { diagram, processUri, layoutUri } = opened;
      const create = createTask();
      let builtNamesDuringUndo: string[] | undefined;
      const renaming: Command = {
         execute: () => undefined,
         undo: () => {
            (diagram.state.sourceRoot.nodes.find(node => node.name === 'Cancel') as { name: string }).name = 'Abort';
            builtNamesDuringUndo = builtProcessRoot(opened).nodes.map(node => node.name);
         },
         redo: () => undefined
      };
      vi.spyOn(handlerOf(diagram, create), 'createCommand').mockImplementationOnce(
         () => new CompoundCommand([new OrderFlowCommand(diagram.state, 'Place', () => place(diagram, 'Pay', 50, 110)), renaming])
      );
      await apply(diagram, create);

      await replay(diagram, UndoAction.create());

      expect({
         builtNamesDuringUndo,
         abort: textOf(opened, processUri).includes('Abort'),
         payReverted: textOf(opened, layoutUri).includes('node Pay at 40, 100'),
         sourceRootIsBuilt: diagram.state.sourceRoot === builtProcessRoot(opened)
      }).toEqual({
         builtNamesDuringUndo: ['Pay', 'PaymentOk', 'Pick', 'Ship', 'Cancel'],
         abort: false,
         payReverted: true,
         sourceRootIsBuilt: true
      });
   });

   /**
    * Create an operation of a counted side effect, a move of Pay, and a side
    * effect whose undo runs `onUndo` and whose redo runs `onRedo`; answer the
    * counter.
    */
   async function applyUndoable(
      opened: Setup,
      onUndo: () => Promise<void>,
      onRedo: () => Promise<void> = async () => undefined
   ): Promise<{ count: number }> {
      const { diagram } = opened;
      const create = createTask();
      const counter = { count: 0 };
      const counted: Command = { execute: () => void counter.count++, undo: () => void counter.count--, redo: () => void counter.count++ };
      const hook: Command = { execute: () => undefined, undo: onUndo, redo: onRedo };
      vi.spyOn(handlerOf(diagram, create), 'createCommand').mockImplementationOnce(
         () => new CompoundCommand([counted, new OrderFlowCommand(diagram.state, 'Move Pay', () => place(diagram, 'Pay', 50, 110)), hook])
      );
      await apply(diagram, create);
      return counter;
   }

   it('keeps a foreign edit that lands while an undo runs its side effects', async () => {
      const opened = await openDiagram();
      const { diagram, layoutUri } = opened;
      await applyUndoable(opened, () =>
         changeTextBuilt(opened, layoutUri, text => text.replace('node PaymentOk at 260, 90', 'node PaymentOk at 270, 95'))
      );

      await replay(diagram, UndoAction.create());

      const layout = textOf(opened, layoutUri);
      expect({ payReverted: layout.includes('node Pay at 40, 100'), foreign: layout.includes('node PaymentOk at 270, 95') }).toEqual({
         payReverted: true,
         foreign: true
      });
   });

   it('keeps a foreign edit that lands while a redo runs its side effects', async () => {
      const opened = await openDiagram();
      const { diagram, layoutUri } = opened;
      await applyUndoable(
         opened,
         async () => undefined,
         () => changeTextBuilt(opened, layoutUri, text => text.replace('node PaymentOk at 260, 90', 'node PaymentOk at 270, 95'))
      );
      await replay(diagram, UndoAction.create());

      await replay(diagram, RedoAction.create());

      const layout = textOf(opened, layoutUri);
      expect({ payRedone: layout.includes('node Pay at 50, 110'), foreign: layout.includes('node PaymentOk at 270, 95') }).toEqual({
         payRedone: true,
         foreign: true
      });
   });

   it('fails an undo whose revert collides with a foreign edit that lands meanwhile, and redoes its side effects', async () => {
      const opened = await openDiagram();
      const { diagram, layoutUri } = opened;
      const counter = await applyUndoable(opened, () =>
         changeTextBuilt(opened, layoutUri, text => text.replace('node Pay at 50, 110', 'node Pay at 55, 115'))
      );

      await applyFailing(diagram, UndoAction.create());

      expect({ count: counter.count, foreign: textOf(opened, layoutUri).includes('node Pay at 55, 115') }).toEqual({
         count: 1,
         foreign: true
      });
   });

   it('redoes the side effects of an undo whose write throws, and leaves the text as it was', async () => {
      const opened = await openDiagram();
      const { diagram, layoutUri } = opened;
      const counter = await applyUndoable(opened, async () => undefined);
      const layoutBefore = textOf(opened, layoutUri);
      vi.spyOn(diagram.state, 'updateSourceModel').mockRejectedValueOnce(new Error('undo write failed'));

      await applyFailing(diagram, UndoAction.create());

      expect({ count: counter.count, layout: textOf(opened, layoutUri) === layoutBefore }).toEqual({ count: 1, layout: true });
   });

   it('fails an undo whose bridge executes a recording command: steps already run are redone, nothing is written, the stack flushes', async () => {
      const opened = await openDiagram();
      const { diagram, layoutUri } = opened;
      const create = createTask();
      let sideEffects = 0;
      const plain: Command = { execute: () => void sideEffects++, undo: () => void sideEffects--, redo: () => void sideEffects++ };
      vi.spyOn(handlerOf(diagram, create), 'createCommand').mockImplementationOnce(
         () =>
            new CompoundCommand([
               new OrderFlowCommand(
                  diagram.state,
                  'Outer',
                  () => place(diagram, 'Pay', 50, 110),
                  async () => {
                     await new OrderFlowCommand(diagram.state, 'Inner', () => place(diagram, 'Ship', 700, 220)).execute();
                  }
               ),
               plain
            ])
      );
      await apply(diagram, create);
      const layoutBefore = textOf(opened, layoutUri);
      const persist = spyOnPersist(diagram);

      const message = await applyFailing(diagram, UndoAction.create());

      expect({
         reported: message.details?.includes("Recording command 'Inner' executed during an undo or redo"),
         sideEffects,
         writes: persist.mock.calls.length,
         layout: textOf(opened, layoutUri) === layoutBefore,
         builtShipX: builtLayoutRoot(opened)?.nodes.find(node => node.flowNode.$refText === 'Ship')?.x,
         canUndo: commandStackOf(diagram).canUndo(),
         canRedo: commandStackOf(diagram).canRedo()
      }).toEqual({ reported: true, sideEffects: 1, writes: 0, layout: true, builtShipX: 660, canUndo: false, canRedo: false });
   });

   it('undoes and redoes a recording command that executes another as one step, one write each', async () => {
      const opened = await openDiagram();
      const { diagram, layoutUri } = opened;
      const create = createTask();
      vi.spyOn(handlerOf(diagram, create), 'createCommand').mockImplementationOnce(
         () =>
            new OrderFlowCommand(diagram.state, 'Outer', async () => {
               place(diagram, 'Pay', 50, 110);
               await new OrderFlowCommand(diagram.state, 'Inner', () => place(diagram, 'Ship', 700, 220)).execute();
            })
      );
      await apply(diagram, create);
      const placed = (): { pay: boolean; ship: boolean } => ({
         pay: textOf(opened, layoutUri).includes('node Pay at 50, 110'),
         ship: textOf(opened, layoutUri).includes('node Ship at 700, 220')
      });
      const before = placed();
      const persist = spyOnPersist(diagram);

      await replay(diagram, UndoAction.create());
      const undone = { ...placed(), writes: persist.mock.calls.length };
      await replay(diagram, RedoAction.create());

      expect({ before, undone, redone: { ...placed(), writes: persist.mock.calls.length } }).toEqual({
         before: { pay: true, ship: true },
         undone: { pay: false, ship: false, writes: 1 },
         redone: { pay: true, ship: true, writes: 2 }
      });
   });

   it('undoes and redoes the bridge of a recording command nested in another once each', async () => {
      const opened = await openDiagram();
      const { diagram, layoutUri } = opened;
      const create = createTask();
      const sideEffects = { outer: 0, inner: 0 };
      vi.spyOn(handlerOf(diagram, create), 'createCommand').mockImplementationOnce(() => nestedCommand(diagram, sideEffects));
      await apply(diagram, create);
      const done = { ...sideEffects };

      await replay(diagram, UndoAction.create());
      const undone = { ...sideEffects, ship: textOf(opened, layoutUri).includes('node Ship at 660, 200') };
      await replay(diagram, RedoAction.create());

      expect({ done, undone, redone: { ...sideEffects, ship: textOf(opened, layoutUri).includes('node Ship at 700, 220') } }).toEqual({
         done: { outer: 1, inner: 1 },
         undone: { outer: 0, inner: 0, ship: true },
         redone: { outer: 1, inner: 1, ship: true }
      });
   });

   it.each([
      ['a recording child that moves a node', true],
      ['a recording child that changes nothing', false]
   ])('undoes and redoes the side effect of a compound with %s', async (_child, moves) => {
      const opened = await openDiagram();
      const { diagram, layoutUri } = opened;
      const create = createTask();
      let sideEffects = 0;
      const sideEffect: Command = {
         execute: () => void sideEffects++,
         undo: () => void sideEffects--,
         redo: () => void sideEffects++
      };
      vi.spyOn(handlerOf(diagram, create), 'createCommand').mockImplementationOnce(
         () =>
            new CompoundCommand([
               new OrderFlowCommand(diagram.state, 'Recording', () => {
                  if (moves) {
                     place(diagram, 'Pay', 50, 110);
                  }
               }),
               sideEffect
            ])
      );
      await apply(diagram, create);
      const state = (): { sideEffects: number; payMoved: boolean } => ({
         sideEffects,
         payMoved: textOf(opened, layoutUri).includes('node Pay at 50, 110')
      });
      const done = state();

      await replay(diagram, UndoAction.create());
      const undone = state();
      await replay(diagram, RedoAction.create());

      expect({ done, undone, redone: state() }).toEqual({
         done: { sideEffects: 1, payMoved: moves },
         undone: { sideEffects: 0, payMoved: false },
         redone: { sideEffects: 1, payMoved: moves }
      });
   });

   it('opens an operation of its own for a recording command executed outside one: the built root is untouched until its one write', async () => {
      const opened = await openDiagram();
      const { diagram, layoutUri } = opened;
      let builtPayXDuring: number | undefined;
      const command = new OrderFlowCommand(diagram.state, 'Direct', () => {
         place(diagram, 'Pay', 50, 110);
         builtPayXDuring = builtLayoutRoot(opened)?.nodes.find(node => node.flowNode.$refText === 'Pay')?.x;
      });
      const persist = spyOnPersist(diagram);

      await command.execute();
      const done = { builtPayXDuring, writes: persist.mock.calls.length, moved: textOf(opened, layoutUri).includes('node Pay at 50, 110') };
      await diagram.state.runExclusive(() => command.undo());

      expect({ done, undoWrites: persist.mock.calls.length, undone: textOf(opened, layoutUri).includes('node Pay at 40, 100') }).toEqual({
         done: { builtPayXDuring: 40, writes: 1, moved: true },
         undoWrites: 2,
         undone: true
      });
   });
});
