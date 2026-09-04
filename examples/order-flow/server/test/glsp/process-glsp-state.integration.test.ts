/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * The CONFLICT half of the GLSP write path, over TWO real documents and a real
 * version gate: a foreign write lands between the diagram's baseline and its
 * save, and `reconcileSourceModelWrite` decides what happens to the user's edit.
 *
 * **Why this is not the framework's own unit test over again.** Those drive the
 * four outcomes by making a fake `ModelService.update` throw, which settles what
 * each branch DOES. What a stub cannot show is that the gate ever ARMS in a real
 * head: the based-on version travels from `setSourceRoot` through the recording
 * command's capture into `ModelService.update`, and one stale link anywhere
 * along that chain turns every conflict into an ordinary write that silently
 * clobbers the other writer, with no error to show for it.
 *
 * **The race is time-bounded in production, and these tests reproduce it as
 * such.** `HydraniumGlspStorage` reacts to a foreign rebuild by re-capturing the
 * source root, which re-reads the version and disarms the gate — after a 250ms
 * trailing debounce. A conflict is therefore only reachable inside that window,
 * which is precisely the window a user's drag lands in. Each test asserts the
 * gate is still armed (the state's captured version is older than the
 * document's) immediately before dispatching, so losing the race fails AS a lost
 * race instead of quietly asserting on an ordinary write.
 *
 * **The outcomes are asserted on the FILES**, both of them, because that is
 * where the difference between the branches is visible and where an adopter's
 * user sees it: a dropped edit leaves the foreign text standing in the
 * `.process` file AND leaves the `.layout` file untouched, while a merge leaves
 * both intents in both files. Asserting the pair is what pins
 * `OrderFlowGlspState.persist` writing the PRIMARY first: the gated document
 * throws before any secondary write, so a dropped edit cannot leave the layout
 * file half-edited.
 *
 * Two of the four branches are NOT reachable from here, and that is structural
 * rather than an omission:
 * - `no-op` needs an empty baseline→attempted patch, but
 *   `ReconcilingMultiDocumentGlspState.persist` skips the gated primary write
 *   entirely when the primary projection is unchanged, so no conflict can be
 *   raised for an edit that changed nothing.
 * - `unavailable` needs the refetch to produce nothing, which over a real
 *   `ModelService` means an unreadable primary — a stub's scenario.
 *
 * The workspace is a scratch copy: this suite writes, and a rebuild runs the
 * integrity rules, whose default silent mode persists repairs to disk.
 */

import 'reflect-metadata';
import { type Action, CreateNodeOperation, DeleteElementOperation, ServerModule, SetDirtyStateAction } from '@eclipse-glsp/server';
import { HydraniumGlspAppModule } from '@hydranium/glsp-server';
import { type GlspHarness, makeGlspHarness } from '@hydranium/glsp-server/testing';
import type { ScratchWorkspace } from '@hydranium/core/testing/node';
import { waitFor } from '@hydranium/protocol/testing';
import { URI } from '@hydranium/langium';
import { afterEach, describe, expect, it } from 'vitest';
import { OrderFlowProcessDiagramModule } from '../../src/glsp/order-flow-process-diagram-module.js';
import { type OrderFlowGlspState } from '../../src/glsp/order-flow-glsp-state.js';
import { PROCESS_TASK_NODE_TYPE } from '../../src/glsp/order-flow-process-diagram-types.js';
import { type ProcessModel, isRead, isTask } from '../../src/language-server/ast.js';
import { WORKSPACE_FILES, makeScratchWorkspaceHarness } from '../order-flow-harness.js';

const DIAGRAM_TYPE = 'order-flow-process';

interface OpenDiagram {
   readonly harness: GlspHarness<OrderFlowGlspState>;
   readonly root: () => ProcessModel;
   /** Text of the `.process` primary. */
   readonly text: () => string;
   /** Text of the `.layout` secondary, or `undefined` while it does not exist. */
   readonly layoutText: () => string | undefined;
   /** Version the `.process` text document currently carries. */
   readonly documentVersion: () => number;
   /**
    * Write the `.process` file as ANOTHER client would — a text editor saving
    * over the document the diagram has open. Bumps the document's version, which
    * is what leaves the diagram's captured based-on version stale and the
    * conflict gate armed.
    */
   readonly foreignWrite: (text: string) => Promise<void>;
   /**
    * Dispatch an operation and wait for the submission THIS operation produced.
    *
    * Not `nextModelSubmission()`, and the difference matters here: the foreign
    * write fans out its own debounced external resubmit, which publishes a model
    * too, so "the next submission" can be the other writer's and the assertions
    * would then run while the operation is still in flight — a false green in
    * exactly the case (nothing changed on disk) this suite is about. The
    * dirty-state reason names the origin, so waiting for `'operation'` in the
    * tail of the captured actions settles on the right one.
    */
   readonly apply: (action: Action) => Promise<void>;
}

let open: OpenDiagram | undefined;
let scratch: ScratchWorkspace | undefined;

/** Boot the real GLSP container over a scratch workspace and open the diagram. */
async function openDiagram(): Promise<OpenDiagram> {
   const { harness: services, workspace } = await makeScratchWorkspaceHarness();
   scratch = workspace;
   const sourceUri = workspace.resolve(WORKSPACE_FILES.fulfillmentProcess);
   const rootUri = URI.file(sourceUri).toString();
   const harness = makeGlspHarness<OrderFlowGlspState>({
      serverModule: new ServerModule().configureDiagramModule(new OrderFlowProcessDiagramModule()),
      diagramType: DIAGRAM_TYPE,
      appModules: [new HydraniumGlspAppModule({ shared: services.shared })]
   });
   await harness.start();
   await harness.openDocument(sourceUri);

   const documents = services.shared.workspace.LangiumDocuments;
   const processDocument = (): { textDocument: { getText(): string; version: number } } => {
      const document = documents.getDocument(URI.file(sourceUri));
      if (!document) {
         throw new Error(`document not loaded: ${sourceUri}`);
      }
      return document;
   };

   open = {
      harness,
      root: () => harness.state.sourceRoot,
      text: () => processDocument().textDocument.getText(),
      layoutText: () => documents.getDocument(URI.parse(harness.state.layoutUri))?.textDocument.getText(),
      documentVersion: () => processDocument().textDocument.version,
      foreignWrite: async text => {
         await services.shared.model.ModelService.update({ uri: rootUri, model: text, clientId: 'text-editor' });
      },
      apply: async action => {
         const before = harness.actions.length;
         harness.dispatch(action);
         await waitFor(
            () => harness.actions.slice(before).some(candidate => SetDirtyStateAction.is(candidate) && candidate.reason === 'operation'),
            { message: `no 'operation' dirty state after ${action.kind} — the operation never completed` }
         );
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

/** The field a named task's first `reads` effect points at, read off the state's root. */
function readFieldOf(diagram: OpenDiagram, taskName: string): string | undefined {
   const task = diagram
      .root()
      .nodes.filter(isTask)
      .find(candidate => candidate.name === taskName);
   return task?.effects.filter(isRead)[0]?.field.$refText;
}

describe('order-flow .process glsp state — a foreign write between baseline and save', () => {
   afterEach(() => {
      open?.harness.dispose();
      open = undefined;
      scratch?.dispose();
      scratch = undefined;
   });

   it('drops the diagram edit, and the layout write with it, when the same node changed underneath', async () => {
      const diagram = await openDiagram();
      const pickId = idOf(diagram, 'Pick');
      // Both files start where the sample workspace put them, so neither
      // assertion below can pass by the value never having changed.
      expect(diagram.text()).toContain('task Pick reads Order.id');
      expect(diagram.layoutText()).toContain('node Pick at 440, 200');
      const capturedVersion = diagram.harness.state.version;

      // The other writer retargets the very effect the delete is about to
      // remove, so the user's `remove` op carries a `test` whose baseline value
      // no longer matches — a same-field collision rather than a benign drift.
      await diagram.foreignWrite(diagram.text().replace('task Pick reads Order.id', 'task Pick reads Order.status'));

      // The gate is ARMED: the diagram still holds the version it captured when
      // it opened, and the document has moved past it.
      expect(diagram.harness.state.version).toBe(capturedVersion);
      expect(diagram.documentVersion()).toBeGreaterThan(capturedVersion);

      await diagram.apply(DeleteElementOperation.create([pickId]));

      // `conflict`: the foreign edit stands and the delete is gone.
      expect(diagram.text()).toContain('task Pick reads Order.status');
      expect(diagram.text()).toContain('transition Pick -> Ship');
      // The layout secondary was never written either. That is the payoff of
      // `OrderFlowGlspState.persist` writing the primary FIRST: the gated
      // document throws before any secondary write, so the pair cannot end up
      // with the layout entry deleted for a flow node that still exists.
      expect(diagram.layoutText()).toContain('node Pick at 440, 200');
      // And the state resynced onto the foreign content instead of keeping the
      // orphaned root the handler mutated — which is what lets the user's next
      // operation be based on the truth.
      expect(diagram.root().nodes.map(node => node.name)).toEqual(['Pay', 'PaymentOk', 'Pick', 'Ship', 'Cancel']);
      expect(readFieldOf(diagram, 'Pick')).toBe('status');
   });

   it('merges the diagram edit into the foreign one when they touch different nodes', async () => {
      const diagram = await openDiagram();
      const capturedVersion = diagram.harness.state.version;

      // A task the diagram has never seen. The create it races against produces
      // only `add` ops, which carry no `test` guard, so the user's intent replays
      // on top of the refetched state instead of colliding with it.
      await diagram.foreignWrite(
         diagram.text().replace('   transition Pay -> PaymentOk', '   task Refund reads Order.id\n   transition Pay -> PaymentOk')
      );
      expect(diagram.text()).toContain('task Refund reads Order.id');
      expect(diagram.harness.state.version).toBe(capturedVersion);
      expect(diagram.documentVersion()).toBeGreaterThan(capturedVersion);

      await diagram.apply(CreateNodeOperation.create(PROCESS_TASK_NODE_TYPE, { location: { x: 320, y: 480 } }));

      // `merged`: the re-persist is built from the REFETCHED document, so the
      // foreign task survives a write the diagram authored without ever having
      // seen it. Clobbering it is what an unarmed gate looks like from here.
      expect(diagram.text()).toContain('task Refund');
      expect(diagram.text()).toContain('task NewTask');
      expect(readFieldOf(diagram, 'Refund')).toBe('id');
      const names = diagram.root().nodes.map(node => node.name);
      expect(names).toContain('Refund');
      expect(names).toContain('NewTask');
      expect(names).toHaveLength(7);
      // The layout secondary landed too, in the same `persist` call that
      // re-persisted the merged primary — a merge writes the whole set, not just
      // the document the gate guarded.
      expect(diagram.layoutText()).toContain('node NewTask at 320, 480');
   });
});
