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
   ComputedBoundsAction,
   EditMode,
   MarkersReason,
   RejectAction,
   RequestBoundsAction,
   RequestModelAction,
   ServerModule,
   SetEditModeAction,
   SetMarkersAction,
   StatusAction
} from '@eclipse-glsp/server';
import { HydraniumGlspAppModule } from '@hydranium/glsp-server';
import { DIAGRAM_READONLY_PARSE_ERROR } from '@hydranium/glsp-server/messages';
import { type GlspHarness, makeGlspHarness } from '@hydranium/glsp-server/testing';
import type { ScratchWorkspace } from '@hydranium/core/testing/node';
import { URI } from '@hydranium/langium';
import { readFileSync } from 'node:fs';
import { setTimeout as nextMacrotask } from 'node:timers/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OrderFlowProcessDiagramModule } from '../../src/glsp/order-flow-process-diagram-module.js';
import { type OrderFlowGlspState } from '../../src/glsp/order-flow-glsp-state.js';
import { WORKSPACE_FILES, makeScratchWorkspaceHarness, type OrderFlowHarness } from '../order-flow-harness.js';

const INTACT = 'transition Pick -> Ship';
const BROKEN = 'transition Pick ->';

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

/** Open `fulfillment.process` and answer the bounds request as a client does. */
async function openDiagram(prepare?: (workspace: ScratchWorkspace) => void): Promise<OpenDiagram> {
   const { harness: services, workspace } = await makeScratchWorkspaceHarness(prepare);
   const harness = makeGlspHarness<OrderFlowGlspState>({
      serverModule: new ServerModule().configureDiagramModule(new OrderFlowProcessDiagramModule()),
      diagramType: 'order-flow-process',
      appModules: [new HydraniumGlspAppModule({ shared: services.shared })],
      additionalClientActionKinds: [SetMarkersAction.KIND, SetEditModeAction.KIND]
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

      expect(lastOf(diagram, StatusAction.is)).toMatchObject({ message: DIAGRAM_READONLY_PARSE_ERROR.text, severity: 'WARNING' });
      expect(lastOf(diagram, SetEditModeAction.is)?.editMode).toBe(EditMode.READONLY);
   });

   it('leaves the band clear on a diagram opened over a clean document — the control on the row above', async () => {
      const diagram = await openDiagram();

      await afterLiveValidation(diagram, 0);

      const statuses = diagram.harness.actions.filter(StatusAction.is);
      expect(statuses.some(status => status.message === DIAGRAM_READONLY_PARSE_ERROR.text)).toBe(false);
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
});
