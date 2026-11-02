/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * A definition in the stdlib answers with a `virtual:` URI, which no client
 * can read from a file system. The server sends its text instead.
 */

import { startLanguageServer } from '@hydranium/core/lsp';
import { makeLspServerConnection, type LspServerConnection } from '@hydranium/core/testing/node';
import { afterEach, describe, expect, it } from 'vitest';
import { type LocationLink, TextDocumentContentRequest, type TextDocumentContentResult } from 'vscode-languageserver';
import { createOrderFlowServices } from '../src/language-server/order-flow-module.js';
import { ORDER_FLOW_STDLIB_SOURCE, ORDER_FLOW_STDLIB_URI } from '../src/language-server/order-flow-stdlib.js';

const DOMAIN_URI = 'file:///virtual-document-content.domain';

const DOMAIN = `entity Crate {
   a : String
}
`;

let transport: LspServerConnection | undefined;

afterEach(() => {
   transport?.dispose();
   transport = undefined;
});

async function composeServer(): Promise<{ composed: LspServerConnection; schemes: string[] | undefined }> {
   const composed = makeLspServerConnection();
   transport = composed;
   const services = createOrderFlowServices({ connection: composed.serverConnection });
   startLanguageServer(services.shared);
   const result = await composed.initialize();
   await services.shared.workspace.WorkspaceManager.workspaceInitialized;
   return { composed, schemes: result.capabilities.workspace?.textDocumentContent?.schemes };
}

describe('order-flow virtual document content', () => {
   it('sends the text of the stdlib a definition lands in', async () => {
      const { composed, schemes } = await composeServer();
      composed.openDocument(DOMAIN_URI, DOMAIN, 'order-flow-domain', 1);

      const [target] = await composed.client.sendRequest<LocationLink[]>('textDocument/definition', {
         textDocument: { uri: DOMAIN_URI },
         position: { line: 1, character: 8 }
      });
      const content = await composed.client.sendRequest<TextDocumentContentResult | null>(TextDocumentContentRequest.method, {
         uri: target.targetUri
      });

      expect({ schemes, target: target.targetUri, text: content?.text }).toEqual({
         schemes: ['virtual'],
         target: ORDER_FLOW_STDLIB_URI.toString(),
         text: ORDER_FLOW_STDLIB_SOURCE
      });
   });

   it('has no text for a file URI, which the client reads itself', async () => {
      const { composed } = await composeServer();
      composed.openDocument(DOMAIN_URI, DOMAIN, 'order-flow-domain', 1);

      const content = await composed.client.sendRequest<TextDocumentContentResult | null>(TextDocumentContentRequest.method, {
         uri: DOMAIN_URI
      });

      expect(content).toBeNull();
   });
});
