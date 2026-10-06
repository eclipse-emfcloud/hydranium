/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import 'reflect-metadata';
import { MessageAction, RequestModelAction, SOURCE_URI_ARG, ServerModule, SourceModelStorage } from '@eclipse-glsp/server';
import { HydraniumGlspAppModule } from '@hydranium/glsp-server';
import { type GlspHarness, makeGlspHarness } from '@hydranium/glsp-server/testing';
import type { ScratchWorkspace } from '@hydranium/core/testing/node';
import { URI } from '@hydranium/langium';
import { RESUME_TOKEN_ARG } from '@hydranium/protocol';
import { waitFor } from '@hydranium/protocol/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { OrderFlowProcessDiagramModule } from '../../src/glsp/order-flow-process-diagram-module.js';
import type { OrderFlowGlspState } from '../../src/glsp/order-flow-glsp-state.js';
import { makeScratchWorkspaceHarness, type OrderFlowHarness, WORKSPACE_FILES } from '../order-flow-harness.js';
import { apply, move } from './uncommitted-edit-harness.js';

const CLIENT_ID = 'order-flow-process_window_fulfillment';

let diagrams: Array<GlspHarness<OrderFlowGlspState>> = [];
let scratch: ScratchWorkspace | undefined;

afterEach(() => {
   diagrams.forEach(diagram => diagram.dispose());
   diagrams = [];
   scratch?.dispose();
   scratch = undefined;
});

/** A connection of its own to the shared workspace, loading the process diagram under {@link CLIENT_ID} with `token`. */
async function connect(services: OrderFlowHarness, sourcePath: string, token: string): Promise<GlspHarness<OrderFlowGlspState>> {
   const diagram = makeGlspHarness<OrderFlowGlspState>({
      serverModule: new ServerModule().configureDiagramModule(new OrderFlowProcessDiagramModule()),
      diagramType: 'order-flow-process',
      appModules: [new HydraniumGlspAppModule({ shared: services.shared })],
      clientSessionId: CLIENT_ID,
      additionalClientActionKinds: [MessageAction.KIND]
   });
   diagrams.push(diagram);
   await diagram.start();
   diagram.dispatch(RequestModelAction.create({ options: { [SOURCE_URI_ARG]: sourcePath, [RESUME_TOKEN_ARG]: token } }));
   return diagram;
}

async function setup(): Promise<{ services: OrderFlowHarness; sourcePath: string; layoutUri: string }> {
   const { harness: services, workspace } = await makeScratchWorkspaceHarness();
   scratch = workspace;
   const layoutUri = URI.file(workspace.resolve(WORKSPACE_FILES.fulfillmentDiagram)).toString();
   return { services, sourcePath: workspace.resolve(WORKSPACE_FILES.fulfillmentProcess), layoutUri };
}

describe('a diagram loading under an id its old connection still holds', () => {
   it('takes the session over with the matching token, and keeps the unsaved text', async () => {
      const { services, sourcePath, layoutUri } = await setup();
      const store = services.shared.workspace.TextDocuments;
      const old = await connect(services, sourcePath, 'token');
      await old.nextModelSubmission();
      await apply(old, move(old, old.state.sourceRoot.nodes[0].name, 512, 384));
      const edited = store.get(layoutUri)?.getText();
      const oldSession = old.state.modelSession;

      const resumed = await connect(services, sourcePath, 'token');
      await resumed.nextModelSubmission();

      // The resumed diagram opens the layout as it joins the write set, after the load.
      await waitFor(() => store.isOpenInClient(layoutUri, CLIENT_ID), { message: 'the resumed diagram never opened the layout' });

      expect(oldSession).toBeDefined();
      expect(resumed.state.modelSession).not.toBe(oldSession);
      expect(services.shared.model.ModelService.getSession(CLIENT_ID)).toBe(resumed.state.modelSession);
      // Reclaimed by the same id, not waiting out a grace that reverts it.
      expect(store.isReleaseDeferred(layoutUri)).toBe(false);
      expect(store.get(layoutUri)?.getText()).toBe(edited);
      // The old connection's diagram stops, rather than writing under a session that ended.
      const oldStorage = old.sessionContainer.get<SourceModelStorage>(SourceModelStorage) as unknown as { disposed: boolean };
      expect(oldStorage.disposed).toBe(true);
      expect(old.state.modelSession).toBeUndefined();

      // The old connection closing at last ends nothing of the resumed diagram's.
      await old.shutdown();
      expect(services.shared.model.ModelService.getSession(CLIENT_ID)).toBe(resumed.state.modelSession);
      expect(store.isOpenInClient(layoutUri, CLIENT_ID)).toBe(true);
      expect(store.get(layoutUri)?.getText()).toBe(edited);
   });

   it('is refused at once without the matching token, and leaves the holder alone', async () => {
      const { services, sourcePath } = await setup();
      const holder = await connect(services, sourcePath, 'token');
      await holder.nextModelSubmission();
      const held = holder.state.modelSession;

      const stranger = await connect(services, sourcePath, 'other');
      const refusal = await stranger.nextAction<MessageAction>(MessageAction.KIND);

      expect(refusal.severity).toBe('ERROR');
      expect(services.shared.model.ModelService.getSession(CLIENT_ID)).toBe(held);
   });
});
