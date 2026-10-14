/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

// `vscode` exists only inside the extension host. GLSP's integration
// `require`s it too, which `vi.mock` does not reach, so the one stub goes in
// at Node's loader as well: an event emitter and the `Uri.joinPath` the
// provider uses.
const { restoreLoad, vscodeStub } = vi.hoisted(() => {
   const nodeModule = globalThis.process.getBuiltinModule('node:module') as typeof Module & {
      _load(request: string, ...rest: unknown[]): unknown;
   };
   const { Emitter } = nodeModule.createRequire(__filename)('vscode-jsonrpc') as typeof Jsonrpc;
   const posix = globalThis.process.getBuiltinModule('node:path').posix;
   const vscodeStub = {
      EventEmitter: Emitter,
      Uri: { joinPath: (base: { path: string }, ...segments: string[]) => ({ path: posix.join(base.path, ...segments) }) }
   };
   const load = nodeModule._load;
   nodeModule._load = function (request: string, ...rest: unknown[]): unknown {
      return request === 'vscode' ? vscodeStub : load.call(this, request, ...rest);
   };
   return {
      vscodeStub,
      restoreLoad: (): void => {
         nodeModule._load = load;
      }
   };
});
vi.mock('vscode', () => vscodeStub);

import type { GlspVscodeConnector } from '@eclipse-glsp/vscode-integration';
import type { Module } from 'node:module';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type * as Jsonrpc from 'vscode-jsonrpc';
import type * as vscode from 'vscode';
import { DIAGRAM_CONTAINER_CLASS } from '../src/diagram-container';
import { HydraniumGlspEditorProvider } from '../src/node/glsp-editor-provider';

class TypeOneEditorProvider extends HydraniumGlspEditorProvider {
   override diagramType = 'type-one';
   protected override readonly scriptPath = 'out/webview/diagram.js';
   protected override readonly stylePath: string = 'out/webview/diagram.css';
   protected override readonly title = 'Type <One>';
}

/** A stylesheet the bundler writes outside the script's directory. */
class SeparateStyleEditorProvider extends TypeOneEditorProvider {
   protected override readonly stylePath = 'out/style/diagram.css';
}

/** The webview panel `setUpWebview` writes into, its URIs rendered as their path. */
function makePanel(): vscode.WebviewPanel {
   const webview = {
      cspSource: 'vscode-resource:',
      asWebviewUri: (uri: { path: string }) => `webview:${uri.path}`,
      options: {},
      html: ''
   };
   return { webview } as unknown as vscode.WebviewPanel;
}

afterAll(() => restoreLoad());

describe('HydraniumGlspEditorProvider', () => {
   const connector = { onDidChangeCustomDocument: () => ({ dispose: () => undefined }) } as unknown as GlspVscodeConnector;
   const provider = new TypeOneEditorProvider(connector, { path: '/ext' } as vscode.Uri);

   function setUp(clientId: string, editorProvider: HydraniumGlspEditorProvider = provider): vscode.Webview {
      const panel = makePanel();
      editorProvider.setUpWebview({} as vscode.CustomDocument, panel, {} as vscode.CancellationToken, clientId);
      return panel.webview;
   }

   it('mounts the diagram into the element named by the connector client id', () => {
      const html = setUp('client-one').html;

      expect(html).toContain(`<div id="client-one_container" class="${DIAGRAM_CONTAINER_CLASS}"></div>`);
      expect(html).toContain('src="webview:/ext/out/webview/diagram.js"');
      expect(html).toContain('href="webview:/ext/out/webview/diagram.css"');
   });

   it('runs only its own nonced script and grants no eval', () => {
      const html = setUp('client-one').html;
      const nonce = /script-src 'nonce-([^']+)'/.exec(html)?.[1];

      expect(nonce).toBeDefined();
      expect(html).toContain(`<script nonce="${nonce}" src=`);
      expect(html).not.toContain('unsafe-eval');
      expect(setUp('client-one').html).not.toContain(nonce);
   });

   it('loads only from the bundle directory', () => {
      const webview = setUp('client-one');

      expect(webview.options.enableScripts).toBe(true);
      expect(webview.options.localResourceRoots).toEqual([{ path: '/ext/out/webview' }]);
   });

   it('also loads from the stylesheet directory when it differs', () => {
      const webview = setUp('client-one', new SeparateStyleEditorProvider(connector, { path: '/ext' } as vscode.Uri));

      expect(webview.options.localResourceRoots).toEqual([{ path: '/ext/out/webview' }, { path: '/ext/out/style' }]);
   });

   it('escapes the title', () => {
      expect(setUp('client-one').html).toContain('<title>Type &#60;One&#62;</title>');
   });
});
