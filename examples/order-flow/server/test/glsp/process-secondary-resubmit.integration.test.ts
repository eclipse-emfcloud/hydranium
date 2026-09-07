/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * The NOTIFICATION half of the multi-document GLSP flow: a diagram whose layout
 * lives in a SECONDARY document has to re-render when someone else edits that
 * document, and must NOT re-render for the write its own drag just authored.
 *
 * **Why this cannot be tested in the framework package.** The subscription is
 * reconciled against the state's secondary write set, and a state only has one
 * if it registers it. This is the only shape in the repo that does: the
 * `.process` primary with its sibling `.layout` file. Over a single-document
 * state the reconcile loops over an empty set and both assertions below are
 * vacuous.
 *
 * **The read path was never the problem, which is what makes the assertion
 * subtle.** `OrderFlowGlspState.layoutRoot` reads the layout document out of the
 * store on every access, so it reports the new position whether or not anything
 * re-rendered — asserting on it would pass in both states. The discriminating
 * observable is a model SUBMISSION reaching the client, so both tests count
 * published models and the first one reads the position out of the published
 * GModel rather than off the state.
 *
 * **The second test is the one that pins the trap.** A drag writes the layout
 * file as this client's own `changed` edit, and that write comes back through
 * the very subscription the first test adds. Without the authorship guard every
 * drag resubmits on top of the optimistic client-side move the user is still
 * holding — so the guard, not the subscription, is what makes the feature
 * usable. Its assertion is an ABSENCE, which nothing proves synchronously: it
 * takes an absolute count sampled before a wait longer than the storage's 250ms
 * trailing debounce.
 *
 * The workspace is a scratch copy, since these tests write.
 */

import 'reflect-metadata';
import {
   type Action,
   ChangeBoundsOperation,
   ComputedBoundsAction,
   ServerModule,
   SetDirtyStateAction,
   SetModelAction
} from '@eclipse-glsp/server';
import { HydraniumGlspAppModule } from '@hydranium/glsp-server';
import { type GlspHarness, MODEL_SUBMISSION_KINDS, makeGlspHarness } from '@hydranium/glsp-server/testing';
import type { ScratchWorkspace } from '@hydranium/core/testing/node';
import { tick, waitFor } from '@hydranium/protocol/testing';
import { URI } from '@hydranium/langium';
import { afterEach, describe, expect, it } from 'vitest';
import { OrderFlowProcessDiagramModule } from '../../src/glsp/order-flow-process-diagram-module.js';
import { type OrderFlowGlspState } from '../../src/glsp/order-flow-glsp-state.js';
import { type ProcessModel } from '../../src/language-server/ast.js';
import { WORKSPACE_FILES, makeScratchWorkspaceHarness } from '../order-flow-harness.js';

const DIAGRAM_TYPE = 'order-flow-process';

/** Comfortably past the storage's 250ms trailing resubmit debounce plus a round trip. */
const PAST_DEBOUNCE_MS = 900;

interface GModelNodeSchema {
   id: string;
   position?: { x: number; y: number };
   children?: GModelNodeSchema[];
}

interface OpenDiagram {
   readonly harness: GlspHarness<OrderFlowGlspState>;
   readonly root: () => ProcessModel;
   /** Text of the `.layout` secondary. */
   readonly layoutText: () => string;
   /**
    * Rewrite the `.layout` file as ANOTHER client would — a text editor saving
    * over the layout document while the diagram holds it as a secondary.
    */
   readonly foreignLayoutWrite: (text: string) => Promise<void>;
   /** Dispatch an operation and wait for the submission THAT operation produced. */
   readonly apply: (action: Action) => Promise<void>;
}

let open: OpenDiagram | undefined;
let scratch: ScratchWorkspace | undefined;

/**
 * Boot the real GLSP container over a scratch workspace and open the diagram.
 *
 * `preValidate` decides whether every document is driven to `Validated` first,
 * and the two settings exercise genuinely different machinery — see the comment
 * on the build call below. Default on; the drag-echo case needs it off.
 */
async function openDiagram({ preValidate = true }: { preValidate?: boolean } = {}): Promise<OpenDiagram> {
   const { harness: services, workspace } = await makeScratchWorkspaceHarness();
   scratch = workspace;
   const sourceUri = workspace.resolve(WORKSPACE_FILES.fulfillmentProcess);
   const harness = makeGlspHarness<OrderFlowGlspState>({
      serverModule: new ServerModule().configureDiagramModule(new OrderFlowProcessDiagramModule()),
      diagramType: DIAGRAM_TYPE,
      appModules: [new HydraniumGlspAppModule({ shared: services.shared })]
   });
   await harness.start();

   const documents = services.shared.workspace.LangiumDocuments;
   // Bring EVERY document fully to `Validated` BEFORE the diagram opens, and this
   // is what makes the fixture discriminating rather than merely realistic.
   // Langium's rebuild set is not limited to the changed document and the ones
   // affected by it: it also sweeps in every document still below `Validated` or
   // whose validation categories are incomplete. A process document left short of
   // that gets dragged into the layout file's build, reaches `Validated` there,
   // and fires the PRIMARY subscription — publishing a resubmit that has nothing
   // to do with the secondary write set. Measured: without this the layout-edit
   // assertion below passes with the secondary subscription deleted.
   //
   // Before the open, not after, because this build emits a `Validated` phase for
   // the layout document with no author, which the storage would rightly read as
   // a foreign edit and answer with a resubmit of its own.
   if (preValidate) {
      await services.shared.workspace.DocumentBuilder.build([...documents.all], { validation: true });
   }

   await harness.openDocument(sourceUri);
   // Complete the initial handshake the way a client does. This diagram is
   // client-laid-out, so opening it publishes a `RequestBoundsAction` and the
   // load stays PENDING until the measurement comes back — and while it is
   // pending the storage suppresses every external resubmit, to protect the
   // client's first computed bounds from a revision bump. Skipping this step
   // makes both assertions below vacuous rather than failing them: nothing
   // resubmits for any reason, so the second test would pass with the authorship
   // guard deleted.
   harness.dispatch(ComputedBoundsAction.create([], { revision: harness.state.root.revision }));
   await harness.nextAction(SetModelAction.KIND);

   open = {
      harness,
      root: () => harness.state.sourceRoot,
      layoutText: () => {
         const document = documents.getDocument(URI.parse(harness.state.layoutUri));
         if (!document) {
            throw new Error(`layout document not loaded: ${harness.state.layoutUri}`);
         }
         return document.textDocument.getText();
      },
      foreignLayoutWrite: async text => {
         // Open as that client FIRST, which is also what a real text editor does
         // before it edits. `update` is an upsert: writing a document no client
         // holds open seeds a fresh registration WITH the new text, so the update
         // that follows reports "content unchanged", never rebuilds, and emits no
         // event — a fixture that cannot exercise the subscription at all.
         await services.shared.model.ModelService.open({ uri: harness.state.layoutUri, clientId: 'text-editor' });
         await services.shared.model.ModelService.update({ uri: harness.state.layoutUri, model: text, clientId: 'text-editor' });
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

/**
 * Models published after index `from` in the captured action log. Sliced from an
 * explicit marker rather than taken from the harness's `nextModelSubmission`,
 * because opening the diagram already published one and the assertions here are
 * about what arrived AFTER a specific write.
 */
function submissionsSince(diagram: OpenDiagram, from: number): Action[] {
   return diagram.harness.actions.slice(from).filter(action => MODEL_SUBMISSION_KINDS.includes(action.kind));
}

function hasNewRoot(action: Action): action is Action & { newRoot: GModelNodeSchema } {
   return 'newRoot' in action;
}

/** The position the published GModel gives `elementId`, searched depth-first. */
function publishedPosition(action: Action, elementId: string): { x: number; y: number } | undefined {
   if (!hasNewRoot(action)) {
      return undefined;
   }
   const find = (element: GModelNodeSchema): GModelNodeSchema | undefined => {
      if (element.id === elementId) {
         return element;
      }
      for (const child of element.children ?? []) {
         const hit = find(child);
         if (hit) {
            return hit;
         }
      }
      return undefined;
   };
   return find(action.newRoot)?.position;
}

describe('order-flow .process glsp storage — an edit to the layout SECONDARY', () => {
   afterEach(() => {
      open?.harness.dispose();
      open = undefined;
      scratch?.dispose();
      scratch = undefined;
   });

   it('re-renders the diagram when another client edits the layout file', async () => {
      const diagram = await openDiagram();
      const pickId = idOf(diagram, 'Pick');
      // The fixture's own value, so neither side of the assertion can pass by
      // the position never having differed.
      expect(diagram.layoutText()).toContain('node Pick at 440, 200');

      const before = diagram.harness.actions.length;
      await diagram.foreignLayoutWrite(diagram.layoutText().replace('node Pick at 440, 200', 'node Pick at 900, 640'));

      await waitFor(() => submissionsSince(diagram, before).length > 0, {
         timeoutMs: 3000,
         message: 'the layout edit published no model — the diagram never learned the secondary changed'
      });

      // Read off the PUBLISHED GModel, not off `state.layoutRoot`: the state
      // re-reads the document on every access and would report the new position
      // even if nothing had been submitted.
      const published = submissionsSince(diagram, before).at(-1);
      expect(published && publishedPosition(published, pickId)).toEqual({ x: 900, y: 640 });
   });

   it('publishes one model for a drag that sweeps the primary into the layout build', async () => {
      // WITHOUT the pre-validation, which is the whole point: the primary is left
      // below `Validated`, so Langium's rebuild set pulls it into the layout
      // write's build and it reaches `Validated` there as an unauthored
      // `rebuilt`. The storage rightly reads that as foreign and resubmits — of
      // the graph the operation itself just delivered. Measured byte-identical
      // across the entire GModel, so the only honest answer is to drop it.
      const diagram = await openDiagram({ preValidate: false });
      const pickId = idOf(diagram, 'Pick');

      const beforeDrag = diagram.harness.actions.length;
      await diagram.apply(
         ChangeBoundsOperation.create([{ elementId: pickId, newPosition: { x: 520, y: 260 }, newSize: { width: 150, height: 55 } }])
      );
      await waitFor(() => submissionsSince(diagram, beforeDrag).length >= 1, {
         message: 'the drag published no model of its own'
      });
      await tick(PAST_DEBOUNCE_MS);

      // Absolute, not a delta: exactly the operation's own submission, with the
      // echo dropped by the shared submission signature.
      expect(submissionsSince(diagram, beforeDrag)).toHaveLength(1);
   });

   it('does not resubmit for the layout write its own drag authored', async () => {
      const diagram = await openDiagram();
      const pickId = idOf(diagram, 'Pick');

      // A move carrying the size the client already renders — the ordinary drag,
      // and the one that writes the layout secondary without touching the
      // `.process` primary at all.
      const beforeDrag = diagram.harness.actions.length;
      await diagram.apply(
         ChangeBoundsOperation.create([{ elementId: pickId, newPosition: { x: 520, y: 260 }, newSize: { width: 150, height: 55 } }])
      );
      expect(diagram.layoutText()).toContain('node Pick at 520, 260');

      // The operation publishes one model of its own, and it lands AFTER the
      // dirty-state notification the command stack fires on execute. Waiting for
      // the dirty state alone would put the baseline between the two and count
      // the drag's own submission as an echo.
      await waitFor(() => submissionsSince(diagram, beforeDrag).length >= 1, {
         message: 'the drag published no model of its own'
      });

      // Sampled BEFORE the wait, so the count cannot absorb the very event it
      // means to exclude. The echo would arrive one debounce after the write.
      const afterDrag = diagram.harness.actions.length;
      await tick(PAST_DEBOUNCE_MS);

      expect(submissionsSince(diagram, afterDrag)).toHaveLength(0);
   });
});
