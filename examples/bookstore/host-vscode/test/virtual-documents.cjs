/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { TransportKind } = require('vscode-languageclient/node');
const vscode = require('vscode');
const { startBookstoreLanguageClient } = require('bookstore-vscode-servers/out/language-client.js');

module.exports.run = async () => {
   const subscriptions = [];
   const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'content-host-'));
   const client = await startBookstoreLanguageClient(
      { subscriptions },
      {
         module: path.join(__dirname, 'content-server.cjs'),
         transport: TransportKind.ipc
      }
   );
   try {
      const file = path.join(scratch, 'file.bookstore');
      fs.writeFileSync(file, 'node Local');
      await vscode.window.showTextDocument(vscode.Uri.file(file));
      const uri = vscode.Uri.parse('virtual:fixture/library.bookstore');
      const editor = await vscode.window.showTextDocument(uri);
      const position = new vscode.Position(0, 5);
      const hover = await vscode.commands.executeCommand('vscode.executeHoverProvider', uri, position);
      assert.ok(
         hover.some(value => value.contents.some(content => content.value === 'fixture hover')),
         'virtual hover'
      );
      const tokens = await vscode.commands.executeCommand('vscode.provideDocumentSemanticTokens', uri);
      assert.ok(tokens?.data.length, 'virtual semantic tokens');
      const definitions = await vscode.commands.executeCommand('vscode.executeDefinitionProvider', uri, position);
      assert.ok(definitions.length, 'virtual definition');
      const before = editor.document.getText();
      await editor.edit(builder => builder.insert(position, 'changed'));
      assert.equal(editor.document.getText(), before);
      await vscode.languages.setTextDocumentLanguage(editor.document, 'plaintext');
      const received = await client.sendRequest('fixture/sync');
      assert.ok(
         received.some(event => event.method === 'textDocument/didOpen' && event.uri.startsWith('file:')),
         'file sync reaches the server'
      );
      assert.deepEqual(
         received.filter(event => event.uri.startsWith('virtual:')),
         [],
         'no virtual document synchronization reaches the server'
      );
   } finally {
      await client.stop();
      for (const subscription of subscriptions) subscription.dispose();
      fs.rmSync(scratch, { recursive: true, force: true });
   }
};
