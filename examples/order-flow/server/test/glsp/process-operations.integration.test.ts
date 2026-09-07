/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * The `.process` operation handlers, driven through the **real DI container**
 * over `makeGlspHarness`, the framework's in-process GLSP harness.
 *
 * **Why not unit-test the handlers directly.** Half of what a diagram module can
 * get wrong is composition, not logic: a handler that is never registered, a type
 * hint with no matching handler, or a `binding.rebind` that silently appends.
 * A handler instantiated by hand in a test passes all of those. So the
 * operations here go in as client actions and the assertions read the resulting
 * `.process` AST and the text the serializer produces from it.
 *
 * Every assertion is on state, not on dispatch: nothing here checks that a
 * command ran, only that the document afterwards says what it should. The
 * write path is genuine — a recording command derives a patch from the transfer
 * projection, `ReconcilingMultiDocumentGlspState.updateSourceModel` persists it
 * through `ModelService.update`, and the document is re-parsed. So a mutation
 * the serializer cannot express fails here rather than at runtime.
 *
 * The workspace is a scratch copy: rebuilds run the integrity rules, whose
 * default silent mode writes repairs to disk.
 */

import 'reflect-metadata';
import {
   type Action,
   ApplyLabelEditOperation,
   CreateEdgeOperation,
   CreateNodeOperation,
   DeleteElementOperation,
   ServerModule
} from '@eclipse-glsp/server';
import { HydraniumGlspAppModule } from '@hydranium/glsp-server';
import { type GlspHarness, makeGlspHarness } from '@hydranium/glsp-server/testing';
import type { ScratchWorkspace } from '@hydranium/core/testing/node';
import { URI } from '@hydranium/langium';
import { afterEach, describe, expect, it } from 'vitest';
import { OrderFlowProcessDiagramModule } from '../../src/glsp/order-flow-process-diagram-module.js';
import { type OrderFlowGlspState } from '../../src/glsp/order-flow-glsp-state.js';
import {
   PROCESS_EFFECT_TYPE,
   PROCESS_GATEWAY_NODE_TYPE,
   PROCESS_TASK_NODE_TYPE,
   PROCESS_TRANSITION_EDGE_TYPE
} from '../../src/glsp/order-flow-process-diagram-types.js';
import { type Gateway, type ProcessModel, isGateway, isTask } from '../../src/language-server/ast.js';
import { makeScratchWorkspaceHarness } from '../order-flow-harness.js';

const DIAGRAM_TYPE = 'order-flow-process';
const PROCESS_FILE = 'orders/fulfillment.process';

interface OpenDiagram {
   readonly harness: GlspHarness<OrderFlowGlspState>;
   readonly root: () => ProcessModel;
   readonly text: () => string;
   /** Text of the `.layout` secondary, or `undefined` while it does not exist. */
   readonly layoutText: () => string | undefined;
   /** Apply an operation and wait for the model the server re-submits. */
   readonly apply: (action: Action) => Promise<void>;
   /**
    * Dispatch an operation expected to be REJECTED, and assert nothing was
    * submitted. A rejected operation produces no action at all, so absence is
    * the only observable; the short timeout keeps the passing case quick.
    *
    * **Every caller must also prove the handler is live**, in the same test.
    * Absence is equally what an UNREGISTERED handler produces, so on its own
    * this assertion cannot distinguish "declined correctly" from "never wired
    * up" — which is the one composition mistake it looks like it would catch.
    * Unbinding a handler leaves a lone `expectRejected` passing. Follow each with
    * an `apply` of the valid equivalent.
    */
   readonly expectRejected: (action: Action) => Promise<void>;
}

let open: OpenDiagram | undefined;
let scratch: ScratchWorkspace | undefined;

/** Boot the real GLSP container over a scratch workspace and open the diagram. */
async function openDiagram(): Promise<OpenDiagram> {
   const { harness: services, workspace } = await makeScratchWorkspaceHarness();
   scratch = workspace;
   const sourceUri = workspace.resolve(PROCESS_FILE);
   const harness = makeGlspHarness<OrderFlowGlspState>({
      serverModule: new ServerModule().configureDiagramModule(new OrderFlowProcessDiagramModule()),
      diagramType: DIAGRAM_TYPE,
      appModules: [new HydraniumGlspAppModule({ shared: services.shared })]
   });
   await harness.start();
   await harness.openDocument(sourceUri);

   const documents = services.shared.workspace.LangiumDocuments;
   const textDocumentOf = (): string => {
      const document = documents.getDocument(URI.file(sourceUri));
      if (!document) {
         throw new Error(`document not loaded: ${sourceUri}`);
      }
      return document.textDocument.getText();
   };

   open = {
      harness,
      root: () => harness.state.sourceRoot,
      text: textDocumentOf,
      layoutText: () => documents.getDocument(URI.parse(harness.state.layoutUri))?.textDocument.getText(),
      apply: async action => {
         harness.dispatch(action);
         await harness.nextModelSubmission();
      },
      expectRejected: async action => {
         harness.dispatch(action);
         const submission = await harness.nextModelSubmission({ timeoutMs: 250, rejectOnTimeout: false });
         expect(submission).toBeUndefined();
      }
   };
   return open;
}

const flowNodeNames = (root: ProcessModel): string[] => root.nodes.map(node => node.name);
const transitionPairs = (root: ProcessModel): string[][] =>
   root.transitions.map(transition => [transition.source.$refText, transition.target.$refText]);

/** The id the server emitted for a flow node, via the real index. */
function idOf(diagram: OpenDiagram, name: string): string {
   const node = diagram.root().nodes.find(candidate => candidate.name === name);
   if (!node) {
      throw new Error(`no flow node named ${name}`);
   }
   return diagram.harness.state.index.createId(node);
}

describe('order-flow .process operations', () => {
   afterEach(() => {
      open?.harness.dispose();
      open = undefined;
      scratch?.dispose();
      scratch = undefined;
   });

   it('creates a task with a name unique across both flow-node kinds', async () => {
      const diagram = await openDiagram();
      const before = flowNodeNames(diagram.root());

      await diagram.apply(CreateNodeOperation.create(PROCESS_TASK_NODE_TYPE));

      const after = flowNodeNames(diagram.root());
      expect(after).toHaveLength(before.length + 1);
      const created = after.filter(name => !before.includes(name));
      expect(created).toEqual(['NewTask']);
      // The document really was rewritten through the serializer, not just the
      // in-memory AST: a task the serializer could not emit would be absent.
      expect(diagram.text()).toContain('task NewTask');
   });

   it('writes BOTH documents when a node is dropped on the canvas', async () => {
      // The multi-document write, end to end through the real container: one
      // operation, one recording command, one patch spanning two files. This is
      // what `ReconcilingMultiDocumentGlspState` exists for, and what a
      // single-document state cannot express at all.
      const diagram = await openDiagram();
      const processBefore = diagram.text();
      const layoutBefore = diagram.layoutText();

      await diagram.apply(CreateNodeOperation.create(PROCESS_TASK_NODE_TYPE, { location: { x: 320, y: 480 } }));

      // The semantics landed in the `.process` primary...
      expect(diagram.text()).not.toBe(processBefore);
      expect(diagram.text()).toContain('task NewTask');
      // ...and the drop point landed in the `.layout` secondary, in the same
      // operation. Asserting the coordinates rather than merely "the file
      // changed" is what shows the location survived rather than being defaulted.
      expect(diagram.layoutText()).not.toBe(layoutBefore);
      expect(diagram.layoutText()).toContain('node NewTask at 320, 480');

      // The layout entry resolves BACK across the document boundary. Without the
      // write order (semantics first) this reference would have been written
      // against a node that did not exist yet.
      const entry = diagram.harness.state.layoutRoot.nodes.find(node => node.flowNode.$refText === 'NewTask');
      expect(entry?.flowNode.ref).toBeDefined();
      expect(entry?.flowNode.ref?.name).toBe('NewTask');
      // And `size` is absent: the client has not measured the node yet, which is
      // the state the grammar's optional `size` group exists for.
      expect(entry?.width).toBeUndefined();
   });

   it('creates a node without layout when the drop carries no location', async () => {
      // The control on the test above: position is a set, not a requirement, so
      // an operation with no location still creates the node and simply leaves it
      // to client layout. Without this, "writes both documents" could be read as
      // "always writes both".
      const diagram = await openDiagram();
      const layoutBefore = diagram.layoutText();

      await diagram.apply(CreateNodeOperation.create(PROCESS_TASK_NODE_TYPE));

      expect(diagram.text()).toContain('task NewTask');
      expect(diagram.layoutText()).toBe(layoutBefore);
   });

   it('creates a gateway, and a second one does not reuse the first name', async () => {
      const diagram = await openDiagram();

      await diagram.apply(CreateNodeOperation.create(PROCESS_GATEWAY_NODE_TYPE));
      await diagram.apply(CreateNodeOperation.create(PROCESS_GATEWAY_NODE_TYPE));

      const gateways = diagram
         .root()
         .nodes.filter(isGateway)
         .map((gateway: Gateway) => gateway.name);
      expect(gateways).toContain('NewGateway');
      expect(gateways).toContain('NewGateway1');
      expect(new Set(gateways).size).toBe(gateways.length);
   });

   it('creates a transition between two existing flow nodes', async () => {
      const diagram = await openDiagram();
      const before = transitionPairs(diagram.root());

      await diagram.apply(
         CreateEdgeOperation.create({
            elementTypeId: PROCESS_TRANSITION_EDGE_TYPE,
            sourceElementId: idOf(diagram, 'Ship'),
            targetElementId: idOf(diagram, 'Cancel')
         })
      );

      expect(transitionPairs(diagram.root())).toEqual([...before, ['Ship', 'Cancel']]);
      expect(diagram.text()).toContain('transition Ship -> Cancel');
   });

   it('rejects a transition whose endpoint resolves to a non-flow-node', async () => {
      const diagram = await openDiagram();
      const before = transitionPairs(diagram.root());
      // An EFFECT id, not the effect compartment's. This distinction is the
      // point of the test: the compartment id is synthetic (`<task>_effects`),
      // so it never resolves and the handler would reject it without the
      // typeguard ever running. An effect's id is a real index id, so this is
      // the case that actually exercises `isFlowNode`.
      const pay = diagram
         .root()
         .nodes.filter(isTask)
         .find(task => task.name === 'Pay')!;
      const effectId = diagram.harness.state.index.createId(pay.effects[0]);
      expect(diagram.harness.state.index.findSemanticElement(effectId)).toBeDefined();

      await diagram.expectRejected(
         CreateEdgeOperation.create({
            elementTypeId: PROCESS_TRANSITION_EDGE_TYPE,
            sourceElementId: idOf(diagram, 'Pay'),
            targetElementId: effectId
         })
      );

      // Nothing was created, and specifically no transition with a blank
      // endpoint — which would serialize to `transition Pay -> ` and then fail
      // to re-parse.
      expect(transitionPairs(diagram.root())).toEqual(before);

      // Counterweight: the assertion above is an ABSENCE, and an unregistered
      // handler produces the same absence. So prove in the same test that the
      // handler is live and the rejection was a decision.
      await diagram.apply(
         CreateEdgeOperation.create({
            elementTypeId: PROCESS_TRANSITION_EDGE_TYPE,
            sourceElementId: idOf(diagram, 'Pay'),
            targetElementId: idOf(diagram, 'Cancel')
         })
      );
      expect(transitionPairs(diagram.root())).toContainEqual(['Pay', 'Cancel']);
   });

   it('rejects a transition whose endpoint id does not resolve at all', async () => {
      const diagram = await openDiagram();
      const before = transitionPairs(diagram.root());

      await diagram.expectRejected(
         CreateEdgeOperation.create({
            elementTypeId: PROCESS_TRANSITION_EDGE_TYPE,
            sourceElementId: idOf(diagram, 'Pay'),
            targetElementId: `${idOf(diagram, 'Pay')}_effects`
         })
      );

      expect(transitionPairs(diagram.root())).toEqual(before);

      // Counterweight, same reason as the test above: absence alone would also
      // be produced by an unregistered handler.
      await diagram.apply(
         CreateEdgeOperation.create({
            elementTypeId: PROCESS_TRANSITION_EDGE_TYPE,
            sourceElementId: idOf(diagram, 'Pay'),
            targetElementId: idOf(diagram, 'Cancel')
         })
      );
      expect(transitionPairs(diagram.root())).toContainEqual(['Pay', 'Cancel']);
   });

   it('deletes a flow node together with every transition and branch into it', async () => {
      const diagram = await openDiagram();
      // Control: Pick really is referenced from both a transition and a gateway
      // branch, so the cascade has something to do. Asserted rather than assumed
      // — a fixture without both would make the cascade check pass vacuously.
      expect(transitionPairs(diagram.root()).some(pair => pair.includes('Pick'))).toBe(true);
      const branchTargets = diagram
         .root()
         .nodes.filter(isGateway)
         .flatMap((gateway: Gateway) => gateway.branches.map(branch => branch.target.$refText));
      expect(branchTargets).toContain('Pick');

      await diagram.apply(DeleteElementOperation.create([idOf(diagram, 'Pick')]));

      const root = diagram.root();
      expect(flowNodeNames(root)).not.toContain('Pick');
      expect(transitionPairs(root).flat()).not.toContain('Pick');
      expect(
         root.nodes.filter(isGateway).flatMap((gateway: Gateway) => gateway.branches.map(branch => branch.target.$refText))
      ).not.toContain('Pick');
      // The written document must not keep a dangling reference either.
      expect(diagram.text()).not.toContain('Pick');
   });

   it('renames a flow node and carries its incoming references with it', async () => {
      const diagram = await openDiagram();
      expect(transitionPairs(diagram.root())).toContainEqual(['Pay', 'PaymentOk']);

      await diagram.apply(ApplyLabelEditOperation.create({ labelId: `${idOf(diagram, 'PaymentOk')}_name`, text: 'PaymentChecked' }));

      const root = diagram.root();
      expect(flowNodeNames(root)).toContain('PaymentChecked');
      expect(flowNodeNames(root)).not.toContain('PaymentOk');
      // The referring transition follows the rename. Without the reference
      // sweep this would still read `Pay -> PaymentOk` and dangle.
      expect(transitionPairs(root)).toContainEqual(['Pay', 'PaymentChecked']);
      expect(diagram.text()).toContain('transition Pay -> PaymentChecked');
      // The layout entry is a THIRD referring property, alongside transitions
      // and gateway branches — and it now lives in ANOTHER DOCUMENT, so a rename
      // is a two-document write. Asserted explicitly rather than left to the
      // blanket `not.toContain` below, because that would report a stale layout
      // entry as an unexplained failure somewhere in the document.
      expect(diagram.harness.state.layoutRoot.nodes.map(node => node.flowNode.$refText)).toContain('PaymentChecked');
      expect(diagram.layoutText()).toContain('node PaymentChecked at 260, 90');
      expect(diagram.text()).not.toContain('PaymentOk');
      // Both files are clean of the old name, which is what makes this a real
      // multi-document write rather than one that happened to update the AST.
      expect(diagram.layoutText()).not.toContain('PaymentOk');
   });

   it('adds a reads effect to a task, resolving against the process subject', async () => {
      const diagram = await openDiagram();
      const shipBefore = diagram
         .root()
         .nodes.filter(isTask)
         .find(task => task.name === 'Ship')!;
      const countBefore = shipBefore.effects.length;

      await diagram.apply(CreateNodeOperation.create(PROCESS_EFFECT_TYPE, { containerId: idOf(diagram, 'Ship') }));

      const ship = diagram
         .root()
         .nodes.filter(isTask)
         .find(task => task.name === 'Ship')!;
      expect(ship.effects).toHaveLength(countBefore + 1);
      const added = ship.effects[ship.effects.length - 1];
      // Points at the process subject and one of its real fields, so the effect
      // arrives resolvable rather than dangling.
      expect(added.entity.$refText).toBe('Order');
      expect(added.entity.ref).toBeDefined();
      expect(added.field.ref).toBeDefined();
      expect(diagram.text()).toContain(`reads Order.${added.field.$refText}`);
   });

   it('deletes a single effect without touching its task', async () => {
      const diagram = await openDiagram();
      const pay = diagram
         .root()
         .nodes.filter(isTask)
         .find(task => task.name === 'Pay')!;
      expect(pay.effects).toHaveLength(1);
      const effectId = diagram.harness.state.index.createId(pay.effects[0]);

      await diagram.apply(DeleteElementOperation.create([effectId]));

      const after = diagram
         .root()
         .nodes.filter(isTask)
         .find(task => task.name === 'Pay')!;
      expect(after.effects).toHaveLength(0);
      expect(flowNodeNames(diagram.root())).toContain('Pay');
      expect(diagram.text()).toContain('task Pay');
      expect(diagram.text()).not.toContain('writes Order.status = PAID');
   });
});
