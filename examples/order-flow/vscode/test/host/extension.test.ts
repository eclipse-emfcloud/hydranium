/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * The extension in a real VS Code, observed through the extension API. What a
 * webview draws is out of its reach; the Playwright tier covers that.
 */

import { ORDER_FLOW_HOST_PORT_COMMANDS } from '@hydranium/example-order-flow-vscode-servers/out/language-client';
import * as assert from 'node:assert/strict';
import { connect } from 'node:net';
import * as vscode from 'vscode';
import { ORDER_FLOW_PROCESS_DIAGRAM_VIEW_TYPE } from '../../src/process-diagram-editor';
import { OrderFlowPropertiesPanel } from '../../src/properties-panel';

const EXTENSION_NAME = '@hydranium/example-order-flow-vscode';

/** URI of `relativePath` in the workspace the run opened. */
function workspaceUri(relativePath: string): vscode.Uri {
   const folder = vscode.workspace.workspaceFolders?.[0];
   assert.ok(folder, 'the run opens the scratch copy of the fixture workspace');
   return vscode.Uri.joinPath(folder.uri, relativePath);
}

/**
 * Resolve once `check` returns a value, re-evaluated on every `event`, or
 * reject naming `awaited`. Checked once up front too, since a past event is not
 * replayed; the timeout sits under Mocha's, which would not say what was awaited.
 */
function when<T>(event: vscode.Event<unknown>, check: () => T | undefined, awaited: string, timeoutMs = 45_000): Promise<T> {
   return new Promise((resolve, reject) => {
      const initial = check();
      if (initial !== undefined) {
         resolve(initial);
         return;
      }
      const timer = setTimeout(() => {
         subscription.dispose();
         reject(new Error(`timed out after ${timeoutMs} ms waiting for ${awaited}`));
      }, timeoutMs);
      const subscription = event(() => {
         const value = check();
         if (value !== undefined) {
            clearTimeout(timer);
            subscription.dispose();
            resolve(value);
         }
      });
   });
}

/** Resolve once something listens on `port` on the loopback interface. */
function accepts(port: number): Promise<void> {
   return new Promise((resolve, reject) => {
      const socket = connect({ port, host: '127.0.0.1' }, () => {
         socket.end();
         resolve();
      });
      socket.once('error', reject);
   });
}

describe('Order Flow extension in a VS Code host', () => {
   before(async () => {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
   });

   afterEach(async () => {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
   });

   it('activates', async () => {
      const extension = vscode.extensions.all.find(candidate => candidate.packageJSON.name === EXTENSION_NAME);
      assert.ok(extension, `${EXTENSION_NAME} is loaded as the extension under development`);
      // Rejects with whatever `activate` threw.
      await extension.activate();
      assert.equal(extension.isActive, true);
   });

   it('answers each head-port command with a port that accepts a connection', async () => {
      for (const command of Object.values(ORDER_FLOW_HOST_PORT_COMMANDS)) {
         const port = await vscode.commands.executeCommand<number>(command);
         assert.ok(typeof port === 'number' && port > 0, `${command} answers with a port, got ${String(port)}`);
         await accepts(port);
      }
   });

   it('opens a .process in the diagram editor by default', async () => {
      // `vscode.open` resolves the editor the way a double-click in the
      // Explorer does: no override, so the manifest's priority decides.
      await vscode.commands.executeCommand('vscode.open', workspaceUri('orders/fulfillment.process'));
      const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
      assert.ok(input instanceof vscode.TabInputCustom, `a custom editor opened, got ${describeTabInput(input)}`);
      assert.equal(input.viewType, ORDER_FLOW_PROCESS_DIAGRAM_VIEW_TYPE);
   });

   it('opens a .process as text through Open With', async () => {
      await vscode.commands.executeCommand('vscode.openWith', workspaceUri('orders/fulfillment.process'), 'default');
      const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
      assert.ok(input instanceof vscode.TabInputText, `a text editor opened, got ${describeTabInput(input)}`);
   });

   it('publishes the language server diagnostics for the workspace', async () => {
      // The fixture's deliberately broken file: it references a type its
      // project cannot see. The server reports it without the file being open,
      // because it validates the whole workspace it walks.
      const broken = workspaceUri('orders/audit-leak.domain');
      const diagnostics = await when(
         vscode.languages.onDidChangeDiagnostics,
         () => {
            const published = vscode.languages.getDiagnostics(broken);
            return published.length > 0 ? published : undefined;
         },
         'diagnostics on orders/audit-leak.domain'
      );
      assert.ok(
         diagnostics.some(diagnostic => diagnostic.message.includes('AuditStamp')),
         `a diagnostic names AuditStamp, got ${diagnostics.map(diagnostic => diagnostic.message).join(' | ')}`
      );
   });

   it('shows the properties panel from its command', async () => {
      await vscode.window.showTextDocument(workspaceUri('orders/fulfillment.process'), { preview: false });
      await vscode.commands.executeCommand('order-flow.properties.show');
      // Webview tabs report the registered view type with a host-side prefix.
      const tab = await when(
         vscode.window.tabGroups.onDidChangeTabs,
         () =>
            vscode.window.tabGroups.all
               .flatMap(group => group.tabs)
               .find(
                  candidate =>
                     candidate.input instanceof vscode.TabInputWebview &&
                     candidate.input.viewType.endsWith(OrderFlowPropertiesPanel.VIEW_TYPE)
               ),
         'a properties panel tab'
      );
      assert.equal(tab.label, 'Order Flow Properties');
   });
});

/** The kind of tab `input` belongs to. Class names are minified in a VS Code build. */
function describeTabInput(input: unknown): string {
   if (input instanceof vscode.TabInputText) {
      return 'a text editor';
   }
   if (input instanceof vscode.TabInputCustom) {
      return `the custom editor ${input.viewType}`;
   }
   return input === undefined ? 'no active tab' : 'another kind of tab';
}
