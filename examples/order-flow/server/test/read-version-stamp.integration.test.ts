/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * Reads while an editor's change waits out the debounce, over the real LSP
 * wire: the built document still holds the previous root while the store's
 * text document, which it shares, already has the new text.
 *
 * The update handler debounces for a minute, so the change stays unbuilt until
 * a test flushes it.
 */

import { rmSync } from 'node:fs';
import { initializeWorkspaceProgrammatically, type ServerSharedServices } from '@hydranium/core';
import { HydraniumDocumentUpdateHandler } from '@hydranium/core/lsp';
import { NodeFileSystem } from '@hydranium/core/node';
import {
   type LspHarness,
   makeLspHarness,
   makeLspServerConnection,
   makeScratchWorkspace,
   type ScratchWorkspace
} from '@hydranium/core/testing/node';
import { DataServer } from '@hydranium/data-server';
import { type AstNode, DocumentState, type LangiumDocument, type Mutable, OperationCancelled, URI, UriUtils } from '@hydranium/langium';
import { type DataServerHarness, makeDataServerHarness } from '@hydranium/data-server/testing';
import {
   isConflictError,
   type ModelVersion,
   STALE_VERSION,
   textHash,
   type TransferDocument,
   UNRECORDED_VERSION
} from '@hydranium/protocol';
import { tick, waitFor } from '@hydranium/protocol/testing';
import { type CancellationToken, CancellationTokenSource } from 'vscode-languageserver';
import { afterEach, describe, expect, it, onTestFinished } from 'vitest';
import type { DomainModel } from '../src/language-server/generated-hydranium/transfer-model.js';
import { createOrderFlowServices } from '../src/language-server/order-flow-module.js';
import { makeScratchWorkspaceHarness, makeServices, type OrderFlowHarness, WORKSPACE_ROOT } from './order-flow-harness.js';
const FILE = 'read-version-stamp.domain';
const CLEAN = 'entity Solo {\n   a : string\n}\n';
const EDITED = 'entity Solo {\n   a : string\n   b : string\n}\n';

type Head = DataServerHarness<DataServer<DomainModel>, DomainModel>;

let workspace: ScratchWorkspace | undefined;
let lsp: LspHarness | undefined;
let head: Head | undefined;

afterEach(() => {
   head?.dispose();
   head = undefined;
   lsp?.dispose();
   lsp = undefined;
   workspace?.dispose();
   workspace = undefined;
});

/**
 * Open {@link FILE} in the editor and through a watching `form` session, then
 * change it in the editor, leaving the change unbuilt.
 */
async function changeDuringDebounce(): Promise<{
   head: Head;
   services: ReturnType<typeof createOrderFlowServices>;
   uri: string;
   opened: TransferDocument<DomainModel>;
   /** The store's version of the text the editor opened. */
   openedAt: number;
}> {
   workspace = makeScratchWorkspace({ seed: WORKSPACE_ROOT, prefix: 'order-flow-read-version-' });
   workspace.write(FILE, CLEAN);
   const uri = workspace.uri(FILE);
   const wire = makeLspServerConnection();
   const services = createOrderFlowServices(
      { ...NodeFileSystem, connection: wire.serverConnection },
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
   lsp = makeLspHarness({ connection: wire, services: services.shared });
   await lsp.initialize({ workspaceFolders: [{ uri: workspace.uri(), name: 'order-flow' }] });
   head = makeDataServerHarness<DataServer<DomainModel>, DomainModel>({
      server: channel => new DataServer<DomainModel>(channel, services.shared)
   });
   const store = services.shared.workspace.TextDocuments;
   await head.proxy.createSession({ clientId: 'form' });

   lsp.openDocument(uri, CLEAN, 'order-flow-domain', 1);
   await waitFor(() => store.get(uri)?.getText() === CLEAN, { timeoutMs: 2000 });
   const openedAt = store.version(uri);
   const opened = await head.proxy.openModelDocument({ uri, clientId: 'form' });
   await head.proxy.watchModelDocument({ uri, clientId: 'form' });
   lsp.changeDocument(uri, EDITED, 2);
   await waitFor(() => store.get(uri)?.getText() === EDITED, { timeoutMs: 2000 });

   return { head, services, uri, opened, openedAt };
}

describe('a read while an editor change is debounced', () => {
   it('answers once the change is built, with the root parsed from it', async () => {
      const { head, services, uri, openedAt } = await changeDuringDebounce();
      const textVersion = services.shared.workspace.TextDocuments.version(uri);

      // The debounce still holds the edit, so the wait below has to wait.
      expect(services.shared.model.ModelService.snapshot(uri)?.version).toBeLessThan(textVersion);
      const reading = head.proxy.getModelDocument({ uri });
      services.shared.lsp.DocumentUpdateHandler.flushPending();
      const read = await reading;

      expect({
         holdsEdit: JSON.stringify(read.model?.root).includes('"b"'),
         version: read.model?.version,
         text: read.text?.version
      }).toEqual({
         holdsEdit: true,
         version: textVersion,
         text: textVersion
      });
      expect(textVersion).toBeGreaterThan(openedAt);
   });

   it.each(['settled', 'validated'] as const)('holds ModelService.%s until the change is built', async phase => {
      const { services, uri } = await changeDuringDebounce();
      const textVersion = services.shared.workspace.TextDocuments.version(uri);

      // The debounce still holds the edit, so the wait below has to wait.
      expect(services.shared.model.ModelService.snapshot(uri)?.version).toBeLessThan(textVersion);
      const waiting = services.shared.model.ModelService[phase](uri);
      services.shared.lsp.DocumentUpdateHandler.flushPending();
      const built = await waiting;

      expect({ parsedFrom: built.root.$cstNode?.root.fullText, version: built.version }).toEqual({
         parsedFrom: EDITED,
         version: textVersion
      });
   });

   it('builds the change once for a wait that starts during the debounce', async () => {
      const { services, uri } = await changeDuringDebounce();
      const builder = services.shared.workspace.DocumentBuilder;
      const lock = services.shared.workspace.WorkspaceLock;
      const counts = { builds: 0, validated: 0 };
      const listeners = [
         builder.onUpdate(changed => {
            counts.builds += changed.filter(changedUri => UriUtils.equals(changedUri, URI.parse(uri))).length;
         }),
         builder.onDocumentPhase(DocumentState.Validated, document => {
            counts.validated += UriUtils.equals(document.uri, URI.parse(uri)) ? 1 : 0;
         })
      ];
      onTestFinished(() => listeners.forEach(listener => listener.dispose()));

      const waiting = services.shared.model.ModelService.validated(uri);
      // Lets the wait request its sync build, and a build it requests run.
      await tick();
      await lock.read(() => undefined);
      services.shared.lsp.DocumentUpdateHandler.flushPending();
      const read = await waiting;
      await lock.read(() => undefined);

      expect({ ...counts, version: read.version }).toEqual({
         builds: 1,
         validated: 1,
         version: services.shared.workspace.TextDocuments.version(uri)
      });
   });

   it('rejects a wait for the change once its token is cancelled', async () => {
      const { services, uri } = await changeDuringDebounce();
      const textVersion = services.shared.workspace.TextDocuments.version(uri);
      const cancel = new CancellationTokenSource();

      // The debounce still holds the edit, so the wait below has to wait.
      expect(services.shared.model.ModelService.snapshot(uri)?.version).toBeLessThan(textVersion);
      const waiting = services.shared.model.ModelService.settled(uri, cancel.token);
      cancel.cancel();

      await expect(waiting).rejects.toBe(OperationCancelled);
   });

   it('rejects a wait whose token is cancelled once the state is reached, though a parse lands before the cancellation is heard', async () => {
      const { services, uri } = await changeDuringDebounce();
      const models = services.shared.model.ModelService;
      const sync = services.shared.workspace.VersionSyncService;
      const cancel = new CancellationTokenSource();
      const syncTo = sync.syncTo.bind(sync);
      let armed = true;
      sync.syncTo = (target, version) => {
         const behind = syncTo(target, version);
         if (armed && behind) {
            armed = false;
            cancel.cancel();
            // A token cancelled already reports to its listeners a macrotask later; this parse lands first.
            const document = models.getDocument(uri) as Mutable<LangiumDocument>;
            void services.shared.workspace.LangiumDocumentFactory.update(document, new CancellationTokenSource().token);
         }
         return behind;
      };

      const waiting = models.ensureDocumentState(uri, DocumentState.Parsed, cancel.token);

      await expect(waiting).rejects.toBe(OperationCancelled);
   });

   it('answers at the state alone inside the write lock, where the build cannot start', async () => {
      const { services, uri, openedAt } = await changeDuringDebounce();
      let version: number | undefined;

      await services.shared.workspace.WorkspaceLock.write(async () => {
         version = (await services.shared.model.ModelService.settled(uri)).version;
      });

      expect(version).toBe(openedAt);
   });

   it('keeps the edit through a gated write based on a read taken while the change was debounced', async () => {
      const { head, services, uri } = await changeDuringDebounce();

      const reading = head.proxy.getModelDocument({ uri });
      await tick();
      services.shared.lsp.DocumentUpdateHandler.flushPending();
      const read = await reading;
      await head.proxy
         .updateModelDocument({ uri, clientId: 'form', model: read.model!.root, baseVersion: read.model!.version })
         .catch((rejection: unknown) => {
            if (!isConflictError(rejection)) {
               throw rejection;
            }
         });

      expect(services.shared.workspace.TextDocuments.get(uri)?.getText()).toMatch(/b ?: string/);
   });

   it('rejects a gated write of the model opened before the change', async () => {
      const { head, services, uri, opened } = await changeDuringDebounce();

      const error = await head.proxy
         .updateModelDocument({ uri, clientId: 'form', model: opened.model!.root, baseVersion: opened.model!.version })
         .then(
            () => undefined,
            (rejection: unknown) => rejection
         );

      expect({ conflict: isConflictError(error), text: services.shared.workspace.TextDocuments.get(uri)?.getText() }).toEqual({
         conflict: true,
         text: EDITED
      });
   });

   it("flips dirty at the edit's version, ahead of the model, and the update at that version follows", async () => {
      const { head, services, uri, opened } = await changeDuringDebounce();
      await waitFor(() => head.dirtyChanges.length > 0, { timeoutMs: 2000 });
      const flip = head.dirtyChanges.at(-1)!;

      expect(flip.text?.dirty).toBe(true);
      expect(flip.text?.version).toBe(services.shared.workspace.TextDocuments.version(uri));
      expect(flip.text?.version).toBeGreaterThan(opened.model!.version);
      services.shared.lsp.DocumentUpdateHandler.flushPending();
      await waitFor(() => head.events.some(event => event.document.model!.version === flip.text?.version), {
         timeoutMs: 2000,
         message: "no update at the flip's version"
      });
   });

   it('builds the document after a last close whose revert fails, so a wait for it settles', async () => {
      const { head, services, uri } = await changeDuringDebounce();
      const store = services.shared.workspace.TextDocuments;
      const provider = services.shared.workspace.FileSystemProvider;
      const exists = provider.exists.bind(provider);
      let failed = false;
      provider.exists = async target => {
         if (!failed && target.toString() === uri) {
            failed = true;
            throw new Error('EIO: i/o error');
         }
         return exists(target);
      };

      try {
         await head.proxy.closeModelDocument({ uri, clientId: 'form' });
         await lsp!.closeDocument(uri);
         await waitFor(() => failed, { timeoutMs: 2000 });
         const settled = await Promise.race([services.shared.model.ModelService.settled(uri), tick(2000).then(() => 'timed out' as const)]);

         expect(settled === 'timed out' ? settled : { version: settled.version, parsedFrom: settled.root.$cstNode?.root.fullText }).toEqual(
            { version: store.version(uri), parsedFrom: CLEAN }
         );
      } finally {
         provider.exists = exists;
      }
   });
});

describe('the version of a closed document', () => {
   async function boot(): Promise<{ services: Awaited<ReturnType<typeof makeScratchWorkspaceHarness>>['harness']; uri: string }> {
      const scratch = await makeScratchWorkspaceHarness(seeded => seeded.write(FILE, CLEAN));
      workspace = scratch.workspace;
      return { services: scratch.harness, uri: scratch.workspace.uri(FILE) };
   }

   it('is the store’s for a document the workspace start loaded', async () => {
      const { services, uri } = await boot();

      const version = services.shared.model.ModelService.snapshot(uri)?.version;

      expect(version).not.toBe(UNRECORDED_VERSION);
      expect(version).toBe(services.shared.workspace.TextDocuments.version(uri));
   });

   it('is the continued sequence version once a revert rebuilds it from disk', async () => {
      const { services, uri } = await boot();
      const models = services.shared.model.ModelService;
      const session = models.createSession('form');
      await session.open(uri);
      const written = await session.update({ uri, model: EDITED, baseVersion: 'any' });

      await session.close(uri);
      const built = (): string | undefined => models.getDocument(uri)?.textDocument.getText();
      await waitFor(() => built() === CLEAN, { timeoutMs: 2000 });
      const reverted = await models.validated(uri);

      expect(reverted.version).toBeGreaterThan(written.version);
      expect(reverted.version).toBe(services.shared.workspace.TextDocuments.version(uri));
   });

   /** A first open's write based on `before`, against the external `EDITED` text. */
   async function expectStaleWriteRefused(services: OrderFlowHarness, uri: string, before: ModelVersion): Promise<void> {
      const models = services.shared.model.ModelService;
      const store = services.shared.workspace.TextDocuments;
      const session = models.createSession('form');
      await session.open(uri);

      const error = await session.update({ uri, model: CLEAN, baseVersion: before }).then(
         () => undefined,
         (rejection: unknown) => rejection
      );

      expect({ conflict: isConflictError(error), text: store.get(uri)?.getText() }).toEqual({ conflict: true, text: EDITED });
   }

   it('conflicts with a write based on a snapshot taken before an external change of a never-opened file', async () => {
      const { services, uri } = await boot();
      const models = services.shared.model.ModelService;
      const before = models.snapshot(uri)!.version;

      workspace!.write(FILE, EDITED);
      await services.shared.workspace.DocumentBuilder.scheduleUpdate([URI.parse(uri)], []);

      await expectStaleWriteRefused(services, uri, before);
   });

   it('conflicts with a write based on a snapshot taken before the file was deleted and recreated', async () => {
      const { services, uri } = await boot();
      const models = services.shared.model.ModelService;
      const builder = services.shared.workspace.DocumentBuilder;
      const before = models.snapshot(uri)!.version;

      rmSync(workspace!.resolve(FILE));
      await builder.scheduleUpdate([], [URI.parse(uri)]);
      workspace!.write(FILE, EDITED);
      await builder.scheduleUpdate([URI.parse(uri)], []);

      await expectStaleWriteRefused(services, uri, before);
   });

   it('conflicts with a write based on the built root once a first open adopts other text', async () => {
      const { services, uri } = await boot();
      const models = services.shared.model.ModelService;
      const store = services.shared.workspace.TextDocuments;
      const built = models.snapshot(uri)!;
      store.stagePendingContent(uri, EDITED);
      const session = models.createSession('form');
      await session.open(uri);

      const error = await session.update({ uri, model: CLEAN, baseVersion: built.version }).then(
         () => undefined,
         (rejection: unknown) => rejection
      );

      expect({ conflict: isConflictError(error), text: store.get(uri)?.getText() }).toEqual({ conflict: true, text: EDITED });
      expect(store.version(uri)).toBeGreaterThan(built.version);
   });

   it('keeps the built root current when an editor first opens the same text under its own version', async () => {
      const { services, uri } = await boot();
      const models = services.shared.model.ModelService;
      const store = services.shared.workspace.TextDocuments;
      const built = models.snapshot(uri)!;

      store.notifyDidOpenTextDocument({ textDocument: { uri, languageId: 'order-flow-domain', version: 5, text: CLEAN } });
      expect(store.version(uri)).toBe(built.version);
      // The editor's next change is judged against its own version, not the shared one.
      store.notifyDidChangeTextDocument({ textDocument: { uri, version: 6 }, contentChanges: [{ text: EDITED }] });

      expect({ text: store.get(uri)?.getText(), version: store.version(uri) }).toEqual({ text: EDITED, version: built.version + 1 });
   });

   it('syncs the built root when a headless reopen adopts its own text at a later version', async () => {
      const { services, uri } = await boot();
      const models = services.shared.model.ModelService;
      const store = services.shared.workspace.TextDocuments;
      const session = models.createSession('form');
      await session.open(uri);
      await models.validated(uri);
      // Unbuilt edits that end on the built root's text, under a later version.
      await services.shared.workspace.AstDocumentManager.update(uri, EDITED, session.clientId);
      await services.shared.workspace.AstDocumentManager.update(uri, CLEAN, session.clientId);
      expect(models.snapshot(uri)!.root.$cstNode?.root.fullText).toBe(CLEAN);
      expect(models.snapshot(uri)!.version).toBeLessThan(store.version(uri));

      // Hold the last-close revert until the reopen, so it skips the reopened document.
      let entered!: () => void;
      let release!: () => void;
      const entering = new Promise<void>(resolve => (entered = resolve));
      const held = new Promise<void>(resolve => (release = resolve));
      const holding = services.shared.workspace.WorkspaceLock.write(async () => {
         entered();
         await held;
      });
      await entering;
      await session.close(uri);
      await session.open(uri);
      release();
      await holding;
      const validated = await Promise.race([models.validated(uri), tick(2000).then(() => 'timed out' as const)]);

      expect(validated === 'timed out' ? validated : validated.version).toBe(store.version(uri));
   });
});

// A `.process` file: order-flow parses every changed `.domain` file a second time, as a project descriptor.
const PROCESS = 'orders/read-version-stamp.process';
const PARSED = 'process Solo for Order {\n   task A reads Order.id\n}\n';
const OTHER = 'process Solo for Order {\n   task A reads Order.id\n   task B reads Order.id\n}\n';

/** Hold the next read of `uri` until `release`; `entered` settles once it is held. */
function holdNextRead(services: OrderFlowHarness, uri: string): { entered: Promise<void>; release: () => void } {
   const provider = services.shared.workspace.FileSystemProvider;
   const readFile = provider.readFile.bind(provider);
   let entered!: () => void;
   let release!: () => void;
   const entering = new Promise<void>(resolve => (entered = resolve));
   const held = new Promise<void>(resolve => (release = resolve));
   provider.readFile = async target => {
      if (target.toString() === uri) {
         provider.readFile = readFile;
         entered();
         await held;
      }
      return readFile(target);
   };
   onTestFinished(() => {
      release();
      provider.readFile = readFile;
   });
   return { entered: entering, release };
}

describe('a build that read the file while a headless open landed', () => {
   async function boot(): Promise<{ services: OrderFlowHarness; uri: string }> {
      const scratch = await makeScratchWorkspaceHarness(seeded => seeded.write(PROCESS, PARSED));
      workspace = scratch.workspace;
      return { services: scratch.harness, uri: scratch.workspace.uri(PROCESS) };
   }

   /** The synced wait settles, and on a root parsed from the store's text at the store's version. */
   async function expectSynced(services: OrderFlowHarness, uri: string): Promise<void> {
      const models = services.shared.model.ModelService;
      const store = services.shared.workspace.TextDocuments;
      const linked = await Promise.race([
         models.waitForDocumentState(uri, DocumentState.Linked),
         tick(2000).then(() => 'timed out' as const)
      ]);
      const validated = await Promise.race([models.validated(uri), tick(2000).then(() => 'timed out' as const)]);
      const snapshot = models.snapshot(uri);

      expect({
         linked: linked === 'timed out' ? linked : linked.root.$cstNode?.root.fullText,
         validated: validated === 'timed out' ? validated : validated.version,
         version: snapshot?.version,
         parsedFrom: snapshot?.root.$cstNode?.root.fullText
      }).toEqual({
         linked: store.get(uri)?.getText(),
         validated: store.version(uri),
         version: store.version(uri),
         parsedFrom: store.get(uri)?.getText()
      });
   }

   it('builds the open text when the last-close revert read the file meanwhile', async () => {
      const { services, uri } = await boot();
      const session = services.shared.model.ModelService.createSession('form');
      await session.open(uri);
      await session.update({ uri, model: OTHER, baseVersion: 'any' });
      await services.shared.model.ModelService.validated(uri);
      const read = holdNextRead(services, uri);

      await session.close(uri);
      await read.entered;
      // The old root's own text, so the open adopts the root's version and schedules no build.
      await services.shared.workspace.AstDocumentManager.open({ uri, clientId: 'reader', text: OTHER });
      read.release();

      await expectSynced(services, uri);
   });

   it('builds the open text when a build of the closed document read changed disk text meanwhile', async () => {
      const { services, uri } = await boot();
      const read = holdNextRead(services, uri);
      const parsedAt: number[] = [];
      const listener = services.shared.workspace.DocumentBuilder.onDocumentPhase(DocumentState.Parsed, document => {
         if (document.uri.toString() === uri) {
            parsedAt.push(services.shared.workspace.ModelLedger.versionOf(document.parseResult.value));
         }
      });
      onTestFinished(() => listener.dispose());

      workspace!.write(PROCESS, OTHER);
      const building = services.shared.workspace.DocumentBuilder.scheduleUpdate([URI.parse(uri)], []);
      await read.entered;
      await services.shared.workspace.AstDocumentManager.open({ uri, clientId: 'reader', text: PARSED });
      read.release();
      await building;

      await expectSynced(services, uri);
      expect(parsedAt[0]).toBe(STALE_VERSION);
      const session = services.shared.model.ModelService.createSession('form');
      await session.open(uri);
      const error = await session.update({ uri, model: OTHER, baseVersion: STALE_VERSION }).then(
         () => undefined,
         (rejection: unknown) => rejection
      );
      expect(isConflictError(error)).toBe(true);
   });

   it('sends a watcher the open text at the store’s version, with nothing waiting on the model', async () => {
      const { services, uri } = await boot();
      head = makeDataServerHarness<DataServer<DomainModel>, DomainModel>({
         server: channel => new DataServer<DomainModel>(channel, services.shared)
      });
      await head.proxy.createSession({ clientId: 'tree' });
      await head.proxy.watchModelDocument({ uri, clientId: 'tree' });
      const read = holdNextRead(services, uri);

      workspace!.write(PROCESS, OTHER);
      const building = services.shared.workspace.DocumentBuilder.scheduleUpdate([URI.parse(uri)], []);
      await read.entered;
      await services.shared.workspace.AstDocumentManager.open({ uri, clientId: 'reader', text: PARSED });
      read.release();
      await building;

      const store = services.shared.workspace.TextDocuments;
      const lastSent = (): number | undefined => head!.events.at(-1)?.document.model?.version;
      // Times out on a root left at the read text, which the assertion then reports.
      await waitFor(() => lastSent() === store.version(uri)).catch(() => undefined);
      expect(lastSent()).toBe(store.version(uri));
   });

   it('builds the open text when a build of a document closed before read changed disk text meanwhile', async () => {
      const { services, uri } = await boot();
      const models = services.shared.model.ModelService;
      const session = models.createSession('form');
      await session.open(uri);
      await models.validated(uri);
      let reverted!: () => void;
      const reverting = new Promise<void>(resolve => (reverted = resolve));
      const listener = services.shared.workspace.DocumentBuilder.onDocumentPhase(DocumentState.Validated, document => {
         if (document.uri.toString() === uri) {
            reverted();
         }
      });
      await session.close(uri);
      await Promise.race([reverting, tick(2000)]);
      listener.dispose();
      await services.shared.workspace.WorkspaceLock.read(() => undefined);
      const read = holdNextRead(services, uri);

      workspace!.write(PROCESS, OTHER);
      const building = services.shared.workspace.DocumentBuilder.scheduleUpdate([URI.parse(uri)], []);
      await read.entered;
      await services.shared.workspace.AstDocumentManager.open({ uri, clientId: 'reader', text: PARSED });
      read.release();
      await building;

      await expectSynced(services, uri);
   });

   it('builds the open text when the workspace start read the file for its first load meanwhile', async () => {
      workspace = makeScratchWorkspace({ seed: WORKSPACE_ROOT, prefix: 'order-flow-read-version-' });
      workspace.write(PROCESS, PARSED);
      const uri = workspace.uri(PROCESS);
      const services = makeServices();
      const read = holdNextRead(services, uri);

      const starting = initializeWorkspaceProgrammatically(services.shared, workspace.root);
      await read.entered;
      expect(services.shared.workspace.LangiumDocuments.getDocument(URI.parse(uri))).toBeUndefined();
      await services.shared.workspace.AstDocumentManager.open({ uri, clientId: 'reader', text: OTHER });
      read.release();
      await starting;

      await expectSynced(services, uri);
   });

   it('stamps the first load with the version of an open of the same text that landed meanwhile', async () => {
      workspace = makeScratchWorkspace({ seed: WORKSPACE_ROOT, prefix: 'order-flow-read-version-' });
      workspace.write(PROCESS, PARSED);
      const uri = workspace.uri(PROCESS);
      const services = makeServices();
      const store = services.shared.workspace.TextDocuments;
      const read = holdNextRead(services, uri);

      const starting = initializeWorkspaceProgrammatically(services.shared, workspace.root);
      await read.entered;
      store.notifyDidOpenTextDocument({ textDocument: { uri, languageId: 'order-flow-process', version: 5, text: PARSED } }, 'reader');
      read.release();
      await starting;

      await expectSynced(services, uri);
      expect(store.version(uri)).toBe(5);
   });
});

describe('a load outside a build', () => {
   /** A closed {@link PROCESS} whose sequence stands at 1, removed from the registry with its file kept. */
   async function unregisteredAtVersionOne(): Promise<{ services: OrderFlowHarness; uri: string }> {
      const scratch = await makeScratchWorkspaceHarness(seeded => seeded.write(PROCESS, PARSED));
      workspace = scratch.workspace;
      const services = scratch.harness;
      const uri = workspace.uri(PROCESS);
      const builder = services.shared.workspace.DocumentBuilder;
      workspace.write(PROCESS, OTHER);
      await builder.scheduleUpdate([URI.parse(uri)], []);
      await builder.scheduleUpdate([], [URI.parse(uri)]);
      expect({
         version: services.shared.workspace.TextDocuments.version(uri),
         registered: services.shared.workspace.LangiumDocuments.hasDocument(URI.parse(uri))
      }).toEqual({ version: 1, registered: false });
      return { services, uri };
   }

   /** The URIs every build from here on carries through `IndexedContent`. */
   function recordBuilds(services: OrderFlowHarness): string[] {
      const built: string[] = [];
      const listener = services.shared.workspace.DocumentBuilder.onDocumentPhase(DocumentState.IndexedContent, document => {
         built.push(document.uri.toString());
      });
      onTestFinished(() => listener.dispose());
      return built;
   }

   it('stamps a reload of a closed file with its sequence version, without a build', async () => {
      const { services, uri } = await unregisteredAtVersionOne();
      const built = recordBuilds(services);

      const loaded = await services.shared.workspace.LangiumDocuments.getOrCreateDocument(URI.parse(uri));
      const stamped = services.shared.workspace.ModelLedger.versionOf(loaded.parseResult.value);
      const parsed = await Promise.race([services.shared.model.ModelService.parsed(uri), tick(2000).then(() => 'timed out' as const)]);

      expect({ stamped, parsed: parsed === 'timed out' ? parsed : parsed.version, built }).toEqual({ stamped: 1, parsed: 1, built: [] });
   });

   it('stamps a load of a file held open with the same text with the open version, without a build', async () => {
      const { services, uri } = await unregisteredAtVersionOne();
      const store = services.shared.workspace.TextDocuments;
      workspace!.write(PROCESS, PARSED);
      store.notifyDidOpenTextDocument({ textDocument: { uri, languageId: 'order-flow-process', version: 7, text: PARSED } }, 'reader');
      const built = recordBuilds(services);

      const loaded = await services.shared.workspace.LangiumDocuments.getOrCreateDocument(URI.parse(uri));

      expect({
         stamped: services.shared.workspace.ModelLedger.versionOf(loaded.parseResult.value),
         open: store.version(uri),
         built
      }).toEqual({
         stamped: 2,
         open: 2,
         built: []
      });
   });

   it('builds a load of a file held open with other text', async () => {
      const { services, uri } = await unregisteredAtVersionOne();
      const store = services.shared.workspace.TextDocuments;
      // The open lands first: with no built root, it requests no build itself.
      await services.shared.workspace.AstDocumentManager.open({ uri, clientId: 'reader', text: PARSED });

      const loaded = await services.shared.workspace.LangiumDocuments.getOrCreateDocument(URI.parse(uri));
      const stamped = services.shared.workspace.ModelLedger.versionOf(loaded.parseResult.value);
      const parsed = await Promise.race([services.shared.model.ModelService.parsed(uri), tick(2000).then(() => 'timed out' as const)]);

      expect({
         stamped,
         parsed: parsed === 'timed out' ? parsed : { version: parsed.version, from: parsed.root.$cstNode?.root.fullText }
      }).toEqual({ stamped: STALE_VERSION, parsed: { version: store.version(uri), from: PARSED } });
   });

   it('settles a read once a build of the reloaded, already parsed document runs', async () => {
      const { services, uri } = await unregisteredAtVersionOne();
      const loaded = await services.shared.workspace.LangiumDocuments.getOrCreateDocument(URI.parse(uri));

      await services.shared.workspace.WorkspaceLock.write(token =>
         services.shared.workspace.DocumentBuilder.build([loaded], { validation: true }, token)
      );
      const validated = await Promise.race([
         services.shared.model.ModelService.validated(uri),
         tick(2000).then(() => 'timed out' as const)
      ]);

      expect(validated === 'timed out' ? validated : validated.version).toBe(1);
   });
});

const BYSTANDER = 'orders/read-version-bystander.process';
const THIRD = 'process Solo for Order {\n   task A reads Order.id\n   task C reads Order.id\n}\n';

describe('a build of a closed document cancelled right after its parse', () => {
   it.each([
      ['unchanged', OTHER],
      ['changed', THIRD]
   ])('records the store version on the root it parsed from %s disk text', async (_variant, onDisk) => {
      const scratch = await makeScratchWorkspaceHarness(seeded => {
         seeded.write(PROCESS, PARSED);
         seeded.write(BYSTANDER, PARSED.replace('Solo', 'Bystander'));
      });
      workspace = scratch.workspace;
      const services = scratch.harness;
      const uri = workspace.uri(PROCESS);
      const bystander = URI.parse(workspace.uri(BYSTANDER));
      const store = services.shared.workspace.TextDocuments;
      const builder = services.shared.workspace.DocumentBuilder;
      const lock = services.shared.workspace.WorkspaceLock;
      workspace.write(PROCESS, OTHER);
      await builder.scheduleUpdate([URI.parse(uri)], []);
      const notified: string[] = [];
      const listener = builder.onDocumentPhase(DocumentState.Parsed, document => {
         notified.push(document.uri.toString());
      });
      onTestFinished(() => listener.dispose());
      // A write right after the parse cancels the build before its Parsed listeners run.
      const factory = services.shared.workspace.LangiumDocumentFactory;
      const update = factory.update.bind(factory);
      let cancelling: Promise<void> | undefined;
      factory.update = async <T extends AstNode>(document: Mutable<LangiumDocument<T>>, token: CancellationToken) => {
         const updated = await update(document, token);
         if (document.uri.toString() === uri && cancelling === undefined) {
            factory.update = update;
            cancelling = lock.write(writeToken => builder.update([bystander], [], writeToken));
         }
         return updated;
      };
      onTestFinished(() => {
         factory.update = update;
      });

      workspace.write(PROCESS, onDisk);
      await lock.write(token => builder.update([URI.parse(uri)], [], token));
      await cancelling;
      const validated = await Promise.race([
         services.shared.model.ModelService.validated(uri),
         tick(2000).then(() => 'timed out' as const)
      ]);

      expect(notified).not.toContain(uri);
      expect({
         validated: validated === 'timed out' ? validated : validated.version,
         textHashIsParsed: store.textState(uri)?.hash === textHash(onDisk)
      }).toEqual({ validated: store.version(uri), textHashIsParsed: true });
   });

   it('settles waits for an open edit whose build is cancelled right after its parse', async () => {
      const scratch = await makeScratchWorkspaceHarness(seeded => {
         seeded.write(PROCESS, PARSED);
         seeded.write(BYSTANDER, PARSED.replace('Solo', 'Bystander'));
      });
      workspace = scratch.workspace;
      const services = scratch.harness;
      const uri = workspace.uri(PROCESS);
      const bystander = URI.parse(workspace.uri(BYSTANDER));
      const models = services.shared.model.ModelService;
      const builder = services.shared.workspace.DocumentBuilder;
      const lock = services.shared.workspace.WorkspaceLock;
      const reader = makeDataServerHarness<DataServer<DomainModel>, DomainModel>({
         server: channel => new DataServer<DomainModel>(channel, services.shared)
      });
      onTestFinished(() => reader.dispose());
      const session = models.createSession('form');
      await session.open(uri);
      await models.validated(uri);
      const edited = await services.shared.workspace.AstDocumentManager.update(uri, OTHER, session.clientId);
      const settling = models.settled(uri);
      const reading = reader.proxy.getModelDocument({ uri });
      // Lets the read cross the wire and start its wait before the build.
      await tick();
      const factory = services.shared.workspace.LangiumDocumentFactory;
      const update = factory.update.bind(factory);
      let cancelling: Promise<void> | undefined;
      factory.update = async <T extends AstNode>(document: Mutable<LangiumDocument<T>>, token: CancellationToken) => {
         const updated = await update(document, token);
         if (document.uri.toString() === uri && cancelling === undefined) {
            factory.update = update;
            cancelling = lock.write(writeToken => builder.update([bystander], [], writeToken));
         }
         return updated;
      };
      onTestFinished(() => {
         factory.update = update;
      });

      await lock.write(token => builder.update([URI.parse(uri)], [], token));
      await cancelling;
      const timedOut = tick(2000).then(() => 'timed out' as const);
      const settled = await Promise.race([settling, timedOut]);
      const read = await Promise.race([reading, timedOut]);

      expect({
         cancelled: cancelling !== undefined,
         settled: settled === 'timed out' ? settled : settled.version,
         read: read === 'timed out' ? read : read.model?.version
      }).toEqual({ cancelled: true, settled: edited, read: edited });
   });
});

class EnvelopeReader extends DataServer<DomainModel> {
   read(uri: string): TransferDocument<DomainModel> {
      return this.envelope(URI.parse(uri));
   }
}

describe('a new file the builder registered but has not parsed yet', () => {
   it.each([
      ['text', PARSED],
      ['empty', '']
   ])('reads as absent until its parse, with %s', async (_variant, text) => {
      const scratch = await makeScratchWorkspaceHarness();
      workspace = scratch.workspace;
      const services = scratch.harness;
      const uri = workspace.uri('orders/read-version-fresh.process');
      const reader = makeDataServerHarness<EnvelopeReader, DomainModel>({
         server: channel => new EnvelopeReader(channel, services.shared)
      });
      onTestFinished(() => reader.dispose());
      const read = holdNextRead(services, uri);

      workspace.write('orders/read-version-fresh.process', text);
      const building = services.shared.workspace.DocumentBuilder.scheduleUpdate([URI.parse(uri)], []);
      await read.entered;
      const duringParse = {
         registered: services.shared.workspace.LangiumDocuments.hasDocument(URI.parse(uri)),
         snapshot: services.shared.model.ModelService.snapshot(uri),
         envelope: reader.server.read(uri).model
      };
      read.release();
      await building;

      expect(duringParse).toEqual({ registered: true, snapshot: undefined, envelope: undefined });
      expect(services.shared.model.ModelService.snapshot(uri)?.version).toBe(services.shared.workspace.TextDocuments.version(uri));
   });

   it('conflicts with a write based on its projection', async () => {
      const scratch = await makeScratchWorkspaceHarness();
      workspace = scratch.workspace;
      const services = scratch.harness;
      const uri = workspace.uri('orders/read-version-fresh.process');
      const models = services.shared.model.ModelService;
      let projected: ModelVersion | undefined;
      // `update` registers the placeholder before it awaits its onUpdate listeners.
      const listener = services.shared.workspace.DocumentBuilder.onUpdate(() => {
         const document = models.getDocument(uri);
         if (projected === undefined && document !== undefined) {
            projected = services.shared.workspace.AstDocumentManager.toAstDocument(document).version;
         }
      });
      onTestFinished(() => listener.dispose());
      const session = models.createSession('form');

      await session.create(uri, PARSED);
      await models.validated(uri);
      const error = await session.update({ uri, model: OTHER, baseVersion: projected! }).then(
         () => undefined,
         (rejection: unknown) => rejection
      );

      expect({ projected, conflict: isConflictError(error), text: services.shared.workspace.TextDocuments.get(uri)?.getText() }).toEqual({
         projected: UNRECORDED_VERSION,
         conflict: true,
         text: PARSED
      });
   });
});

describe('a built document between its rebuild reset and its parse', () => {
   it('is still read, with its old root and that root’s version', async () => {
      const scratch = await makeScratchWorkspaceHarness(seeded => seeded.write(PROCESS, PARSED));
      workspace = scratch.workspace;
      const services = scratch.harness;
      const uri = workspace.uri(PROCESS);
      const models = services.shared.model.ModelService;
      const reader = makeDataServerHarness<EnvelopeReader, DomainModel>({
         server: channel => new EnvelopeReader(channel, services.shared)
      });
      onTestFinished(() => reader.dispose());
      const session = models.createSession('form');
      await session.open(uri);
      const before = await models.validated(uri);
      // `update` awaits its onUpdate listeners after the reset, before the parse.
      let release!: () => void;
      const held = new Promise<void>(resolve => (release = resolve));
      let entered!: () => void;
      const holding = new Promise<void>(resolve => (entered = resolve));
      let armed = true;
      const listener = services.shared.workspace.DocumentBuilder.onUpdate(async () => {
         if (armed) {
            armed = false;
            entered();
            await held;
         }
      });
      onTestFinished(() => listener.dispose());

      const writing = session.update({ uri, model: OTHER, baseVersion: before.version });
      await holding;
      const document = models.getDocument(uri)!;
      const duringRebuild = {
         state: document.state,
         rootIsOld: document.parseResult.value === before.root,
         snapshot: models.snapshot(uri)?.version,
         envelope: reader.server.read(uri).model?.version
      };
      release();
      await writing;

      expect(duringRebuild).toEqual({ state: DocumentState.Changed, rootIsOld: true, snapshot: before.version, envelope: before.version });
   });
});

describe('a text change no build follows', () => {
   it('settles a syncing read by building the document', async () => {
      const scratch = await makeScratchWorkspaceHarness(seeded => seeded.write(PROCESS, PARSED));
      workspace = scratch.workspace;
      const services = scratch.harness;
      const uri = workspace.uri(PROCESS);
      const models = services.shared.model.ModelService;
      const session = models.createSession('form');
      await session.open(uri);
      await models.validated(uri);
      await services.shared.workspace.AstDocumentManager.update(uri, OTHER, session.clientId);

      const settled = await Promise.race([models.settled(uri), tick(2000).then(() => 'timed out' as const)]);

      expect(settled === 'timed out' ? settled : { version: settled.version, parsedFrom: settled.root.$cstNode?.root.fullText }).toEqual({
         version: services.shared.workspace.TextDocuments.version(uri),
         parsedFrom: OTHER
      });
   });

   it('rejects a syncing read once the build that would sync the document keeps failing', async () => {
      const scratch = await makeScratchWorkspaceHarness(seeded => seeded.write(PROCESS, PARSED));
      workspace = scratch.workspace;
      const services = scratch.harness;
      const uri = workspace.uri(PROCESS);
      const models = services.shared.model.ModelService;
      const session = models.createSession('form');
      await session.open(uri);
      await models.validated(uri);
      const builder = services.shared.workspace.DocumentBuilder;
      const scheduleUpdate = builder.scheduleUpdate.bind(builder);
      builder.scheduleUpdate = (changed, deleted, reason) =>
         changed.some(target => target.toString() === uri)
            ? Promise.reject(new Error('build failed'))
            : scheduleUpdate(changed, deleted, reason);
      await services.shared.workspace.AstDocumentManager.update(uri, OTHER, session.clientId);

      const settled = await Promise.race([
         models.settled(uri).then(
            () => 'resolved' as const,
            () => 'rejected' as const
         ),
         tick(2000).then(() => 'still waiting' as const)
      ]);

      expect(settled).toBe('rejected');
   });
});

describe('a text change whose builds fail after the parse', () => {
   /** Apply {@link OTHER} with no build, failing every later build of the document after its parse. */
   async function changeThatFailsAfterParse(): Promise<{ services: OrderFlowHarness; uri: string; builds: () => number }> {
      const scratch = await makeScratchWorkspaceHarness(seeded => seeded.write(PROCESS, PARSED));
      workspace = scratch.workspace;
      const services = scratch.harness;
      const uri = workspace.uri(PROCESS);
      const models = services.shared.model.ModelService;
      const session = models.createSession('form');
      await session.open(uri);
      await models.validated(uri);
      await services.shared.workspace.AstDocumentManager.update(uri, OTHER, session.clientId);
      const builder = services.shared.workspace.DocumentBuilder;
      let builds = 0;
      const counting = builder.onUpdate(changed => {
         builds += changed.filter(changedUri => changedUri.toString() === uri).length;
      });
      const failing = builder.onDocumentPhase(DocumentState.Parsed, document => {
         if (document.uri.toString() === uri) {
            throw new Error('listener failed after the parse');
         }
      });
      onTestFinished(() => {
         counting.dispose();
         failing.dispose();
      });
      return { services, uri, builds: () => builds };
   }

   /** Settle `wait` to its outcome, cancelling it at the end of the test. */
   function outcome(wait: (token: CancellationToken) => Promise<unknown>): Promise<unknown> {
      const cancel = new CancellationTokenSource();
      onTestFinished(() => cancel.cancel());
      return wait(cancel.token).then(
         () => 'resolved' as const,
         (rejection: unknown) => rejection
      );
   }

   /** The builds of the document over a further half second, once the workspace lock has drained. */
   async function buildsWhileIdle(services: OrderFlowHarness, builds: () => number): Promise<number> {
      await services.shared.workspace.WorkspaceLock.read(() => undefined);
      const before = builds();
      await tick(500);
      await services.shared.workspace.WorkspaceLock.read(() => undefined);
      return builds() - before;
   }

   it('rejects a syncing read once its recovery build is given up, naming the document and the state, and stops building it', async () => {
      const { services, uri, builds } = await changeThatFailsAfterParse();

      const settled = await Promise.race([
         outcome(token => services.shared.model.ModelService.settled(uri, token)),
         tick(2000).then(() => 'still pending' as const)
      ]);
      await tick(500);

      const message = settled instanceof Error ? settled.message : settled;
      expect({
         namesUri: message,
         namesState: message,
         namesCause: message,
         buildsAfterward: await buildsWhileIdle(services, builds)
      }).toEqual({
         namesUri: expect.stringContaining(uri),
         namesState: expect.stringContaining("'IndexedReferences'"),
         namesCause: expect.stringContaining('recovery build failed'),
         buildsAfterward: 0
      });
   });

   it('rejects a syncing read once the builder stops re-queuing the document, though each recovery build is answered as done', async () => {
      const { services, uri } = await changeThatFailsAfterParse();
      const sync = services.shared.workspace.VersionSyncService;
      const requestRecoveryBuild = sync.requestRecoveryBuild.bind(sync);
      sync.requestRecoveryBuild = (target, request) => requestRecoveryBuild(target, request).then(() => true);

      const settled = await Promise.race([
         outcome(token => services.shared.model.ModelService.settled(uri, token)),
         tick(2000).then(() => 'still pending' as const)
      ]);
      await services.shared.workspace.WorkspaceLock.read(() => undefined);

      expect(settled instanceof Error ? settled.message : settled).toContain('builds did not advance it');
   });

   it('rejects a later syncing read of the document a failed build left behind, with no build running', async () => {
      const { services, uri } = await changeThatFailsAfterParse();
      const models = services.shared.model.ModelService;
      await outcome(token => models.settled(uri, token));
      await services.shared.workspace.WorkspaceLock.read(() => undefined);

      const validated = await Promise.race([
         outcome(token => models.validated(uri, token)),
         tick(2000).then(() => 'still pending' as const)
      ]);
      await services.shared.workspace.WorkspaceLock.read(() => undefined);

      expect(validated).toBeInstanceOf(Error);
   });

   it('leaves a passive wait pending once the builder stops re-queuing the document', async () => {
      const { services, uri, builds } = await changeThatFailsAfterParse();
      const models = services.shared.model.ModelService;

      const passive = outcome(token => models.waitForDocumentSettled(uri, token));
      // Builds the change, which a passive wait does not.
      void outcome(token => models.settled(uri, token));
      await tick(1500);
      const settled = await Promise.race([passive, tick(0).then(() => 'still pending' as const)]);

      expect({ settled, buildsAfterward: await buildsWhileIdle(services, builds) }).toEqual({
         settled: 'still pending',
         buildsAfterward: 0
      });
   });
});

describe('a passive wait on a root behind its text', () => {
   /** Apply {@link OTHER} with no build, counting the builds of the document from then on. */
   async function changeWithoutBuild(): Promise<{ services: OrderFlowHarness; uri: string; builds: () => number }> {
      const scratch = await makeScratchWorkspaceHarness(seeded => seeded.write(PROCESS, PARSED));
      workspace = scratch.workspace;
      const services = scratch.harness;
      const uri = workspace.uri(PROCESS);
      const models = services.shared.model.ModelService;
      const session = models.createSession('form');
      await session.open(uri);
      await models.validated(uri);
      let builds = 0;
      const listener = services.shared.workspace.DocumentBuilder.onUpdate(changed => {
         builds += changed.filter(changedUri => changedUri.toString() === uri).length;
      });
      onTestFinished(() => listener.dispose());
      await services.shared.workspace.AstDocumentManager.update(uri, OTHER, session.clientId);
      return { services, uri, builds: () => builds };
   }

   /** Settle `wait` without rejecting, cancelling it at the end of the test. */
   function outcome(wait: (token: CancellationToken) => Promise<unknown>): Promise<'resolved' | 'rejected'> {
      const cancel = new CancellationTokenSource();
      onTestFinished(() => cancel.cancel());
      return wait(cancel.token).then(
         () => 'resolved' as const,
         () => 'rejected' as const
      );
   }

   it('requests no build, and waits', async () => {
      const { services, uri, builds } = await changeWithoutBuild();
      const models = services.shared.model.ModelService;

      const waits = Promise.all([
         outcome(token => models.waitForDocumentState(uri, DocumentState.Linked, token)),
         outcome(token => models.waitForDocumentSettled(uri, token))
      ]);
      const settled = await Promise.race([waits, tick(500).then(() => 'still waiting' as const)]);
      await services.shared.workspace.WorkspaceLock.read(() => undefined);

      expect({ settled, builds: builds() }).toEqual({ settled: 'still waiting', builds: 0 });
   });

   it('is built by ensureDocumentState, which answers with the root parsed from the text', async () => {
      const { services, uri, builds } = await changeWithoutBuild();

      const read = await Promise.race([
         services.shared.model.ModelService.ensureDocumentState(uri, DocumentState.Linked),
         tick(2000).then(() => 'timed out' as const)
      ]);

      expect(
         read === 'timed out' ? read : { version: read.version, parsedFrom: read.root.$cstNode?.root.fullText, builds: builds() }
      ).toEqual({
         version: services.shared.workspace.TextDocuments.version(uri),
         parsedFrom: OTHER,
         builds: 1
      });
   });

   it('resolves once another caller builds the document', async () => {
      const { services, uri, builds } = await changeWithoutBuild();
      const models = services.shared.model.ModelService;

      const waiting = outcome(token => models.waitForDocumentState(uri, DocumentState.Linked, token));
      await models.rebuild(uri);
      const settled = await Promise.race([waiting, tick(2000).then(() => 'still waiting' as const)]);

      expect({ settled, version: models.snapshot(uri)?.version, builds: builds() }).toEqual({
         settled: 'resolved',
         version: services.shared.workspace.TextDocuments.version(uri),
         builds: 1
      });
   });
});
