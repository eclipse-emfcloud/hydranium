/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { textDocumentSyncMiddleware } from '@hydranium/client-vscode/node';
import { LanguageClient, TransportKind } from 'vscode-languageclient/node';
import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { toLogFileWorkspaceToken } from '@hydranium/core';
import { DEFAULT_LOG_FILE_ENV } from '@hydranium/protocol';
import * as vscode from 'vscode';

describe('order-flow virtual documents in a VS Code host', () => {
   it('serves language features without opening a server sync document', async () => {
      const folder = vscode.workspace.workspaceFolders?.[0];
      assert.ok(folder);
      const extension = vscode.extensions.all.find(
         candidate => candidate.packageJSON.name === '@hydranium/example-order-flow-vscode-servers'
      );
      assert.ok(extension);
      await extension.activate();
      const domain = vscode.Uri.joinPath(folder.uri, 'orders/orders.domain');
      await vscode.window.showTextDocument(domain);
      const definitions = await vscode.commands.executeCommand<Array<vscode.Location | vscode.LocationLink>>(
         'vscode.executeDefinitionProvider',
         domain,
         new vscode.Position(23, 16)
      );
      assert.ok(definitions?.length);
      const first = definitions[0];
      const target = 'targetUri' in first ? first.targetUri : first.uri;
      assert.equal(target.scheme, 'virtual');
      const editor = await vscode.window.showTextDocument(target);
      const position = new vscode.Position(2, 12);
      const hover = await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', target, position);
      assert.ok(hover?.length, 'hover in the library');
      const tokens = await vscode.commands.executeCommand<vscode.SemanticTokens>('vscode.provideDocumentSemanticTokens', target);
      assert.ok(tokens?.data.length, 'semantic tokens in the library');
      const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>('vscode.executeDocumentSymbolProvider', target);
      assert.ok(symbols?.length, 'symbols in the library');
      const definition = await vscode.commands.executeCommand<unknown[]>('vscode.executeDefinitionProvider', target, position);
      assert.ok(definition?.length, 'definition in the library');
      const references = await vscode.commands.executeCommand<vscode.Location[]>('vscode.executeReferenceProvider', target, position);
      assert.ok(references?.length, 'references in the library');
      const before = editor.document.getText();
      await editor.edit(builder => builder.insert(new vscode.Position(0, 0), 'changed'));
      assert.equal(editor.document.getText(), before);
      assert.equal(editor.document.isDirty, false);
      const logTemplate = process.env[DEFAULT_LOG_FILE_ENV];
      assert.ok(logTemplate, 'the host runner configures server log capture');
      const log = readFileSync(logTemplate.replace('{workspace}', toLogFileWorkspaceToken(folder.uri.toString())), 'utf8');
      const opens = log.split('\n').filter(line => line.includes('Open document:') && line.includes('language-client'));
      assert.ok(
         opens.some(line => line.includes('orders.domain')),
         'file sync proves the server log observes opens'
      );
      assert.equal(
         opens.some(line => line.includes('virtual:')),
         false,
         'virtual documents never reach server sync'
      );
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
   });
   it('filters the close caused by a virtual document changing language', async () => {
      const sync = textDocumentSyncMiddleware(() => client);
      let closed = false;
      let forwarded = false;
      const client = new LanguageClient(
         'virtual-close',
         'Virtual close',
         {
            module: require.resolve('@hydranium/example-order-flow-server/lib/main.js'),
            transport: TransportKind.ipc
         },
         {
            documentSelector: [{ scheme: 'virtual', language: 'order-flow-domain' }],
            middleware: {
               ...sync,
               didClose: (document, next) => {
                  closed = true;
                  return sync.didClose(document, value => {
                     forwarded = true;
                     return next(value);
                  });
               }
            }
         }
      );
      await client.start();
      try {
         const document = await vscode.workspace.openTextDocument(vscode.Uri.parse('virtual:order-flow-builtin/primitives.domain'));
         await vscode.languages.setTextDocumentLanguage(document, 'order-flow-domain');
         await vscode.languages.setTextDocumentLanguage(document, 'plaintext');
         assert.equal(closed, true, 'a language change reaches didClose even when didOpen was suppressed');
         assert.equal(forwarded, false);
         await vscode.languages.setTextDocumentLanguage(document, 'order-flow-domain');
      } finally {
         await client.stop();
      }
   });
});
