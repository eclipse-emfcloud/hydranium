/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * The `.process` diagram's extension-host half: a `CustomEditorProvider` whose
 * webview hosts the GLSP client.
 *
 * Almost everything is inherited. `GlspEditorProvider` already mints the
 * per-view `clientId`, builds the `WebviewEndpoint`, registers the client on the
 * connector and routes save / revert / dirty-state — so what is left here is the
 * diagram type and the webview document, which is the one part upstream cannot
 * write for an adopter.
 *
 * **The connector's messenger reaches the endpoint without being passed here**,
 * which is worth stating because the properties panel depends on the same
 * option. `WebviewEndpoint` falls back to a default-constructed `Messenger`,
 * whose `ignoreHiddenViews` defaults to `true` and would drop every host→webview
 * notification for a hidden tab. But `GlspEditorProvider.resolveCustomEditor`
 * passes `messenger: this.glspVscodeConnector.messenger`, and
 * `GlspVscodeConnector` defaults ITS messenger to
 * `new Messenger({ ignoreHiddenViews: false })` — so with the pinned
 * `@eclipse-glsp/vscode-integration` the correct option is inherited, as long as
 * an adopter does not hand the connector a messenger of its own without
 * repeating it. That last clause is the live constraint, and `extension.ts` is
 * where it is honoured.
 */

import { GlspEditorProvider, type GlspVscodeConnector } from '@eclipse-glsp/vscode-integration';
import { PROCESS_DIAGRAM_TYPE } from '@hydranium/example-order-flow-client/lib/diagram/order-flow-process-diagram-types';
import * as vscode from 'vscode';

/** The custom-editor view type, matched by the `contributes.customEditors` entry. */
export const ORDER_FLOW_PROCESS_DIAGRAM_VIEW_TYPE = 'orderFlow.processDiagram';

export class OrderFlowProcessDiagramEditorProvider extends GlspEditorProvider {
   override diagramType = PROCESS_DIAGRAM_TYPE;

   constructor(
      connector: GlspVscodeConnector,
      protected readonly extensionUri: vscode.Uri
   ) {
      super(connector);
   }

   /**
    * Populate the webview for one diagram view.
    *
    * `clientId` is the connector's, not ours to choose: the diagram widget mounts
    * into `#<clientId>_container`, so the id in this document has to be the same
    * one the endpoint was registered under or the webview loads and renders
    * nothing into a body it cannot find.
    */
   setUpWebview(
      _document: vscode.CustomDocument,
      webviewPanel: vscode.WebviewPanel,
      _token: vscode.CancellationToken,
      clientId: string
   ): void {
      const webview = webviewPanel.webview;
      webview.options = {
         enableScripts: true,
         localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'out')]
      };
      webview.html = this.render(webview, clientId);
   }

   /**
    * The webview document.
    *
    * **The CSP is looser than the properties panel's, and every relaxation is
    * sprotty's rather than ours.** The panel is plain DOM and needs neither
    * `'unsafe-inline'` nor a font source; a GLSP diagram needs both:
    *
    * - `style-src 'unsafe-inline'` — sprotty writes inline `style` attributes on
    *   the SVG it renders (transforms, computed sizes), which CSP governs under
    *   `style-src`. Without it the graph mounts but every element is laid out at
    *   the origin.
    * - `font-src data:` — `@vscode/codicons` reaches a `.ttf`, which the bundle
    *   inlines as a data URL (see `esbuild.mjs`). Emitting the font as a file
    *   instead would need its `vscode-webview://` URI rewritten into the CSS at
    *   build time, which the bundler cannot know.
    *
    * `'unsafe-eval'` is deliberately NOT granted, unlike GLSP's own example.
    * Nothing in the bundle needs it — `scripts/check-webview-csp.mjs` proves that
    * against the built artefact rather than by inspection — and granting it
    * "because the upstream example does" is how a webview ends up permanently
    * looser than it has to be.
    */
   protected render(webview: vscode.Webview, clientId: string): string {
      const script = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'out', 'webview', 'diagram.js'));
      const style = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'out', 'webview', 'diagram.css'));
      const nonce = makeNonce();
      return `<!DOCTYPE html>
<html lang="en">
   <head>
      <meta charset="UTF-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1.0" />
      <meta
         http-equiv="Content-Security-Policy"
         content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource} data:; img-src ${webview.cspSource} data:; script-src 'nonce-${nonce}';"
      />
      <title>Order Flow Process Diagram</title>
      <link rel="stylesheet" href="${style}" />
   </head>
   <body>
      <div id="${clientId}_container" class="order-flow-diagram-container"></div>
      <script nonce="${nonce}" src="${script}"></script>
   </body>
</html>`;
   }
}

/** A per-load CSP nonce. Not a secret — it only has to be unguessable per document. */
function makeNonce(): string {
   const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
   let nonce = '';
   for (let i = 0; i < 32; i++) {
      nonce += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
   }
   return nonce;
}
