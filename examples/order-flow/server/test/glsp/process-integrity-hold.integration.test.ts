/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * An integrity repair of a document only an open diagram holds, asserted on
 * DISK.
 *
 * The integrity tier routes a repair by whether any client holds the URI. The
 * precondition pins the diagram's side of that: once the diagram is open, its
 * session is the document's one holder. The disk assertion pins the routing
 * for that holder, since an unsaved diagram write that needs a repair must stay
 * in the store under the default `'silent'` sync mode. The disk assertion
 * cannot witness the hold on its own: `ModelService.update` opens the document
 * for its writer, so the test's own write holds it whatever the storage does.
 *
 * The workspace is a scratch copy: the workspace build persists repairs to
 * every file no client holds.
 */

import 'reflect-metadata';
import { ServerModule } from '@eclipse-glsp/server';
import { HydraniumGlspAppModule } from '@hydranium/glsp-server';
import { type GlspHarness, makeGlspHarness } from '@hydranium/glsp-server/testing';
import type { ScratchWorkspace } from '@hydranium/core/testing/node';
import { DocumentState, URI } from '@hydranium/langium';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { OrderFlowProcessDiagramModule } from '../../src/glsp/order-flow-process-diagram-module.js';
import { type OrderFlowGlspState } from '../../src/glsp/order-flow-glsp-state.js';
import { WORKSPACE_FILES, makeScratchWorkspaceHarness } from '../order-flow-harness.js';

const DIAGRAM_TYPE = 'order-flow-process';

let harness: GlspHarness<OrderFlowGlspState> | undefined;
let scratch: ScratchWorkspace | undefined;

afterEach(() => {
   harness?.dispose();
   harness = undefined;
   scratch?.dispose();
   scratch = undefined;
});

describe('order-flow .process integrity repair under an open diagram', () => {
   it('keeps the repair of an unsaved write in the store, not on disk, while only the diagram holds the document', async () => {
      const { harness: services, workspace } = await makeScratchWorkspaceHarness();
      scratch = workspace;
      const sourcePath = workspace.resolve(WORKSPACE_FILES.fulfillmentProcess);
      const uri = URI.file(sourcePath);
      const uriString = uri.toString();
      const textDocuments = services.shared.workspace.TextDocuments;
      harness = makeGlspHarness<OrderFlowGlspState>({
         serverModule: new ServerModule().configureDiagramModule(new OrderFlowProcessDiagramModule()),
         diagramType: DIAGRAM_TYPE,
         appModules: [new HydraniumGlspAppModule({ shared: services.shared })]
      });
      await harness.start();
      await harness.openDocument(sourcePath);
      const onDisk = readFileSync(sourcePath, 'utf8');

      // The precondition the routing turns on: the session holds the document,
      // and nothing else does.
      const sessionClient = harness.state.clientId;
      expect(textDocuments.openDocuments().find(open => open.uri === uriString)?.clients).toEqual([sessionClient]);

      // An unsaved write under the session's own id, as the diagram's own
      // writes are, whose duplicate task the flow-node rule repairs. `update`
      // resolves past both integrity passes and `Validated` follows every
      // settled-phase listener, so the silent write, had it happened, has.
      const lastBrace = onDisk.lastIndexOf('}');
      const duplicated = `${onDisk.slice(0, lastBrace)}   task Pay writes Order.status = PAID\n${onDisk.slice(lastBrace)}`;
      await services.shared.model.ModelService.update({ uri: uriString, clientId: sessionClient, model: duplicated, basedOn: 'anything' });
      await services.shared.workspace.DocumentBuilder.waitUntil(DocumentState.Validated, uri);

      expect(textDocuments.get(uriString)?.getText()).toContain('Pay__1');
      expect(readFileSync(sourcePath, 'utf8')).toBe(onDisk);
   });
});
