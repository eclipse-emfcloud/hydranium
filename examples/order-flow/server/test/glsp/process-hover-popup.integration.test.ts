/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import 'reflect-metadata';
import { RequestPopupModelAction, ServerModule, SetPopupModelAction } from '@eclipse-glsp/server';
import { HydraniumGlspAppModule } from '@hydranium/glsp-server';
import { type GlspHarness, makeGlspHarness } from '@hydranium/glsp-server/testing';
import type { ScratchWorkspace } from '@hydranium/core/testing/node';
import { URI } from '@hydranium/langium';
import { afterEach, describe, expect, it } from 'vitest';
import { OrderFlowProcessDiagramModule } from '../../src/glsp/order-flow-process-diagram-module.js';
import { type OrderFlowGlspState } from '../../src/glsp/order-flow-glsp-state.js';
import { isTask } from '../../src/language-server/ast.js';
import { WORKSPACE_FILES, makeScratchWorkspaceHarness, type OrderFlowHarness } from '../order-flow-harness.js';

let open: { services: OrderFlowHarness; harness: GlspHarness<OrderFlowGlspState>; workspace: ScratchWorkspace } | undefined;

afterEach(() => {
   open?.harness.dispose();
   open?.workspace.dispose();
   open = undefined;
});

describe('process diagram hover popup', () => {
   it('shows the hover the .process editor shows on the same task', async () => {
      const { harness: services, workspace } = await makeScratchWorkspaceHarness();
      const harness = makeGlspHarness<OrderFlowGlspState>({
         serverModule: new ServerModule().configureDiagramModule(new OrderFlowProcessDiagramModule()),
         diagramType: 'order-flow-process',
         appModules: [new HydraniumGlspAppModule({ shared: services.shared })],
         additionalClientActionKinds: [SetPopupModelAction.KIND]
      });
      open = { services, harness, workspace };
      await harness.start();
      const path = workspace.resolve(WORKSPACE_FILES.fulfillmentProcess);
      await harness.openDocument(path);

      const document = await services.shared.workspace.LangiumDocuments.getOrCreateDocument(URI.file(path));
      const text = document.textDocument.getText();
      const editorHover = await services.process.lsp.HoverProvider?.getHoverContent(document, {
         textDocument: { uri: document.uri.toString() },
         position: document.textDocument.positionAt(text.indexOf('task Pay') + 'task '.length)
      });
      const task = harness.state.sourceRoot.nodes.filter(isTask).find(node => node.name === 'Pay');
      if (!task?._effectSummary) {
         throw new Error('task Pay has no effect summary: the sample workspace changed');
      }
      expect(editorHover?.contents).toEqual({ kind: 'markdown', value: `**task** \`Pay\` — ${task._effectSummary}` });

      harness.dispatch(
         RequestPopupModelAction.create({ elementId: harness.state.index.createId(task), bounds: { x: 0, y: 0, width: 0, height: 0 } })
      );
      const popup = await harness.nextAction<SetPopupModelAction>(SetPopupModelAction.KIND);

      expect(popup.newRoot.children?.map(child => (child as { code?: unknown }).code)).toEqual([
         `<p><strong>task</strong> <code>Pay</code> — ${task._effectSummary}</p>\n`
      ]);
   });
});
