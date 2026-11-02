/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

// A content-owning LSP fixture. The query answers after preceding sync messages.
const received = [];
const range = { start: { line: 0, character: 5 }, end: { line: 0, character: 10 } };
process.on('message', message => {
   const { id, method, params } = message;
   if (method?.startsWith('textDocument/did') || method?.startsWith('textDocument/will')) {
      received.push({ method, uri: params.textDocument.uri });
   }
   if (id === undefined) return;
   let result = null;
   switch (method) {
      case 'initialize':
         result = {
            capabilities: {
               textDocumentSync: { openClose: true, change: 2, save: true, willSave: true, willSaveWaitUntil: true },
               hoverProvider: true,
               definitionProvider: true,
               semanticTokensProvider: { legend: { tokenTypes: ['type'], tokenModifiers: [] }, full: true },
               workspace: { textDocumentContent: { schemes: ['virtual'] } }
            }
         };
         break;
      case 'workspace/textDocumentContent':
         result = { text: 'node First' };
         break;
      case 'textDocument/hover':
         result = { contents: { kind: 'markdown', value: 'fixture hover' } };
         break;
      case 'textDocument/semanticTokens/full':
         result = { data: [0, 5, 5, 0, 0] };
         break;
      case 'textDocument/definition':
         result = { uri: params.textDocument.uri, range };
         break;
      case 'fixture/sync':
         result = received;
         break;
   }
   process.send({ jsonrpc: '2.0', id, result });
});
