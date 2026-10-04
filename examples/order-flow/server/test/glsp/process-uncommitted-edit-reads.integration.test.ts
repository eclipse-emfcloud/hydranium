/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/** Readers of a diagram's documents during an operation, the roots it copies, and the copies a handler edits. */

import {
   type Action,
   ApplyLabelEditOperation,
   DeleteElementOperation,
   type Operation,
   RedoAction,
   SourceModelStorage,
   UndoAction
} from '@eclipse-glsp/server';
import type { AstNode } from '@hydranium/langium';
import { waitFor } from '@hydranium/protocol/testing';
import { readFileSync, unlinkSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { DiagramNode, LayoutModel, ProcessModel, Transition } from '../../src/language-server/ast.js';
import { WORKSPACE_FILES } from '../order-flow-harness.js';
import {
   apply,
   applyFailing,
   builtProcessRoot,
   changeTextBuilt,
   changeTextUnbuilt,
   createTask,
   flushResubmit,
   gate,
   handlerOf,
   insideOperation,
   move,
   openDiagram,
   readBeforeRefetch,
   replay,
   spyOnPersist,
   spyOnRefetch,
   textOf
} from './uncommitted-edit-harness.js';

describe('a diagram edit before its write commits', () => {
   it('is not visible to other readers while its reconcile waits', async () => {
      const opened = await openDiagram();
      const { services, diagram, head, processUri, layoutUri } = opened;
      await changeTextUnbuilt(opened, text =>
         text.replace('   transition Pay -> PaymentOk', '   task Refund reads Order.id\n   transition Pay -> PaymentOk')
      );
      const observed = readBeforeRefetch(diagram, async () => {
         const snapshot = services.shared.model.ModelService.snapshot(processUri);
         const layout = await head.proxy.getModelDocument({ uri: layoutUri });
         const process = await head.proxy.getModelDocument({ uri: processUri });
         return {
            builtProcessRoot: (snapshot?.root as ProcessModel | undefined)?.nodes.map(node => node.name),
            layoutReadHoldsNewTask: JSON.stringify(layout.model?.root).includes('"NewTask"'),
            processReadHoldsNewTask: JSON.stringify(process.model?.root).includes('"NewTask"')
         };
      });

      await apply(diagram, createTask());

      // The merged write landed, so the window was the conflict path.
      expect(textOf(opened, processUri)).toContain('task NewTask');
      expect(observed()).toEqual({
         builtProcessRoot: ['Pay', 'PaymentOk', 'Pick', 'Ship', 'Cancel'],
         layoutReadHoldsNewTask: false,
         processReadHoldsNewTask: false
      });
   });

   it('is never visible once the reconcile drops it', async () => {
      const opened = await openDiagram();
      const { diagram, head, processUri, layoutUri } = opened;
      const pick = diagram.state.sourceRoot.nodes.find(node => node.name === 'Pick');
      expect(pick).toBeDefined();
      // The other writer retargets the effect the delete removes: a same-field collision.
      await changeTextUnbuilt(opened, text => text.replace('task Pick reads Order.id', 'task Pick reads Order.status'));

      await apply(diagram, DeleteElementOperation.create([diagram.state.index.createId(pick!)]));

      const layout = await head.proxy.getModelDocument({ uri: layoutUri });
      expect({
         processText: textOf(opened, processUri).includes('task Pick reads Order.status'),
         layoutText: textOf(opened, layoutUri).includes('node Pick at 440, 200'),
         layoutReadHoldsPick: JSON.stringify(layout.model?.root).includes('"Pick"')
      }).toEqual({ processText: true, layoutText: true, layoutReadHoldsPick: true });
   });

   it('keeps a comment on a node it renames', async () => {
      const opened = await openDiagram(workspace => {
         const file = WORKSPACE_FILES.fulfillmentProcess;
         const text = readFileSync(workspace.resolve(file), 'utf8');
         workspace.write(
            file,
            text.replace('   task Pick reads Order.id', '   // Takes the goods off the shelf.\n   task Pick reads Order.id')
         );
      });
      const { diagram, processUri } = opened;
      const pick = diagram.state.sourceRoot.nodes.find(node => node.name === 'Pick');
      expect(pick).toBeDefined();

      await apply(diagram, ApplyLabelEditOperation.create({ labelId: `${diagram.state.index.createId(pick!)}_name`, text: 'Picking' }));

      expect(textOf(opened, processUri)).toContain('   // Takes the goods off the shelf.\n   task Picking\n');
   });

   it('keeps a failed drag out of the layout held in memory before the layout file exists', async () => {
      const { diagram } = await openDiagram(workspace => unlinkSync(workspace.resolve(WORKSPACE_FILES.fulfillmentDiagram)), [], false);
      expect(diagram.state.layoutRoot.nodes).toEqual([]);
      vi.spyOn(diagram.state, 'updateSourceModel').mockRejectedValueOnce(new Error('write failed'));

      await applyFailing(diagram, move(diagram, 'Pay', 50, 110));

      expect(diagram.state.layoutRoot.nodes).toEqual([]);
   });

   it('does not conflict with its own last write on a second layout-only move', async () => {
      const opened = await openDiagram();
      const { diagram, layoutUri } = opened;
      await apply(diagram, move(diagram, 'Pay', 50, 110));
      const refetch = spyOnRefetch(diagram);

      await apply(diagram, move(diagram, 'Pay', 60, 120));

      expect({ refetches: refetch.mock.calls.length, moved: textOf(opened, layoutUri).includes('node Pay at 60, 120') }).toEqual({
         refetches: 0,
         moved: true
      });
   });

   it('lands an unrelated move after a dropped one', async () => {
      const opened = await openDiagram();
      const { diagram, layoutUri } = opened;
      await changeTextUnbuilt(opened, text => text.replace('node Pay at 40, 100', 'node Pay at 45, 105'), layoutUri);
      await apply(diagram, move(diagram, 'Pay', 50, 110));

      await apply(diagram, move(diagram, 'Ship', 700, 220));

      const layout = textOf(opened, layoutUri);
      expect({ foreignPay: layout.includes('node Pay at 45, 105'), ship: layout.includes('node Ship at 700, 220') }).toEqual({
         foreignPay: true,
         ship: true
      });
   });
});

describe('the roots an operation copies', () => {
   it('copies the layout as it was when the operation opened, so a foreign edit landing meanwhile merges', async () => {
      const opened = await openDiagram();
      const { diagram, layoutUri } = opened;
      const movePay = move(diagram, 'Pay', 50, 110);
      const handler = handlerOf(diagram, movePay);
      const createCommand = handler.createCommand.bind(handler);
      vi.spyOn(handler, 'createCommand').mockImplementationOnce(async (operation: Operation) => {
         await changeTextBuilt(opened, layoutUri, text => text.replace('node PaymentOk at 260, 90', 'node PaymentOk at 270, 95'));
         return createCommand(operation);
      });

      await apply(diagram, movePay);

      const layout = textOf(opened, layoutUri);
      expect({ pay: layout.includes('node Pay at 50, 110'), foreign: layout.includes('node PaymentOk at 270, 95') }).toEqual({
         pay: true,
         foreign: true
      });
   });

   it.each([
      ['tracked in createCommand', false],
      ['first reached through workingRootOf, then tracked', true]
   ])('undoes and redoes the edit of a document %s', async (_how, reachFirst) => {
      const opened = await openDiagram();
      const { diagram, layoutUri } = opened;
      diagram.state.untrackSecondaryDocuments();
      const movePay = move(diagram, 'Pay', 50, 110);
      const handler = handlerOf(diagram, movePay);
      const createCommand = handler.createCommand.bind(handler);
      vi.spyOn(handler, 'createCommand').mockImplementationOnce((operation: Operation) => {
         if (reachFirst) {
            diagram.state.workingRootOf(layoutUri);
         }
         diagram.state.trackSecondaryDocument(layoutUri);
         return createCommand(operation);
      });
      await apply(diagram, movePay);
      const moved = textOf(opened, layoutUri).includes('node Pay at 50, 110');

      await replay(diagram, UndoAction.create());
      const undone = textOf(opened, layoutUri).includes('node Pay at 40, 100');
      await replay(diagram, RedoAction.create());

      expect({ moved, undone, redone: textOf(opened, layoutUri).includes('node Pay at 50, 110') }).toEqual({
         moved: true,
         undone: true,
         redone: true
      });
   });

   it('leaves a document untracked during the operation out of its write, undo and redo', async () => {
      const opened = await openDiagram();
      const { diagram, layoutUri } = opened;
      const movePay = move(diagram, 'Pay', 50, 110);
      const handler = handlerOf(diagram, movePay);
      const createCommand = handler.createCommand.bind(handler);
      vi.spyOn(handler, 'createCommand').mockImplementationOnce(async (operation: Operation) => {
         const command = await createCommand(operation);
         diagram.state.untrackSecondaryDocuments();
         return command;
      });
      const persist = spyOnPersist(diagram);

      await apply(diagram, movePay);
      const written = { writes: persist.mock.calls.length, moved: textOf(opened, layoutUri).includes('node Pay at 50, 110') };
      // The capture that closes the operation tracks the layout again; a later
      // foreign edit to it must survive the undo.
      await changeTextBuilt(opened, layoutUri, text => text.replace('node PaymentOk at 260, 90', 'node PaymentOk at 270, 95'));
      const resolve = vi.spyOn(diagram.state.conflictResolver, 'resolve');
      await replay(diagram, UndoAction.create());
      const outcomes = await Promise.all(resolve.mock.results.map(result => result.value as Promise<{ status: string }>));

      expect({
         written,
         foreign: textOf(opened, layoutUri).includes('node PaymentOk at 270, 95'),
         undo: outcomes.map(outcome => outcome.status)
      }).toEqual({ written: { writes: 1, moved: false }, foreign: true, undo: ['no-op'] });
   });

   it('gates a document first tracked during the operation on the root its copy was made from', async () => {
      const opened = await openDiagram();
      const { diagram, layoutUri } = opened;
      diagram.state.untrackSecondaryDocuments();
      const movePay = move(diagram, 'Pay', 50, 110);
      const handler = handlerOf(diagram, movePay);
      const createCommand = handler.createCommand.bind(handler);
      vi.spyOn(handler, 'createCommand').mockImplementationOnce(async (operation: Operation) => {
         // First reached here, then edited by another client, then tracked.
         expect(diagram.state.layoutRoot.nodes.length).toBeGreaterThan(0);
         await changeTextBuilt(opened, layoutUri, text => text.replace('node PaymentOk at 260, 90', 'node PaymentOk at 270, 95'));
         diagram.state.trackSecondaryDocument(layoutUri);
         return createCommand(operation);
      });

      await apply(diagram, movePay);

      const layout = textOf(opened, layoutUri);
      expect({ pay: layout.includes('node Pay at 50, 110'), foreign: layout.includes('node PaymentOk at 270, 95') }).toEqual({
         pay: true,
         foreign: true
      });
   });
});

describe('the working copies a handler edits', () => {
   it('keeps ids added through indexSemanticElement across an operation, on the copies inside it', async () => {
      const opened = await openDiagram();
      const { diagram, layoutUri } = opened;
      const index = diagram.state.index;
      const builtPay = builtProcessRoot(opened).nodes.find(node => node.name === 'Pay')!;
      const builtEntry = (diagram.state.workingRootOf(layoutUri) as LayoutModel).nodes.find(node => node.flowNode.$refText === 'Pay')!;
      index.indexSemanticElement('alias-pay', builtPay);
      index.indexSemanticElement('alias-entry', builtEntry);

      const inside = await insideOperation(diagram, () => {
         const copyPay = diagram.state.sourceRoot.nodes.find(node => node.name === 'Pay');
         const entryBeforeCopy = index.findSemanticElement('alias-entry') === builtEntry;
         const copyEntry = (diagram.state.workingRootOf(layoutUri) as LayoutModel).nodes.find(node => node.flowNode.$refText === 'Pay');
         return {
            pay: index.findSemanticElement('alias-pay') === copyPay && copyPay !== builtPay,
            entryBeforeCopy,
            entryAfterCopy: index.findSemanticElement('alias-entry') === copyEntry && copyEntry !== builtEntry
         };
      });
      const after = {
         pay: index.findSemanticElement('alias-pay') === builtPay,
         entry: index.findSemanticElement('alias-entry') === builtEntry
      };
      // A write rebuilds the layout: an alias of a node it replaced names nothing rather than a stale node.
      await apply(diagram, move(diagram, 'Pay', 50, 110));

      expect({ inside, after, afterRebuild: index.findSemanticElement('alias-entry') }).toEqual({
         inside: { pay: true, entryBeforeCopy: true, entryAfterCopy: true },
         after: { pay: true, entry: true },
         afterRebuild: undefined
      });
   });

   it('names a reference from a copy source as the built nodes would, and points it at the copy', async () => {
      const opened = await openDiagram();
      const { diagram, layoutUri } = opened;
      // The built entry outside an operation, the copy of it inside one.
      const payEntry = (): DiagramNode =>
         (diagram.state.workingRootOf(layoutUri) as LayoutModel).nodes.find(node => node.flowNode.$refText === 'Pay')!;
      const builtPay = builtProcessRoot(opened).nodes.find(node => node.name === 'Pay')!;
      const builder = diagram.state.languageServicesFor(payEntry())!.references.ReferenceBuilder;
      const expected = builder.getReferenceName(builtPay, payEntry());

      const observed = await insideOperation(diagram, () => {
         const copyPay = diagram.state.sourceRoot.nodes.find(node => node.name === 'Pay')!;
         const reference = diagram.state.referenceTo(copyPay, payEntry());
         return { refText: reference?.$refText, toCopy: reference?.ref === copyPay, isCopy: copyPay !== builtPay };
      });

      expect({ expected: expected !== undefined, observed }).toEqual({
         expected: true,
         observed: { refText: expected, toCopy: true, isCopy: true }
      });
   });

   it('answers a scope lookup for the built node a copy node was made from', async () => {
      const opened = await openDiagram();
      const { diagram } = opened;
      const names = (transition: Transition): string[] =>
         [
            ...(diagram.state
               .scopeProviderFor(transition)
               ?.getScope({ container: transition, property: 'target', reference: transition.target })
               .getAllElements() ?? [])
         ].map(description => description.name);
      const built = builtProcessRoot(opened).transitions[0];

      const viaBuilt = await insideOperation(diagram, () => {
         const copy = diagram.state.sourceRoot.transitions[0];
         return { copy: copy !== built, same: diagram.state.builtNodeOf(copy) === built, names: names(diagram.state.builtNodeOf(copy)) };
      });

      expect(viaBuilt).toEqual({ copy: true, same: true, names: names(built) });
   });

   it('keeps the root an operation captured over an older one the storage settled meanwhile', async () => {
      const opened = await openDiagram();
      const { services, diagram, processUri } = opened;
      const models = services.shared.model.ModelService;
      const older = await models.settled(processUri);
      const settle = gate();
      vi.spyOn(models, 'settled').mockImplementationOnce(async () => {
         await settle.promise;
         return older;
      });
      const storage = diagram.sessionContainer.get<SourceModelStorage>(SourceModelStorage) as unknown as {
         captureAndSubmit(rootUri: string, root: AstNode): Promise<Action[]>;
      };
      const captured = vi.spyOn(storage, 'captureAndSubmit');

      flushResubmit(diagram);
      await apply(diagram, createTask());
      settle.open();
      await waitFor(() => captured.mock.results.length > 0, { message: 'the resubmit never captured' });
      await captured.mock.results[0].value;

      expect(diagram.state.sourceRoot.nodes.map(node => node.name)).toContain('NewTask');
   });

   it('does not hold the boundary while the storage waits for the document to settle', async () => {
      const opened = await openDiagram();
      const { services, diagram } = opened;
      const models = services.shared.model.ModelService;
      const settled = models.settled.bind(models);
      const settle = gate();
      vi.spyOn(models, 'settled').mockImplementationOnce(async uri => {
         await settle.promise;
         return settled(uri);
      });

      flushResubmit(diagram);
      const exclusive = await Promise.race([
         diagram.state.runExclusive(() => 'ran'),
         new Promise<string>(resolve => setTimeout(() => resolve('blocked'), 500))
      ]);
      settle.open();

      expect(exclusive).toBe('ran');
   });
});
