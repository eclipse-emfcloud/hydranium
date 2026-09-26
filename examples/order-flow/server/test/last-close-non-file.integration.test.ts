/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * The last close of a document with no `file:` URI, over the real LSP wire:
 * rebuilt from the file system provider when the provider can serve it,
 * removed from the workspace when it cannot.
 *
 * The update handler debounces for a minute, so an edit stays pending until a
 * test flushes it, and a close can arrive while one is still pending.
 */

import { inMemoryFileSystem, type ServerSharedServices } from '@hydranium/core';
import { HydraniumDocumentUpdateHandler } from '@hydranium/core/lsp';
import { NodeFileSystem } from '@hydranium/core/node';
import {
   type LspHarness,
   makeLspHarness,
   makeLspServerConnection,
   makeScratchWorkspace,
   type ScratchWorkspace
} from '@hydranium/core/testing/node';
import { URI } from '@hydranium/langium';
import { tick, waitFor } from '@hydranium/protocol/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { Diagnostic } from 'vscode-languageserver-protocol';
import { isDomainModel } from '../src/language-server/ast.js';
import { createOrderFlowServices } from '../src/language-server/order-flow-module.js';
import { ORDER_FLOW_STDLIB_SOURCE, ORDER_FLOW_STDLIB_URI } from '../src/language-server/order-flow-stdlib.js';
import { WORKSPACE_FILES, WORKSPACE_ROOT } from './order-flow-harness.js';

const UNTITLED = 'untitled:/Untitled-1.domain';
const CLEAN = 'entity Solo {\n   a : string\n}\n';
const FIRST = 'entity Solo {\n   a : string\n   b : string\n}\n';
const LAST = 'entity Solo {\n   a : string\n   c : string\n}\n';

let workspace: ScratchWorkspace | undefined;
let lsp: LspHarness | undefined;

afterEach(() => {
   lsp?.dispose();
   lsp = undefined;
   workspace?.dispose();
   workspace = undefined;
});

const MEMORY_ROOT = 'memory:///order-flow';
const MEMORY_SOLO = `${MEMORY_ROOT}/solo.domain`;

/** Boot on the disk, or with `memoryFiles` on the in-memory provider under {@link MEMORY_ROOT}. */
async function boot(
   memoryFiles?: Record<string, string>
): Promise<{ harness: LspHarness; services: ReturnType<typeof createOrderFlowServices> }> {
   let rootUri = MEMORY_ROOT;
   let fileSystem: typeof NodeFileSystem | ReturnType<typeof inMemoryFileSystem> = NodeFileSystem;
   if (memoryFiles) {
      fileSystem = inMemoryFileSystem({ seed: memoryFiles });
   } else {
      workspace = makeScratchWorkspace({ seed: WORKSPACE_ROOT, prefix: 'order-flow-non-file-close-' });
      rootUri = workspace.uri();
   }
   const wire = makeLspServerConnection();
   const services = createOrderFlowServices(
      { ...fileSystem, connection: wire.serverConnection },
      {
         extraSharedModules: [
            {
               lsp: {
                  DocumentUpdateHandler: (shared: ServerSharedServices) =>
                     new HydraniumDocumentUpdateHandler(shared, { debounceMs: 60_000 })
               }
            }
         ]
      }
   );
   const harness = makeLspHarness({ connection: wire, services: services.shared });
   lsp = harness;
   await harness.initialize({ workspaceFolders: [{ uri: rootUri, name: 'order-flow' }] });
   return { harness, services };
}

/**
 * Wait out the store's release of `uri` and the revert it would queue behind
 * the write lock, for a test asserting that the revert changed nothing.
 */
async function released(services: ReturnType<typeof createOrderFlowServices>, uri: string): Promise<void> {
   await waitFor(() => services.shared.workspace.TextDocuments.get(uri) === undefined, { timeoutMs: 2000 });
   await tick(50);
   await services.shared.workspace.WorkspaceLock.read(() => undefined);
}

describe('the last close of a non-file document', () => {
   it('removes an untitled: document the provider cannot serve, stale build and all', async () => {
      const { harness, services } = await boot();
      const documents = services.shared.workspace.LangiumDocuments;
      const handler = services.shared.lsp.DocumentUpdateHandler;
      const built = (): string | undefined => documents.getDocument(URI.parse(UNTITLED))?.textDocument.getText();
      harness.openDocument(UNTITLED, CLEAN, 'order-flow-domain', 1);
      await waitFor(() => built() === CLEAN, { timeoutMs: 2000 });
      harness.changeDocument(UNTITLED, FIRST, 2);
      await waitFor(() => services.shared.workspace.TextDocuments.get(UNTITLED)?.getText() === FIRST, { timeoutMs: 2000 });
      handler.flushPending();
      await waitFor(() => built() === FIRST, { timeoutMs: 2000 });
      // Stays debounced: the close drops it.
      harness.changeDocument(UNTITLED, LAST, 3);
      await waitFor(() => services.shared.workspace.TextDocuments.get(UNTITLED)?.getText() === LAST, { timeoutMs: 2000 });

      await harness.closeDocument(UNTITLED);

      await waitFor(() => !documents.hasDocument(URI.parse(UNTITLED)), { timeoutMs: 2000, message: `${UNTITLED} stayed in the workspace` });
   });

   it('rebuilds a virtual: built-in library the editor opens and closes, keeping every reference to it', async () => {
      const { harness, services } = await boot();
      const documents = services.shared.workspace.LangiumDocuments;
      const rebuilt: string[] = [];
      services.shared.workspace.DocumentBuilder.onUpdate(changed => {
         rebuilt.push(...changed.map(uri => uri.toString()));
      });
      const stdlib = ORDER_FLOW_STDLIB_URI.toString();
      const money = URI.file(workspace!.resolve(WORKSPACE_FILES.commerceCoreMoney));
      const unresolved = (): string[] =>
         (documents.getDocument(money)?.diagnostics ?? [])
            .map(diagnostic => Diagnostic.getMessageString(diagnostic))
            .filter(message => message.includes('String'));
      expect(documents.hasDocument(ORDER_FLOW_STDLIB_URI)).toBe(true);
      expect(unresolved()).toEqual([]);
      harness.openDocument(stdlib, ORDER_FLOW_STDLIB_SOURCE, 'order-flow-domain', 1);
      await waitFor(() => services.shared.workspace.TextDocuments.get(stdlib) !== undefined, { timeoutMs: 2000 });
      // The open's own build is dispatched under the lock; wait it out first.
      await services.shared.workspace.WorkspaceLock.read(() => undefined);
      rebuilt.length = 0;

      await harness.closeDocument(stdlib);
      await released(services, stdlib);

      expect(rebuilt).toContain(stdlib);
      expect(documents.getDocument(ORDER_FLOW_STDLIB_URI)?.textDocument.getText()).toBe(ORDER_FLOW_STDLIB_SOURCE);
      expect(unresolved()).toEqual([]);
   });

   it('keeps the edit of a virtual: document after its close, since the provider serves the index’s text', async () => {
      const { harness, services } = await boot();
      const documents = services.shared.workspace.LangiumDocuments;
      const stdlib = ORDER_FLOW_STDLIB_URI.toString();
      const edited = `${ORDER_FLOW_STDLIB_SOURCE}\nvaluetype Edited {}\n`;
      const pending = `${edited}\nvaluetype Pending {}\n`;
      const built = (): string | undefined => documents.getDocument(ORDER_FLOW_STDLIB_URI)?.textDocument.getText();
      const declared = (): string[] => {
         const root = documents.getDocument(ORDER_FLOW_STDLIB_URI)?.parseResult.value;
         return isDomainModel(root) ? root.declarations.map(declaration => declaration.name) : [];
      };
      harness.openDocument(stdlib, ORDER_FLOW_STDLIB_SOURCE, 'order-flow-domain', 1);
      harness.changeDocument(stdlib, edited, 2);
      await waitFor(() => services.shared.workspace.TextDocuments.get(stdlib)?.getText() === edited, { timeoutMs: 2000 });
      services.shared.lsp.DocumentUpdateHandler.flushPending();
      await waitFor(() => built() === edited, { timeoutMs: 2000 });
      // Stays debounced: the close drops the change, and the revert builds its
      // text.
      harness.changeDocument(stdlib, pending, 3);
      await waitFor(() => services.shared.workspace.TextDocuments.get(stdlib)?.getText() === pending, { timeoutMs: 2000 });

      await harness.closeDocument(stdlib);
      await released(services, stdlib);

      expect(built()).toBe(pending);
      await waitFor(() => declared().includes('Pending'), { timeoutMs: 2000, message: 'the revert did not build the edited text' });
   });

   it('reverts a model file of a workspace on the in-memory provider to the provider’s text', async () => {
      const { harness, services } = await boot({ [MEMORY_SOLO]: CLEAN });
      const documents = services.shared.workspace.LangiumDocuments;
      const built = (): string | undefined => documents.getDocument(URI.parse(MEMORY_SOLO))?.textDocument.getText();
      expect(built()).toBe(CLEAN);
      harness.openDocument(MEMORY_SOLO, CLEAN, 'order-flow-domain', 1);
      harness.changeDocument(MEMORY_SOLO, FIRST, 2);
      await waitFor(() => services.shared.workspace.TextDocuments.get(MEMORY_SOLO)?.getText() === FIRST, { timeoutMs: 2000 });
      services.shared.lsp.DocumentUpdateHandler.flushPending();
      await waitFor(() => built() === FIRST, { timeoutMs: 2000 });

      await harness.closeDocument(MEMORY_SOLO);

      await waitFor(() => built() === CLEAN, { timeoutMs: 2000, message: `${MEMORY_SOLO} kept its unsaved text or left the workspace` });
   });
});
