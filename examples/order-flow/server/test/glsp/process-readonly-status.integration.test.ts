/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * What a `.process` diagram tells its client about being read-only: the status
 * band and the edit mode, as sent over the real container.
 *
 * Model loading, live validation and a broken document each hold a status of
 * their own, and the edit mode can be held by the document and by the client
 * at once. Each case drives the whole initial handshake — `requestModel`, the
 * client's `computedBounds`, then the debounced live validation — because the
 * statuses that compete for the band are set and withdrawn along it.
 */

import 'reflect-metadata';
import {
   type Action,
   ChangeBoundsOperation,
   ComputedBoundsAction,
   EditMode,
   MarkersReason,
   MessageAction,
   RejectAction,
   RequestBoundsAction,
   RequestModelAction,
   ServerModule,
   SetEditModeAction,
   SetMarkersAction,
   SourceModelStorage,
   StatusAction,
   UpdateModelAction
} from '@eclipse-glsp/server';
import { HydraniumGlspAppModule } from '@hydranium/glsp-server';
import { DIAGRAM_READONLY_PARSE_ERROR } from '@hydranium/glsp-server/messages';
import { type GlspHarness, makeGlspHarness } from '@hydranium/glsp-server/testing';
import type { ScratchWorkspace } from '@hydranium/core/testing/node';
import { DocumentState, URI } from '@hydranium/langium';
import { readFileSync } from 'node:fs';
import { setTimeout as nextMacrotask } from 'node:timers/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OrderFlowProcessDiagramModule } from '../../src/glsp/order-flow-process-diagram-module.js';
import { type OrderFlowGlspState } from '../../src/glsp/order-flow-glsp-state.js';
import { WORKSPACE_FILES, makeScratchWorkspaceHarness, type OrderFlowHarness } from '../order-flow-harness.js';

const INTACT = 'transition Pick -> Ship';
const BROKEN = 'transition Pick ->';
const LAYOUT_INTACT = 'layout {';
const LAYOUT_BROKEN = 'layoxut {';

interface OpenDiagram {
   readonly services: OrderFlowHarness;
   readonly harness: GlspHarness<OrderFlowGlspState>;
   readonly workspace: ScratchWorkspace;
}

let open: OpenDiagram | undefined;

/** Leave `fulfillment.process` without a transition target, a parser error. */
function breakSyntax(workspace: ScratchWorkspace): void {
   const before = readFileSync(workspace.resolve(WORKSPACE_FILES.fulfillmentProcess), 'utf8');
   if (!before.includes(INTACT)) {
      throw new Error('fulfillment.process no longer contains the transition this case breaks');
   }
   workspace.write(WORKSPACE_FILES.fulfillmentProcess, before.replace(INTACT, BROKEN));
}

/** Misspell `fulfillment.layout`'s keyword, which error recovery parses as a layout with no entries. */
function breakLayout(workspace: ScratchWorkspace): void {
   const before = readFileSync(workspace.resolve(WORKSPACE_FILES.fulfillmentDiagram), 'utf8');
   if (!before.includes(LAYOUT_INTACT)) {
      throw new Error('fulfillment.layout no longer contains the header this case breaks');
   }
   workspace.write(WORKSPACE_FILES.fulfillmentDiagram, before.replace(LAYOUT_INTACT, LAYOUT_BROKEN));
}

/** The text the workspace holds for `fulfillment.layout`, unsaved edits included. */
function layoutText(diagram: OpenDiagram): string | undefined {
   const uri = URI.file(diagram.workspace.resolve(WORKSPACE_FILES.fulfillmentDiagram));
   return diagram.services.shared.workspace.LangiumDocuments.getDocument(uri)?.textDocument.getText();
}

/** Open `fulfillment.process` and answer the bounds request as a client does. */
async function openDiagram(prepare?: (workspace: ScratchWorkspace) => void): Promise<OpenDiagram> {
   const { harness: services, workspace } = await makeScratchWorkspaceHarness(prepare);
   const harness = makeGlspHarness<OrderFlowGlspState>({
      serverModule: new ServerModule().configureDiagramModule(new OrderFlowProcessDiagramModule()),
      diagramType: 'order-flow-process',
      appModules: [new HydraniumGlspAppModule({ shared: services.shared })],
      additionalClientActionKinds: [SetMarkersAction.KIND, SetEditModeAction.KIND, MessageAction.KIND]
   });
   open = { services, harness, workspace };
   await harness.start();
   await harness.openDocument(workspace.resolve(WORKSPACE_FILES.fulfillmentProcess));
   harness.dispatch(ComputedBoundsAction.create([], { revision: harness.state.root.revision }));
   return open;
}

/**
 * Wait for a live validation sent from action `from` on to finish, and for the
 * status it withdraws on finishing to reach the client.
 *
 * Its markers are the last thing validation sends, and the status change that
 * follows them is queued behind them on the action dispatcher, so it can land
 * after the markers are seen.
 */
async function afterLiveValidation(diagram: OpenDiagram, from: number): Promise<void> {
   await vi.waitFor(() =>
      expect(diagram.harness.actions.slice(from).some(action => SetMarkersAction.is(action) && action.reason === MarkersReason.LIVE)).toBe(
         true
      )
   );
   await nextMacrotask(0);
}

/** Change `fulfillment.process` as another client would, and answer the bounds request the change causes. */
async function editAsAnotherClient(diagram: OpenDiagram, from: string, to: string): Promise<void> {
   const processPath = diagram.workspace.resolve(WORKSPACE_FILES.fulfillmentProcess);
   const processUri = URI.file(processPath).toString();
   const form = diagram.services.shared.model.ModelService.createSession('form');
   await form.open(processUri);
   const before = diagram.harness.actions.length;
   await form.update({ uri: processUri, model: readFileSync(processPath, 'utf8').replace(from, to), baseVersion: 'any' });
   await vi.waitFor(() => expect(diagram.harness.actions.slice(before).some(action => RequestBoundsAction.is(action))).toBe(true));
   diagram.harness.dispatch(ComputedBoundsAction.create([], { revision: diagram.harness.state.root.revision }));
}

function lastOf<T extends Action>(diagram: OpenDiagram, is: (action: Action) => action is T): T | undefined {
   return diagram.harness.actions.filter(is).at(-1);
}

describe('order-flow .process read-only status', () => {
   afterEach(() => {
      open?.harness.dispose();
      open?.workspace.dispose();
      open = undefined;
   });

   it('keeps the band on a diagram opened over a broken document once live validation has run', async () => {
      const diagram = await openDiagram(breakSyntax);

      await afterLiveValidation(diagram, 0);

      expect(lastOf(diagram, StatusAction.is)).toMatchObject({
         message: DIAGRAM_READONLY_PARSE_ERROR.format({ document: 'fulfillment.process' }),
         severity: 'ERROR'
      });
      expect(lastOf(diagram, SetEditModeAction.is)?.editMode).toBe(EditMode.READONLY);
   });

   it('leaves the band clear on a diagram opened over a clean document — the control on the row above', async () => {
      const diagram = await openDiagram();

      await afterLiveValidation(diagram, 0);

      const statuses = diagram.harness.actions.filter(StatusAction.is);
      expect(statuses.some(status => status.message.startsWith('Read-only'))).toBe(false);
      expect(statuses.at(-1)?.severity ?? 'NONE').toBe('NONE');
      expect(diagram.harness.actions.some(SetEditModeAction.is)).toBe(false);
   });

   it('clears the band and makes the diagram editable once the document is fixed', async () => {
      const diagram = await openDiagram(breakSyntax);
      await afterLiveValidation(diagram, 0);
      const before = diagram.harness.actions.length;

      await editAsAnotherClient(diagram, BROKEN, INTACT);
      await afterLiveValidation(diagram, before);

      expect(lastOf(diagram, StatusAction.is)).toMatchObject({ message: '', severity: 'NONE' });
      expect(lastOf(diagram, SetEditModeAction.is)?.editMode).toBe(EditMode.EDITABLE);
   });

   it('withdraws the loading status when the model fails to load', async () => {
      const { harness: services, workspace } = await makeScratchWorkspaceHarness();
      const harness = makeGlspHarness<OrderFlowGlspState>({
         serverModule: new ServerModule().configureDiagramModule(new OrderFlowProcessDiagramModule()),
         diagramType: 'order-flow-process',
         appModules: [new HydraniumGlspAppModule({ shared: services.shared })]
      });
      open = { services, harness, workspace };
      await harness.start();

      // No source URI, so the load throws before it reads anything.
      harness.dispatch(RequestModelAction.create({ requestId: 'no-source', options: { diagramType: 'order-flow-process' } }));
      await harness.nextAction(RejectAction.KIND);
      await nextMacrotask(0);

      expect(harness.state.currentStatus).toBeUndefined();
      expect(lastOf(open, StatusAction.is)?.severity ?? 'NONE').toBe('NONE');
   });

   it('keeps a diagram the client asked to be read-only read-only once its document is fixed', async () => {
      const diagram = await openDiagram(breakSyntax);
      await afterLiveValidation(diagram, 0);
      diagram.harness.dispatch(SetEditModeAction.create(EditMode.READONLY));
      const before = diagram.harness.actions.length;

      await editAsAnotherClient(diagram, BROKEN, INTACT);
      await afterLiveValidation(diagram, before);

      expect(lastOf(diagram, StatusAction.is)).toMatchObject({ message: '', severity: 'NONE' });
      expect(diagram.harness.state.editMode).toBe(EditMode.READONLY);
      expect(diagram.harness.actions.slice(before).some(SetEditModeAction.is)).toBe(false);
   });

   it('sends read-only back to a client that switched itself to editable while the document is broken', async () => {
      // GLSP's client applies an edit-mode request itself before forwarding it,
      // so a refused request leaves the client editable unless the server answers.
      const diagram = await openDiagram(breakSyntax);
      await afterLiveValidation(diagram, 0);
      const before = diagram.harness.actions.length;

      diagram.harness.dispatch(SetEditModeAction.create(EditMode.EDITABLE));

      await vi.waitFor(() =>
         expect(diagram.harness.actions.slice(before).filter(SetEditModeAction.is).at(-1)?.editMode).toBe(EditMode.READONLY)
      );
      expect(diagram.harness.state.editMode).toBe(EditMode.READONLY);
   });

   it('makes a diagram read-only while its layout does not parse, naming the layout', async () => {
      const diagram = await openDiagram(breakLayout);

      await afterLiveValidation(diagram, 0);

      expect(lastOf(diagram, StatusAction.is)).toMatchObject({
         message: DIAGRAM_READONLY_PARSE_ERROR.format({ document: 'fulfillment.layout' }),
         severity: 'ERROR'
      });
      expect(lastOf(diagram, SetEditModeAction.is)?.editMode).toBe(EditMode.READONLY);
   });

   it('refuses a drag while the layout does not parse, and leaves its text alone', async () => {
      // A write would serialize the AST error recovery made of the layout, which
      // has no entries, over the text the user is still editing.
      const diagram = await openDiagram(breakLayout);
      await afterLiveValidation(diagram, 0);
      const before = layoutText(diagram);
      const from = diagram.harness.actions.length;
      const pay = diagram.harness.state.sourceRoot.nodes.find(node => node.name === 'Pay');
      if (!pay) {
         throw new Error('fulfillment.process no longer declares Pay');
      }

      diagram.harness.dispatch(
         ChangeBoundsOperation.create([
            { elementId: diagram.harness.state.index.createId(pay), newPosition: { x: 112, y: 42 }, newSize: { width: 160, height: 60 } }
         ])
      );

      // GLSP answers an operation on a read-only diagram with a message, and an
      // applied one with a new model; whichever arrives first settles the case.
      const answered = (action: Action): boolean =>
         MessageAction.is(action) || RequestBoundsAction.is(action) || UpdateModelAction.is(action);
      await vi.waitFor(() => expect(diagram.harness.actions.slice(from).some(answered)).toBe(true));

      expect(diagram.harness.actions.slice(from).find(answered)?.kind).toBe(MessageAction.KIND);
      expect(layoutText(diagram)).toBe(before);
   });

   it('makes a diagram read-only while another client has its layout broken', async () => {
      const diagram = await openDiagram();
      await afterLiveValidation(diagram, 0);
      const layoutPath = diagram.workspace.resolve(WORKSPACE_FILES.fulfillmentDiagram);
      const layoutUri = URI.file(layoutPath).toString();
      const form = diagram.services.shared.model.ModelService.createSession('form');
      await form.open(layoutUri);
      const from = diagram.harness.actions.length;

      await form.update({
         uri: layoutUri,
         model: readFileSync(layoutPath, 'utf8').replace(LAYOUT_INTACT, LAYOUT_BROKEN),
         baseVersion: 'any'
      });

      await vi.waitFor(() => expect(diagram.harness.state.editMode).toBe(EditMode.READONLY));
      expect(diagram.harness.state.currentStatus?.message).toBe(DIAGRAM_READONLY_PARSE_ERROR.format({ document: 'fulfillment.layout' }));
      // The canvas keeps the model it has: one built from the recovered layout
      // would put every node back where client layout leaves it.
      await nextMacrotask(0);
      expect(diagram.harness.actions.slice(from).some(action => RequestBoundsAction.is(action))).toBe(false);

      await form.update({ uri: layoutUri, model: readFileSync(layoutPath, 'utf8'), baseVersion: 'any' });

      await vi.waitFor(() => expect(diagram.harness.state.editMode).toBe(EditMode.EDITABLE));
      expect(diagram.harness.state.currentStatus).toBeUndefined();
   });

   it('decides the status from the text as it stands when a build has parsed it but not yet validated it', async () => {
      const diagram = await openDiagram();
      await afterLiveValidation(diagram, 0);
      const processPath = diagram.workspace.resolve(WORKSPACE_FILES.fulfillmentProcess);
      const processUri = URI.file(processPath).toString();
      const intact = readFileSync(processPath, 'utf8');
      const form = diagram.services.shared.model.ModelService.createSession('form');
      await form.open(processUri);
      // Holds a build past the integrity landmark, where the resubmit's settle
      // resolves, and short of Validated, where an update event would follow.
      let release: () => void = () => undefined;
      const gate = new Promise<void>(resolve => {
         release = resolve;
      });
      let hold = false;
      diagram.services.shared.workspace.DocumentBuilder.onBuildPhase(DocumentState.IndexedReferences, async () => {
         if (hold) {
            await gate;
         }
      });
      const storage = diagram.harness.sessionContainer.get<SourceModelStorage>(SourceModelStorage) as unknown as {
         captureAndSubmit(...args: unknown[]): Promise<Action[]>;
      };
      const captured = vi.spyOn(storage, 'captureAndSubmit');

      // A valid edit by another client schedules the resubmit; a broken one
      // is parsed before the resubmit runs, and validated only after.
      await form.update({ uri: processUri, model: `${intact}\n`, baseVersion: 'any' });
      hold = true;
      const broken = form.update({ uri: processUri, model: intact.replace(INTACT, BROKEN), baseVersion: 'any' });
      await vi.waitFor(() => expect(captured).toHaveBeenCalled(), { timeout: 2_000 });
      await captured.mock.results[0].value;

      expect(diagram.harness.state.currentStatus?.message).toBe(DIAGRAM_READONLY_PARSE_ERROR.format({ document: 'fulfillment.process' }));
      release();
      await broken;
   });
});
