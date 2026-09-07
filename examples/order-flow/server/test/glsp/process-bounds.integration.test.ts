/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * `ChangeBoundsOperation` against the real DI container — the operation a
 * graphical adopter leans on for every move and resize, and the reason the
 * `.layout` grammar exists at all: without somewhere to persist bounds a drag
 * has nowhere to land.
 *
 * Kept apart from `process-operations.integration.test.ts` because the seam is
 * different in kind: those operations change the semantic model, these change
 * only where it is drawn, and the whole point of the separate layout model is
 * that the two do not mix.
 *
 * Every assertion goes through the real write path — a recording command derives
 * a patch from the transfer projection, the reconciling state persists it via
 * `ModelService.update`, and the document is re-parsed — so the serialized text
 * is checked alongside the AST. A layout mutation the serializer could not
 * express would fail here rather than at runtime.
 */

import 'reflect-metadata';
import { type Action, ChangeBoundsOperation, ComputedBoundsAction, DeleteElementOperation, ServerModule } from '@eclipse-glsp/server';
import { HydraniumGlspAppModule } from '@hydranium/glsp-server';
import { type GlspHarness, makeGlspHarness } from '@hydranium/glsp-server/testing';
import type { ScratchWorkspace } from '@hydranium/core/testing/node';
import { URI } from '@hydranium/langium';
import { afterEach, describe, expect, it } from 'vitest';
import { OrderFlowProcessDiagramModule } from '../../src/glsp/order-flow-process-diagram-module.js';
import { type OrderFlowGlspState } from '../../src/glsp/order-flow-glsp-state.js';
import { type DiagramNode, type ProcessModel, isTask } from '../../src/language-server/ast.js';
import { WORKSPACE_FILES, makeScratchWorkspaceHarness } from '../order-flow-harness.js';

const DIAGRAM_TYPE = 'order-flow-process';

interface OpenDiagram {
   readonly harness: GlspHarness<OrderFlowGlspState>;
   readonly root: () => ProcessModel;
   /** Text of the `.process` primary. */
   readonly text: () => string;
   /** Text of the `.layout` secondary, or `undefined` while it does not exist. */
   readonly layoutText: () => string | undefined;
   readonly apply: (action: Action) => Promise<void>;
   readonly expectRejected: (action: Action) => Promise<void>;
}

let open: OpenDiagram | undefined;
let scratch: ScratchWorkspace | undefined;

/** Boot the real GLSP container over a scratch copy and open one `.process` file. */
async function openDiagram(relativePath: string): Promise<OpenDiagram> {
   const { harness: services, workspace } = await makeScratchWorkspaceHarness();
   scratch = workspace;
   const sourceUri = workspace.resolve(relativePath);
   const harness = makeGlspHarness<OrderFlowGlspState>({
      serverModule: new ServerModule().configureDiagramModule(new OrderFlowProcessDiagramModule()),
      diagramType: DIAGRAM_TYPE,
      appModules: [new HydraniumGlspAppModule({ shared: services.shared })]
   });
   await harness.start();
   await harness.openDocument(sourceUri);

   const documents = services.shared.workspace.LangiumDocuments;
   open = {
      harness,
      root: () => harness.state.sourceRoot,
      text: () => {
         const document = documents.getDocument(URI.file(sourceUri));
         if (!document) {
            throw new Error(`document not loaded: ${sourceUri}`);
         }
         return document.textDocument.getText();
      },
      // Not an error when absent: a process with no `.layout` beside it is a
      // valid state, and one of the checks below is precisely that the first
      // drag CREATES the file.
      layoutText: () => documents.getDocument(URI.parse(harness.state.layoutUri))?.textDocument.getText(),
      apply: async action => {
         harness.dispatch(action);
         await harness.nextModelSubmission();
      },
      expectRejected: async action => {
         harness.dispatch(action);
         expect(await harness.nextModelSubmission({ timeoutMs: 250, rejectOnTimeout: false })).toBeUndefined();
      }
   };
   return open;
}

/** The id the server emitted for a flow node, via the real index. */
function idOf(diagram: OpenDiagram, name: string): string {
   const node = diagram.root().nodes.find(candidate => candidate.name === name);
   if (!node) {
      throw new Error(`no flow node named ${name}`);
   }
   return diagram.harness.state.index.createId(node);
}

/**
 * The layout entry for a flow node, by the name its reference carries. Reads the
 * `.layout` SECONDARY through the state, not the process root.
 */
function layoutFor(diagram: OpenDiagram, name: string): DiagramNode | undefined {
   return diagram.harness.state.layoutRoot.nodes.find(node => node.flowNode.$refText === name);
}

describe('order-flow .process change-bounds', () => {
   afterEach(() => {
      open?.harness.dispose();
      open = undefined;
      scratch?.dispose();
      scratch = undefined;
   });

   it('persists a move into the layout file, leaving the process file untouched', async () => {
      const diagram = await openDiagram(WORKSPACE_FILES.fulfillmentProcess);
      // Control: the entry starts where the sample workspace put it, so the
      // assertion below cannot pass by the value never changing.
      expect(layoutFor(diagram, 'Pay')).toMatchObject({ x: 40, y: 100 });
      const processBefore = diagram.text();

      await diagram.apply(
         ChangeBoundsOperation.create([
            { elementId: idOf(diagram, 'Pay'), newPosition: { x: 300, y: 220 }, newSize: { width: 200, height: 80 } }
         ])
      );

      expect(layoutFor(diagram, 'Pay')).toMatchObject({ x: 300, y: 220, width: 200, height: 80 });
      // The bounds landed in the SECONDARY document, which is the whole point of
      // the split: layout churn stays out of the semantic file.
      expect(diagram.layoutText()).toContain('node Pay at 300, 220 size 200, 80');
      expect(diagram.text()).toBe(processBefore);
      expect(diagram.text()).not.toContain('node Pay');
      // And the semantics are unchanged.
      expect(diagram.root().nodes.map(node => node.name)).toEqual(['Pay', 'PaymentOk', 'Pick', 'Ship', 'Cancel']);
   });

   it('appends an entry for a flow node that had none', async () => {
      const diagram = await openDiagram(WORKSPACE_FILES.fulfillmentProcess);
      // `Cancel` is deliberately unpositioned in the sample workspace.
      expect(layoutFor(diagram, 'Cancel')).toBeUndefined();

      await diagram.apply(
         ChangeBoundsOperation.create([
            { elementId: idOf(diagram, 'Cancel'), newPosition: { x: 700, y: 160 }, newSize: { width: 160, height: 60 } }
         ])
      );

      expect(layoutFor(diagram, 'Cancel')).toMatchObject({ x: 700, y: 160, width: 160, height: 60 });
      expect(diagram.layoutText()).toContain('node Cancel at 700, 160 size 160, 60');
   });

   it('CREATES the layout file for a process that has none', async () => {
      // `returns.process` has no `.layout` beside it, which is the state of
      // every hand-authored process before it is first opened in the editor.
      // This is the case that would silently drop the drag if the state did not
      // materialise an empty layout root: with nothing to mutate, the before and
      // after projections would both be absent and the patch would be empty.
      const diagram = await openDiagram(WORKSPACE_FILES.returnsProcess);
      expect(diagram.layoutText()).toBeUndefined();
      expect(diagram.harness.state.layoutRoot.nodes).toEqual([]);

      await diagram.apply(
         ChangeBoundsOperation.create([
            { elementId: idOf(diagram, 'Receive'), newPosition: { x: 20, y: 20 }, newSize: { width: 140, height: 50 } }
         ])
      );

      // `ModelService.update` is an upsert, so the write created the document.
      const layout = diagram.layoutText();
      expect(layout).toBeDefined();
      expect(layout).toContain('layout ReturnsLayout for Returns');
      expect(layout).toContain('node Receive at 20, 20 size 140, 50');
      expect(diagram.harness.state.layoutRoot.nodes).toHaveLength(1);
   });

   it('keeps the existing position when a resize sends none', async () => {
      const diagram = await openDiagram(WORKSPACE_FILES.fulfillmentProcess);

      // `ElementAndBounds.newPosition` is optional while `newSize` is required,
      // so a pure resize genuinely arrives with no position — this is the wire
      // shape, not a contrived one.
      await diagram.apply(ChangeBoundsOperation.create([{ elementId: idOf(diagram, 'Pick'), newSize: { width: 240, height: 90 } }]));

      expect(layoutFor(diagram, 'Pick')).toMatchObject({ x: 440, y: 200, width: 240, height: 90 });
   });

   it('takes the position from the measured GModel when resizing a node that has no entry', async () => {
      // The test above cannot reach this path — `Pick` already has an entry, so
      // its position survives simply by not being written, and removing the
      // fallback leaves that test green. Reaching the fallback needs a node with
      // NO entry, and a GModel position that is not the builder default.
      const diagram = await openDiagram(WORKSPACE_FILES.fulfillmentProcess);
      const cancelId = idOf(diagram, 'Cancel');
      expect(layoutFor(diagram, 'Cancel')).toBeUndefined();

      // The client's measurement pass. This is what the framework's rebound
      // computed-bounds handler applies to the server-side GModel, and it is
      // emphatically NOT persistence: measured bounds are transient, and only a
      // `ChangeBoundsOperation` writes a layout entry.
      diagram.harness.dispatch(
         ComputedBoundsAction.create([{ elementId: cancelId, newPosition: { x: 640, y: 300 }, newSize: { width: 150, height: 55 } }], {
            // The handler compares against the GMODEL root's revision, not the
            // document version — a mismatch is dropped with a warning rather
            // than applied, so getting this wrong would look like a silent no-op.
            revision: diagram.harness.state.root.revision
         })
      );
      await diagram.harness.nextModelSubmission();
      // Control, and the whole point: measuring changed the GModel and left the
      // document alone.
      expect(layoutFor(diagram, 'Cancel')).toBeUndefined();
      expect(diagram.layoutText()).not.toContain('node Cancel');

      // A GENUINE resize — a size the client is not already rendering. Sending
      // back the measured 150×55 would be indistinguishable from a move, since
      // `ElementAndBounds.newSize` is required by the protocol and every move
      // carries the size the client currently draws; the handler treats that as
      // "no resize" on purpose.
      await diagram.apply(ChangeBoundsOperation.create([{ elementId: cancelId, newSize: { width: 200, height: 80 } }]));

      expect(layoutFor(diagram, 'Cancel')).toMatchObject({ x: 640, y: 300, width: 200, height: 80 });
   });

   it('persists a move without inventing a size the user never chose', async () => {
      // Writing the size back on a move grows the node on every drag. `newSize`
      // is REQUIRED on `ElementAndBounds`, so a move carries the size the client
      // is rendering; persisting it treats a measurement as an authored choice.
      // While a node's children are unlaid-out that measured size is the
      // `getBBox()` union of the shape AND the labels sitting outside it, so each
      // move persists a box bigger than the node, which then renders bigger and
      // measures bigger again — an unbounded ratchet from a move.
      const diagram = await openDiagram(WORKSPACE_FILES.fulfillmentProcess);
      const cancelId = idOf(diagram, 'Cancel');

      diagram.harness.dispatch(
         ComputedBoundsAction.create([{ elementId: cancelId, newPosition: { x: 640, y: 300 }, newSize: { width: 150, height: 55 } }], {
            revision: diagram.harness.state.root.revision
         })
      );
      await diagram.harness.nextModelSubmission();

      // A move: a new position, carrying the size the client already renders.
      await diagram.apply(
         ChangeBoundsOperation.create([{ elementId: cancelId, newPosition: { x: 700, y: 320 }, newSize: { width: 150, height: 55 } }])
      );

      const entry = layoutFor(diagram, 'Cancel');
      expect(entry).toMatchObject({ x: 700, y: 320 });
      // Absolute, not a delta: the node must be left UNSIZED, so it keeps
      // fitting its content until someone actually resizes it.
      expect(entry?.width).toBeUndefined();
      expect(entry?.height).toBeUndefined();
      // Scoped to Cancel's own line, and the fixture is why: `PaymentOk` carries
      // a position with no size of its own, so a file-wide "contains no size"
      // is satisfied by that entry alone and says nothing about this write.
      // Anchoring at end-of-line is what makes the ABSENCE of a size clause the
      // assertion.
      expect(diagram.layoutText()).toMatch(/node Cancel at 700, 320\s*$/m);
   });

   it('rounds sub-pixel bounds rather than persisting the raw float', async () => {
      const diagram = await openDiagram(WORKSPACE_FILES.fulfillmentProcess);

      await diagram.apply(
         ChangeBoundsOperation.create([
            {
               elementId: idOf(diagram, 'Ship'),
               newPosition: { x: 100.00000000000001, y: 33.333333 },
               newSize: { width: 160.5, height: 60.987 }
            }
         ])
      );

      // Client-measured bounds are floats; persisting them raw would make every
      // drag a diff full of noise. The AST keeps what arrived, the TEXT is what
      // gets rounded, because that is what churns a file.
      expect(diagram.layoutText()).toContain('node Ship at 100, 33.33 size 160.5, 60.99');
   });

   it('ignores an element with no persistable bounds instead of failing the batch', async () => {
      const diagram = await openDiagram(WORKSPACE_FILES.fulfillmentProcess);
      const effect = diagram
         .root()
         .nodes.filter(isTask)
         .flatMap(task => task.effects)[0];
      const effectLabelId = diagram.harness.state.index.createId(effect);

      // An effect label is laid out by its parent task and has no bounds of its
      // own. Addressing it alone must be rejected cleanly — no command, so no
      // submission and no dirty state.
      await diagram.expectRejected(ChangeBoundsOperation.create([{ elementId: effectLabelId, newSize: { width: 10, height: 10 } }]));
      expect(diagram.layoutText()).toContain('node Pay at 40, 100');

      // The counterweight, and it is load-bearing: this test asserts the
      // ABSENCE of a submission, and absence is also what an unregistered
      // handler produces — unbinding it leaves the assertion above passing. So
      // the test has to prove in the same breath that the handler is live, or it
      // is a green light for the one composition mistake it looks like it would
      // catch.
      await diagram.apply(
         ChangeBoundsOperation.create([
            { elementId: idOf(diagram, 'Pay'), newPosition: { x: 12, y: 34 }, newSize: { width: 56, height: 78 } }
         ])
      );
      expect(layoutFor(diagram, 'Pay')).toMatchObject({ x: 12, y: 34 });
   });

   it('applies the resolvable entries of a mixed batch', async () => {
      const diagram = await openDiagram(WORKSPACE_FILES.fulfillmentProcess);

      // Dragging a selection sends one entry per element, so a batch mixing a
      // flow node with something unpositionable is the normal case, not an edge
      // case — failing it wholesale would break multi-select drag.
      await diagram.apply(
         ChangeBoundsOperation.create([
            { elementId: 'no-such-element', newSize: { width: 10, height: 10 } },
            { elementId: idOf(diagram, 'Pay'), newPosition: { x: 11, y: 22 }, newSize: { width: 33, height: 44 } }
         ])
      );

      expect(layoutFor(diagram, 'Pay')).toMatchObject({ x: 11, y: 22, width: 33, height: 44 });
   });

   it('drops the layout entry when its flow node is deleted', async () => {
      const diagram = await openDiagram(WORKSPACE_FILES.fulfillmentProcess);
      expect(layoutFor(diagram, 'Ship')).toBeDefined();

      await diagram.apply(DeleteElementOperation.create([idOf(diagram, 'Ship')]));

      // Otherwise `node Ship at 660, 200` outlives `Ship` and dangles exactly
      // like an orphaned transition would.
      expect(layoutFor(diagram, 'Ship')).toBeUndefined();
      expect(diagram.text()).not.toContain('node Ship');
   });
});
