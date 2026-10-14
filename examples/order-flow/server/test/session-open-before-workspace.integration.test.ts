/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * A session open that arrives before the workspace is brought up waits for it.
 *
 * Opened first, the document links against a workspace that holds only itself,
 * and the bring-up's build does not relink it: its cross-file references stay
 * unresolved after the workspace is up, with nothing to say why. An LSP head's
 * open waits for the initial build for that reason; a session's open, the one
 * the data and GLSP heads make, has to wait the same.
 */

import { type ClientSession, initializeWorkspaceProgrammatically, SessionClosedError } from '@hydranium/core';
import { type ScratchWorkspace, makeScratchWorkspace } from '@hydranium/core/testing/node';
import { type AstNode, URI } from '@hydranium/langium';
import * as path from 'node:path';
import { Diagnostic } from 'vscode-languageserver-protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { WORKSPACE_FILES, WORKSPACE_ROOT, makeServices } from './order-flow-harness.js';

let workspace: ScratchWorkspace | undefined;

afterEach(() => {
   workspace?.dispose();
   workspace = undefined;
});

interface Reached {
   readonly openBeforeBringUp: boolean;
   readonly unresolved: string[];
}

/**
 * Start `reach` on `relativePath` before the bring-up; report whether the
 * document was open in the store before it, and its unresolved references once
 * it is validated after.
 */
async function reachBeforeBringUp(
   relativePath: string,
   reach: (session: ClientSession<AstNode>, uri: string) => Promise<unknown>
): Promise<Reached> {
   workspace = makeScratchWorkspace({ seed: WORKSPACE_ROOT, prefix: 'order-flow-open-before-workspace-' });
   const harness = makeServices();
   const modelService = harness.shared.model.ModelService;
   const uri = URI.file(path.join(workspace.root, relativePath)).toString();
   const reaching = reach(modelService.createSession('early', 'early'), uri);
   // A timer, long enough for an open that does not wait to read the file and
   // build it.
   await new Promise(resolve => setTimeout(resolve, 200));
   const openBeforeBringUp = harness.shared.workspace.TextDocuments.isOpen(uri);

   await initializeWorkspaceProgrammatically(harness.shared, workspace.root);
   await reaching;
   const document = await modelService.validated(uri);
   const unresolved = (document.diagnostics ?? [])
      .map(diagnostic => Diagnostic.getMessageString(diagnostic))
      .filter(message => message.startsWith('Could not resolve reference'));
   return { openBeforeBringUp, unresolved };
}

describe('a session that reaches the store before the workspace is brought up', () => {
   it('opens a document only after the bring-up, so it links against the whole workspace', async () => {
      const reached = await reachBeforeBringUp(WORKSPACE_FILES.fulfillmentProcess, (session, uri) => session.open(uri));
      expect(reached).toEqual({ openBeforeBringUp: false, unresolved: [] });
   }, 30_000);

   it('creates a document only after the bring-up, so it links against the whole workspace', async () => {
      const reached = await reachBeforeBringUp('orders/extra.domain', (session, uri) =>
         session.create(uri, 'entity Extra {\n   order: Order\n}\n')
      );
      expect(reached).toEqual({ openBeforeBringUp: false, unresolved: [] });
   }, 30_000);

   it('opens nothing for a session that ended while it waited', async () => {
      workspace = makeScratchWorkspace({ seed: WORKSPACE_ROOT, prefix: 'order-flow-open-before-workspace-' });
      const harness = makeServices();
      const session = harness.shared.model.ModelService.createSession('early', 'early');
      const uri = URI.file(path.join(workspace.root, WORKSPACE_FILES.fulfillmentProcess)).toString();
      const opened: string[] = [];
      harness.shared.workspace.TextDocuments.onDidOpen(event => opened.push(event.clientId));
      const opening = session.open(uri).then(
         () => 'opened',
         (error: unknown) => (error instanceof SessionClosedError ? 'closed' : String(error))
      );
      session.dispose();

      await initializeWorkspaceProgrammatically(harness.shared, workspace.root);
      // Not even briefly: a listener of the store would act on an open no
      // session owns.
      expect({ outcome: await opening, opened }).toEqual({ outcome: 'closed', opened: [] });
   }, 30_000);
});
