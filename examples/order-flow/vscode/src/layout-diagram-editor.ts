/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { processUriFor } from '@hydranium/example-order-flow-protocol';
import { commands, Uri, type CustomDocument, type CustomReadonlyEditorProvider, type WebviewPanel } from 'vscode';
import { ORDER_FLOW_PROCESS_DIAGRAM_VIEW_TYPE } from './process-diagram-editor';

export const ORDER_FLOW_LAYOUT_DIAGRAM_VIEW_TYPE = 'orderFlow.layoutDiagram';

/** Redirects Open With to the process editor so both files share one diagram. */
export class OrderFlowLayoutDiagramEditorProvider implements CustomReadonlyEditorProvider {
   openCustomDocument(uri: Uri): CustomDocument {
      return { uri, dispose() {} };
   }

   async resolveCustomEditor(document: CustomDocument, panel: WebviewPanel): Promise<void> {
      await commands.executeCommand(
         'vscode.openWith',
         Uri.parse(processUriFor(document.uri.toString())),
         ORDER_FLOW_PROCESS_DIAGRAM_VIEW_TYPE,
         { viewColumn: panel.viewColumn }
      );
      panel.dispose();
   }
}
