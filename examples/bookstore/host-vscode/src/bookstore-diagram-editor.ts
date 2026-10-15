/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

// The Bookstore diagram's custom editor: a webview over the diagram bundle
// esbuild writes to `out/webview/`.

import { HydraniumGlspEditorProvider } from '@hydranium/glsp-client-vscode/node';
import { BOOKSTORE_DIAGRAM_TYPE } from '@hydranium/bookstore-protocol';

/**
 * The view type `contributes.customEditors` in `package.json` declares. VS Code
 * reads the manifest statically, so the two are kept equal by hand, and a
 * mismatch leaves the file with no diagram editor.
 */
export const BOOKSTORE_DIAGRAM_VIEW_TYPE = 'bookstore.diagram';

export class BookstoreDiagramEditorProvider extends HydraniumGlspEditorProvider {
   override diagramType = BOOKSTORE_DIAGRAM_TYPE;
   protected override readonly scriptPath = 'out/webview/bookstore-diagram.js';
   protected override readonly stylePath = 'out/webview/bookstore-diagram.css';
   protected override readonly title = 'Bookstore Diagram';
}
