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

import {
   DefaultFileSystemProviderRegistry,
   HydraniumWorkspaceManager,
   inMemoryFileSystem,
   type ServerSharedServices,
   type WritableFileSystemProvider
} from '@hydranium/core';
import { HydraniumDocumentUpdateHandler } from '@hydranium/core/lsp';
import { NodeFileSystem } from '@hydranium/core/node';
import { makeCapturingTracer } from '@hydranium/core/testing';
import {
   type LspHarness,
   makeLspHarness,
   makeLspServerConnection,
   makeScratchWorkspace,
   type ScratchWorkspace
} from '@hydranium/core/testing/node';
import { type LangiumDocument, URI } from '@hydranium/langium';
import { NodeFileSystemProvider } from '@hydranium/langium/node';
import { writeFile } from 'node:fs/promises';
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

/**
 * A disk provider as an adopter writes one: it answers for `file:` and knows
 * nothing about `virtual:`.
 */
class DiskOnlyFileSystemProvider extends NodeFileSystemProvider implements WritableFileSystemProvider {
   async writeFile(uri: URI, content: string): Promise<void> {
      await writeFile(uri.fsPath, content);
   }
}

/** A registry that ignores the `fileSystemProviders` group, `virtual:` included. */
class HostOnlyFileSystemProviderRegistry extends DefaultFileSystemProviderRegistry {
   override providerFor(): WritableFileSystemProvider {
      return this.host;
   }
}

const DISK_ONLY_FILE_SYSTEM = { fileSystemProvider: (): WritableFileSystemProvider => new DiskOnlyFileSystemProvider() };

/**
 * Boot on the disk through `diskFileSystem`, or with `memoryFiles` on the
 * in-memory provider under {@link MEMORY_ROOT}.
 */
async function boot(
   memoryFiles?: Record<string, string>,
   diskFileSystem: typeof NodeFileSystem | typeof DISK_ONLY_FILE_SYSTEM = NodeFileSystem,
   extraSharedModules: NonNullable<Parameters<typeof createOrderFlowServices>[1]>['extraSharedModules'] = []
): Promise<{ harness: LspHarness; services: ReturnType<typeof createOrderFlowServices> }> {
   let rootUri = MEMORY_ROOT;
   let fileSystem: typeof diskFileSystem | ReturnType<typeof inMemoryFileSystem> = diskFileSystem;
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
            },
            ...extraSharedModules
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

   it('rebuilds a virtual: built-in library on a provider that knows nothing of virtual:', async () => {
      const { harness, services } = await boot(undefined, DISK_ONLY_FILE_SYSTEM);
      const documents = services.shared.workspace.LangiumDocuments;
      const rebuilt: string[] = [];
      services.shared.workspace.DocumentBuilder.onUpdate(changed => {
         rebuilt.push(...changed.map(uri => uri.toString()));
      });
      const stdlib = ORDER_FLOW_STDLIB_URI.toString();
      expect(documents.hasDocument(ORDER_FLOW_STDLIB_URI)).toBe(true);
      harness.openDocument(stdlib, ORDER_FLOW_STDLIB_SOURCE, 'order-flow-domain', 1);
      await waitFor(() => services.shared.workspace.TextDocuments.get(stdlib) !== undefined, { timeoutMs: 2000 });
      await services.shared.workspace.WorkspaceLock.read(() => undefined);
      rebuilt.length = 0;

      await harness.closeDocument(stdlib);

      // The revert's own rebuild, not merely a document nothing has touched yet.
      await waitFor(() => rebuilt.includes(stdlib), { timeoutMs: 2000, message: `${stdlib} was not rebuilt after its close` });
      expect(documents.getDocument(ORDER_FLOW_STDLIB_URI)?.textDocument.getText()).toBe(ORDER_FLOW_STDLIB_SOURCE);
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

type SharedModule = NonNullable<NonNullable<Parameters<typeof createOrderFlowServices>[1]>['extraSharedModules']>[number];

const LIBRARY_URI = URI.parse('library:/extra.domain');

/** Seeds a document under `library:`, a scheme no provider is registered for. */
const LIBRARY_MODULE: SharedModule = {
   additionalDocuments: {
      library: services => ({
         registerAdditionalDocuments: registry =>
            registry.register(services.workspace.LangiumDocumentFactory.fromString('valuetype Extra {}\n', LIBRARY_URI))
      })
   }
};

const OVERRIDE_URI = URI.parse('library:/override.domain');

/** Seeds a document under `library:` from its own `loadAdditionalDocuments`, bypassing the group. */
class OverrideSeedingWorkspaceManager extends HydraniumWorkspaceManager {
   constructor(protected readonly shared: ServerSharedServices) {
      super(shared);
   }

   protected override async loadAdditionalDocuments(
      folders: Parameters<HydraniumWorkspaceManager['loadAdditionalDocuments']>[0],
      collector: (document: LangiumDocument) => void
   ): Promise<void> {
      await super.loadAdditionalDocuments(folders, collector);
      collector(this.shared.workspace.LangiumDocumentFactory.fromString('valuetype Override {}\n', OVERRIDE_URI));
   }
}

describe('a seeded document the bound provider cannot serve', () => {
   /** Boot with a capturing tracer and return the unserved-document warnings logged by workspace startup. */
   async function startupWarnings(...modules: SharedModule[]): Promise<string[]> {
      const { tracer, lines } = makeCapturingTracer();
      const { services } = await boot(undefined, NodeFileSystem, [{ Tracer: () => tracer }, ...modules]);
      await services.shared.workspace.WorkspaceManager.workspaceInitialized;
      return lines.filter(line => line.level === 'warn' && line.message.includes('workspace.FileSystemProvider')).map(line => line.message);
   }

   it('warns once at startup when the slot is rebound to a registry that sends virtual: to a host that knows nothing of it', async () => {
      const warnings = await startupWarnings({
         workspace: {
            FileSystemProvider: services => new HostOnlyFileSystemProviderRegistry(services, { host: new DiskOnlyFileSystemProvider() })
         }
      });

      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain(ORDER_FLOW_STDLIB_URI.toString());
      expect(warnings[0]).toContain('fileSystemProviders');
   });

   it('warns once at startup for a seeded document under a scheme no provider is registered for', async () => {
      const warnings = await startupWarnings(LIBRARY_MODULE);

      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain(LIBRARY_URI.toString());
      expect(warnings[0]).toContain('library:');
      expect(warnings[0]).not.toContain(ORDER_FLOW_STDLIB_URI.toString());
   });

   it('warns for a document a loadAdditionalDocuments override seeds under a scheme no provider is registered for', async () => {
      const warnings = await startupWarnings({
         workspace: { WorkspaceManager: services => new OverrideSeedingWorkspaceManager(services) }
      });

      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain(OVERRIDE_URI.toString());
      expect(warnings[0]).toContain('library:');
      expect(warnings[0]).not.toContain(ORDER_FLOW_STDLIB_URI.toString());
   });

   it('asks the provider about the seeded documents only, none the workspace traversal found', async () => {
      const asked: string[] = [];
      class RecordingProvider extends DiskOnlyFileSystemProvider {
         override exists(uri: URI): Promise<boolean> {
            asked.push(uri.toString());
            return super.exists(uri);
         }
      }
      await startupWarnings(LIBRARY_MODULE, {
         workspace: {
            FileSystemProvider: services => new DefaultFileSystemProviderRegistry(services, { host: new RecordingProvider() })
         }
      });

      expect(asked).toEqual([LIBRARY_URI.toString()]);
   });

   it('stays quiet when warnUnservedDocuments is false', async () => {
      const warnings = await startupWarnings(LIBRARY_MODULE, {
         workspace: { WorkspaceManager: services => new HydraniumWorkspaceManager(services, { warnUnservedDocuments: false }) }
      });

      expect(warnings).toEqual([]);
   });

   it('stays quiet on the framework’s own registry', async () => {
      expect(await startupWarnings()).toEqual([]);
   });
});
