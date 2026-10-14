/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { GlspEditorProvider, type GlspVscodeConnector } from '@eclipse-glsp/vscode-integration';
import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { DIAGRAM_CONTAINER_CLASS } from '../diagram-container';

/**
 * A custom editor whose webview hosts a GLSP diagram: the webview document,
 * its Content-Security-Policy and the element the diagram mounts into.
 *
 * `GlspEditorProvider` already mints the per-view `clientId`, registers the
 * client on the connector and routes save, revert and dirty state; a subclass
 * names the diagram type, the bundle and the title.
 *
 * The connector's messenger reaches each webview's endpoint through the base
 * class. `GlspVscodeConnector` constructs it with `ignoreHiddenViews: false`;
 * a messenger handed to the connector must repeat that, or a hidden diagram tab
 * misses every message sent to it.
 */
export abstract class HydraniumGlspEditorProvider extends GlspEditorProvider {
   /** The webview's script bundle, relative to the extension root. */
   protected abstract readonly scriptPath: string;
   /** The webview's stylesheet, relative to the extension root, if the bundler emits one. */
   protected readonly stylePath?: string;
   /** The webview document's title. */
   protected abstract readonly title: string;

   constructor(
      connector: GlspVscodeConnector,
      protected readonly extensionUri: vscode.Uri
   ) {
      super(connector);
   }

   /**
    * Populate the webview for one diagram view.
    *
    * `clientId` is the connector's: the diagram widget mounts into
    * `#<clientId>_container`, so a document naming another id loads and renders
    * nothing.
    */
   setUpWebview(
      _document: vscode.CustomDocument,
      webviewPanel: vscode.WebviewPanel,
      _token: vscode.CancellationToken,
      clientId: string
   ): void {
      const webview = webviewPanel.webview;
      webview.options = { enableScripts: true, localResourceRoots: this.localResourceRoots() };
      webview.html = this.render(webview, clientId);
   }

   /**
    * Where the webview may load from: the script's directory and the
    * stylesheet's. VS Code blocks anything outside them without an error, so a
    * stylesheet elsewhere would leave the diagram unstyled.
    */
   protected localResourceRoots(): vscode.Uri[] {
      const roots = [vscode.Uri.joinPath(this.extensionUri, this.scriptPath, '..')];
      if (this.stylePath) {
         const styleRoot = vscode.Uri.joinPath(this.extensionUri, this.stylePath, '..');
         if (styleRoot.path !== roots[0].path) {
            roots.push(styleRoot);
         }
      }
      return roots;
   }

   /**
    * The webview document.
    *
    * The CSP relaxations are sprotty's: `style-src 'unsafe-inline'` because it
    * writes inline `style` attributes on the SVG, without which every element is
    * laid out at the origin, and `font-src data:` for the codicon font a bundler
    * inlines. `'unsafe-eval'` is not granted; nothing in a GLSP bundle needs it.
    */
   protected render(webview: vscode.Webview, clientId: string): string {
      const script = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, this.scriptPath));
      const style = this.stylePath ? webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, this.stylePath)) : undefined;
      const nonce = randomBytes(16).toString('base64');
      return `<!DOCTYPE html>
<html lang="en">
   <head>
      <meta charset="UTF-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1.0" />
      <meta
         http-equiv="Content-Security-Policy"
         content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource} data:; img-src ${webview.cspSource} data:; script-src 'nonce-${nonce}';"
      />
      <title>${escapeHtml(this.title)}</title>${style ? `\n      <link rel="stylesheet" href="${style}" />` : ''}
   </head>
   <body>
      <div id="${clientId}_container" class="${DIAGRAM_CONTAINER_CLASS}"></div>
      <script nonce="${nonce}" src="${script}"></script>
   </body>
</html>`;
   }
}

function escapeHtml(text: string): string {
   return text.replace(/[&<>"']/g, character => `&#${character.charCodeAt(0)};`);
}
