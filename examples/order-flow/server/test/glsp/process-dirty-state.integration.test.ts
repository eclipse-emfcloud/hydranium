/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * The diagram's dirty state against the real DI container and text store: the
 * diagram is dirty while a document it has open differs from its file, whoever
 * changed it, and it hears so without an operation of its own.
 */

import 'reflect-metadata';
import { type Action, ChangeBoundsOperation, SaveModelAction, ServerModule, SetDirtyStateAction } from '@eclipse-glsp/server';
import { HydraniumGlspAppModule } from '@hydranium/glsp-server';
import { type GlspHarness, makeGlspHarness } from '@hydranium/glsp-server/testing';
import type { ScratchWorkspace } from '@hydranium/core/testing/node';
import { URI } from '@hydranium/langium';
import { waitFor } from '@hydranium/protocol/testing';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OrderFlowProcessDiagramModule } from '../../src/glsp/order-flow-process-diagram-module.js';
import { type OrderFlowGlspState } from '../../src/glsp/order-flow-glsp-state.js';
import { type ProcessModel } from '../../src/language-server/ast.js';
import { type OrderFlowHarness, WORKSPACE_FILES, makeScratchWorkspaceHarness } from '../order-flow-harness.js';

const DIAGRAM_TYPE = 'order-flow-process';

let diagram: GlspHarness<OrderFlowGlspState> | undefined;
let scratch: ScratchWorkspace | undefined;

afterEach(() => {
   diagram?.dispose();
   diagram = undefined;
   scratch?.dispose();
   scratch = undefined;
});

async function bootServices(): Promise<OrderFlowHarness> {
   const { harness: services, workspace } = await makeScratchWorkspaceHarness();
   scratch = workspace;
   return services;
}

/** Start the real GLSP container over `services` and open the `.process` file. */
async function openDiagram(services: OrderFlowHarness): Promise<GlspHarness<OrderFlowGlspState>> {
   const opened = makeGlspHarness<OrderFlowGlspState>({
      serverModule: new ServerModule().configureDiagramModule(new OrderFlowProcessDiagramModule()),
      diagramType: DIAGRAM_TYPE,
      appModules: [new HydraniumGlspAppModule({ shared: services.shared })]
   });
   diagram = opened;
   await opened.start();
   await opened.openDocument(scratch!.resolve(WORKSPACE_FILES.fulfillmentProcess));
   return opened;
}

/** The dirty states sent to the client after `from`, as `isDirty reason`. */
function dirtyStates(harness: GlspHarness<OrderFlowGlspState>, from = 0): string[] {
   return harness.actions
      .slice(from)
      .filter((action: Action): action is SetDirtyStateAction => SetDirtyStateAction.is(action))
      .map(action => `${action.isDirty} ${action.reason ?? 'none'}`);
}

describe('order-flow .process dirty state', () => {
   it('opens dirty on a document another client has edited and not saved', async () => {
      const services = await bootServices();
      const processPath = scratch!.resolve(WORKSPACE_FILES.fulfillmentProcess);
      const processUri = URI.file(processPath).toString();
      const form = services.shared.model.ModelService.createSession('form');
      await form.open(processUri);
      const text = readFileSync(processPath, 'utf8');
      await form.update({ uri: processUri, model: text.replace('process Fulfillment', 'process Fulfilled'), baseVersion: 'any' });

      const opened = await openDiagram(services);

      await waitFor(() => dirtyStates(opened).length > 0);
      expect(dirtyStates(opened)[0]).toMatch(/^true/);
   });

   it('hears another client edit and save its document, with no operation of its own', async () => {
      const services = await bootServices();
      const processPath = scratch!.resolve(WORKSPACE_FILES.fulfillmentProcess);
      const processUri = URI.file(processPath).toString();
      const opened = await openDiagram(services);
      await waitFor(() => dirtyStates(opened).length > 0);
      const before = opened.actions.length;
      const form = services.shared.model.ModelService.createSession('form');
      await form.open(processUri);
      const text = readFileSync(processPath, 'utf8');

      const edited = text.replace('process Fulfillment', 'process Fulfilled');
      await form.update({ uri: processUri, model: edited, baseVersion: 'any' });
      await waitFor(() => dirtyStates(opened, before).includes('true external'));
      await form.save({ uri: processUri, model: edited, baseVersion: 'any' });

      await waitFor(() => dirtyStates(opened, before).includes('false external'));
      expect(dirtyStates(opened, before).filter(state => state.endsWith('external'))).toEqual(['true external', 'false external']);
   });

   it('is dirty after a drag that changed only the layout, and clean after its save', async () => {
      const services = await bootServices();
      const opened = await openDiagram(services);
      const root = opened.state.sourceRoot as ProcessModel;
      const pay = root.nodes.find(node => node.name === 'Pay')!;
      const before = opened.actions.length;

      opened.dispatch(
         ChangeBoundsOperation.create([
            { elementId: opened.state.index.createId(pay), newPosition: { x: 300, y: 220 }, newSize: { width: 200, height: 80 } }
         ])
      );
      await waitFor(() => dirtyStates(opened, before).includes('true operation'));
      opened.dispatch(SaveModelAction.create());

      await waitFor(() => dirtyStates(opened, before).includes('false save'));
      expect(
         services.shared.workspace.TextDocuments.isDirty(URI.file(scratch!.resolve(WORKSPACE_FILES.fulfillmentDiagram)).toString())
      ).toBe(false);
   });

   it('answers its own save dirty when another client edits its document during that save', async () => {
      const services = await bootServices();
      const processPath = scratch!.resolve(WORKSPACE_FILES.fulfillmentProcess);
      const processUri = URI.file(processPath).toString();
      const opened = await openDiagram(services);
      const form = services.shared.model.ModelService.createSession('form');
      await form.open(processUri);
      const root = opened.state.sourceRoot as ProcessModel;
      const pay = root.nodes.find(node => node.name === 'Pay')!;
      opened.dispatch(
         ChangeBoundsOperation.create([
            { elementId: opened.state.index.createId(pay), newPosition: { x: 300, y: 220 }, newSize: { width: 200, height: 80 } }
         ])
      );
      await waitFor(() => dirtyStates(opened).includes('true operation'));
      const before = opened.actions.length;
      // The storage holds back the flip while its save is awaited; GLSP's
      // answer to the save has to carry it.
      const manager = services.shared.workspace.AstDocumentManager;
      const save = manager.save.bind(manager);
      let edited = false;
      vi.spyOn(manager, 'save').mockImplementation(async (...args) => {
         const saved = await save(...args);
         if (!edited) {
            edited = true;
            const text = readFileSync(processPath, 'utf8');
            await form.update({ uri: processUri, model: text.replace('process Fulfillment', 'process Fulfilled'), baseVersion: 'any' });
         }
         return saved;
      });

      opened.dispatch(SaveModelAction.create());

      await waitFor(() => dirtyStates(opened, before).some(state => state.endsWith('save')));
      expect(dirtyStates(opened, before)).toEqual(['true save']);
   });
});
