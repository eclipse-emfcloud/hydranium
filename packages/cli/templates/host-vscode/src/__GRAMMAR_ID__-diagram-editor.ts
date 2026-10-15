// The __GRAMMAR__ diagram's custom editor: a webview over the diagram bundle
// esbuild writes to `out/webview/`.

import { HydraniumGlspEditorProvider } from '@hydranium/glsp-client-vscode/node';
import { __GRAMMAR_ID_CONST___DIAGRAM_TYPE } from '__PROTOCOL_PACKAGE__';

/**
 * The view type `contributes.customEditors` in `package.json` declares. VS Code
 * reads the manifest statically, so the two are kept equal by hand, and a
 * mismatch leaves the file with no diagram editor.
 */
export const __GRAMMAR_ID_CONST___DIAGRAM_VIEW_TYPE = '__LANGUAGE_ID__.diagram';

export class __GRAMMAR__DiagramEditorProvider extends HydraniumGlspEditorProvider {
   override diagramType = __GRAMMAR_ID_CONST___DIAGRAM_TYPE;
   protected override readonly scriptPath = 'out/webview/__GRAMMAR_ID__-diagram.js';
   protected override readonly stylePath = 'out/webview/__GRAMMAR_ID__-diagram.css';
   protected override readonly title = '__GRAMMAR__ Diagram';
}
