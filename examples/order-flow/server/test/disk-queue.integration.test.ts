/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * The per-file disk queue against the real manager and the real text store's
 * revert: a client saves and then closes as the last client, and the revert
 * that close triggers reads the file only after the save has written it.
 *
 * The LSP head is attached so the revert, which the text store runs for every
 * head, is exercised beside the editor's own event flow. Writes are held by a
 * provider gate, so the revert has a window in which reading the file would
 * return the text from before the save.
 */

import { serverSharedFactory } from '@hydranium/core';
import { DefaultFileSystemProvider } from '@hydranium/core/node';
import {
   type LspHarness,
   makeLspHarness,
   makeLspServerConnection,
   makeScratchWorkspace,
   type ScratchWorkspace
} from '@hydranium/core/testing/node';
import { DocumentState, URI } from '@hydranium/langium';
import { tick, waitFor } from '@hydranium/protocol/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { createOrderFlowServices } from '../src/language-server/order-flow-module.js';
import { WORKSPACE_ROOT } from './order-flow-harness.js';

const FILE = 'queue.domain';
const CLEAN = `entity Solo {
   a : string
}
`;
const EDITED = `entity Solo {
   a : string
   b : string
}
`;

let workspace: ScratchWorkspace | undefined;
let lsp: LspHarness | undefined;

afterEach(() => {
   // A test that failed before releasing would leave every later write held.
   GatedFileSystemProvider.release?.();
   lsp?.dispose();
   lsp = undefined;
   workspace?.dispose();
   workspace = undefined;
});

/** Holds every write while a gate is set, so a test can act while a save is on its way to disk. */
class GatedFileSystemProvider extends DefaultFileSystemProvider {
   static gate: Promise<void> | undefined;
   static release: (() => void) | undefined;

   override async writeFile(uri: URI, content: string): Promise<void> {
      await GatedFileSystemProvider.gate;
      return super.writeFile(uri, content);
   }
}

function holdWrites(): () => void {
   let resolveGate: () => void = () => undefined;
   GatedFileSystemProvider.gate = new Promise<void>(resolve => {
      resolveGate = resolve;
   });
   GatedFileSystemProvider.release = () => {
      GatedFileSystemProvider.gate = undefined;
      GatedFileSystemProvider.release = undefined;
      resolveGate();
   };
   return GatedFileSystemProvider.release;
}

describe('a save followed by the last close', () => {
   it('reverts the document to the saved text, reading the file after the save has written it', async () => {
      workspace = makeScratchWorkspace({ seed: WORKSPACE_ROOT, prefix: 'order-flow-disk-queue-' });
      workspace.write(FILE, CLEAN);
      const wire = makeLspServerConnection();
      const services = createOrderFlowServices({
         connection: wire.serverConnection,
         fileSystemProvider: serverSharedFactory(shared => new GatedFileSystemProvider(shared))
      });
      lsp = makeLspHarness({ connection: wire, services: services.shared });
      await lsp.initialize({ workspaceFolders: [{ uri: workspace.uri(), name: 'order-flow' }] });
      const shared = services.shared;
      const models = shared.model.ModelService;
      const uri = workspace.uri(FILE);

      const session = models.createSession('form', 'form');
      await session.open(uri);
      await session.update({ uri, model: EDITED, baseVersion: 'any' });
      let rebuilds = 0;
      shared.workspace.DocumentBuilder.onUpdate(changed => {
         rebuilds += changed.filter(changedUri => changedUri.toString() === uri).length;
      });

      const release = holdWrites();
      const saved = shared.workspace.AstDocumentManager.save(uri, 'form');
      await session.close(uri);
      // Long enough for a revert that does not wait for the save to rebuild.
      await tick(50);
      release();
      await saved;
      await waitFor(() => rebuilds > 0);
      await models.waitForBuilderState(DocumentState.Validated);

      expect(shared.workspace.LangiumDocuments.getDocument(URI.parse(uri))?.textDocument.getText()).toBe(EDITED);
   });
});
