/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * Semantic token requests over the REAL transport while the push of another
 * client's write is on its way to the editor.
 *
 * The harness answers a push as applied and echoes nothing, so the editor
 * keeps its old text until the test sends the echo. Tokens computed on the
 * written text would be applied to that old text.
 */

import { makeLspServerConnection, type LspServerConnection } from '@hydranium/core/testing/node';
import { startLanguageServer } from '@hydranium/core/lsp';
import { afterEach, describe, expect, it } from 'vitest';
import { LSPErrorCodes } from 'vscode-languageserver';
import { createOrderFlowServices, type OrderFlowSharedServices } from '../src/language-server/order-flow-module.js';

const PROCESS_LANGUAGE_ID = 'order-flow-process';
const URI = 'file:///semantic-tokens-push.process';

const OPENED = `process Handling for Crate {
   task Inspect
}
`;

const WRITTEN = `process Handling for Crate {
   task Inspect
   task Ship
}
`;

let transport: LspServerConnection | undefined;

afterEach(() => {
   transport?.dispose();
   transport = undefined;
});

async function composeServer(): Promise<{ composed: LspServerConnection; shared: OrderFlowSharedServices }> {
   const composed = makeLspServerConnection();
   transport = composed;
   const services = createOrderFlowServices({ connection: composed.serverConnection });
   startLanguageServer(services.shared);
   await composed.initialize();
   await services.shared.workspace.WorkspaceManager.workspaceInitialized;
   return { composed, shared: services.shared };
}

/** The code of the response error `request` rejects with, or `'answered'` when it resolves. */
async function outcome(request: Promise<unknown>): Promise<unknown> {
   try {
      await request;
      return 'answered';
   } catch (error: unknown) {
      return (error as { code?: unknown }).code ?? error;
   }
}

describe('order-flow semantic tokens over the real transport', () => {
   it('answer `ContentModified` until the editor echoes the push of a form write', async () => {
      const { composed, shared } = await composeServer();
      composed.openDocument(URI, OPENED, PROCESS_LANGUAGE_ID, 1);
      const opened = await outcome(composed.semanticTokens(URI));

      const session = shared.model.ModelService.createSession('form', 'form');
      await session.open(URI);
      const pushed = composed.nextAppliedEdit(URI);
      await session.update({ uri: URI, model: WRITTEN, baseVersion: 'any' });
      await pushed;
      const inFlight = await outcome(composed.semanticTokens(URI));

      composed.changeDocument(URI, WRITTEN, 2);
      const echoed = await outcome(composed.semanticTokens(URI));

      expect({ opened, inFlight, echoed }).toEqual({ opened: 'answered', inFlight: LSPErrorCodes.ContentModified, echoed: 'answered' });
   });
});
