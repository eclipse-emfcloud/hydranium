/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { PROCESS_DIAGRAM_TYPE } from '@hydranium/example-order-flow-protocol';
import { HydraniumGlspEditorProvider } from '@hydranium/glsp-client-vscode/node';

/** The custom-editor view type, matched by the `contributes.customEditors` entry. */
export const ORDER_FLOW_PROCESS_DIAGRAM_VIEW_TYPE = 'orderFlow.processDiagram';

/**
 * The `.process` diagram's custom editor. `check:webview-csp` proves
 * against the built bundle that it needs no `'unsafe-eval'`.
 */
export class OrderFlowProcessDiagramEditorProvider extends HydraniumGlspEditorProvider {
   override diagramType = PROCESS_DIAGRAM_TYPE;
   protected override readonly scriptPath = 'out/webview/diagram.js';
   protected override readonly stylePath = 'out/webview/diagram.css';
   protected override readonly title = 'Order Flow Process Diagram';
}
