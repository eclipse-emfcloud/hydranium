/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * An editor's save against the server's own disk writes of the same file, over
 * the real LSP wire: the editor writes the file itself, so the server orders
 * its writes around the editor's `willSaveWaitUntil` and `didSave`.
 *
 * Server writes are held by a provider gate, so a write still under way is
 * observable, and the file the editor "writes" is written by the test between
 * the answer and the `didSave`, as an editor does. A save is announced only
 * once the file read back holds the store's text; the tests observe that on
 * `ModelService.onModelSaved`.
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
import type { URI } from '@hydranium/langium';
import { Deferred } from '@hydranium/protocol';
import { tick, waitFor } from '@hydranium/protocol/testing';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import {
   DidChangeWatchedFilesNotification,
   DidSaveTextDocumentNotification,
   FileChangeType,
   type InitializeResult,
   type TextDocumentSyncOptions,
   TextDocumentSaveReason,
   WillSaveTextDocumentWaitUntilRequest
} from 'vscode-languageserver-protocol';
import { createOrderFlowServices } from '../src/language-server/order-flow-module.js';
import { WORKSPACE_ROOT } from './order-flow-harness.js';

const FILE = 'editor-save.domain';
const CLEAN = `entity Solo {
   a : string
}
`;
const SERVER_TEXT = `entity Solo {
   a : string
   b : string
}
`;
const EDITOR_TEXT = `entity Solo {
   a : string
   c : string
}
`;

let workspace: ScratchWorkspace | undefined;
let lsp: LspHarness | undefined;

afterEach(() => {
   // A test that failed before releasing would leave every later write held.
   GatedFileSystemProvider.gate?.resolve();
   GatedFileSystemProvider.gate = undefined;
   GatedFileSystemProvider.failReads = false;
   lsp?.dispose();
   lsp = undefined;
   workspace?.dispose();
   workspace = undefined;
});

/**
 * Holds every write while a gate is set, so a test can act while a save is on
 * its way to disk, and fails every read while `failReads` is set.
 */
class GatedFileSystemProvider extends DefaultFileSystemProvider {
   static gate: Deferred | undefined;
   static failReads = false;

   override async writeFile(uri: URI, content: string): Promise<void> {
      await GatedFileSystemProvider.gate?.promise;
      return super.writeFile(uri, content);
   }

   override async readFile(uri: URI): Promise<string> {
      if (GatedFileSystemProvider.failReads) {
         throw new Error(`read refused: ${uri.toString()}`);
      }
      return super.readFile(uri);
   }
}

/** Settle `promise` into a flag the test can read without awaiting it. */
function track(promise: Promise<unknown>): { settled: boolean } {
   const state = { settled: false };
   void promise.then(() => {
      state.settled = true;
   });
   return state;
}

async function boot(options: { editorText?: string; withForm?: boolean } = {}): Promise<{
   initialized: InitializeResult;
   harness: LspHarness;
   uri: string;
   services: ReturnType<typeof createOrderFlowServices>;
}> {
   workspace = makeScratchWorkspace({ seed: WORKSPACE_ROOT, prefix: 'order-flow-editor-save-' });
   workspace.write(FILE, CLEAN);
   const wire = makeLspServerConnection();
   const services = createOrderFlowServices({
      connection: wire.serverConnection,
      fileSystemProvider: serverSharedFactory(shared => new GatedFileSystemProvider(shared))
   });
   const harness = makeLspHarness({ connection: wire, services: services.shared });
   lsp = harness;
   const initialized = await harness.initialize({ workspaceFolders: [{ uri: workspace.uri(), name: 'order-flow' }] });
   const uri = workspace.uri(FILE);
   harness.openDocument(uri, options.editorText ?? CLEAN, 'order-flow-domain', 1);
   if (options.withForm === false) {
      return { initialized, harness, uri, services };
   }
   // The form session attaches to the editor's open and puts server text in the shared document.
   const session = services.shared.model.ModelService.createSession('form', 'form');
   await session.open(uri);
   await session.update({ uri, model: SERVER_TEXT, baseVersion: 'any' });
   return { initialized, harness, uri, services };
}

function willSave(harness: LspHarness, uri: string): Promise<unknown> {
   return harness.client.sendRequest(WillSaveTextDocumentWaitUntilRequest.type, {
      textDocument: { uri },
      reason: TextDocumentSaveReason.Manual
   });
}

function didSave(harness: LspHarness, uri: string): Promise<void> {
   return harness.client.sendNotification(DidSaveTextDocumentNotification.type, { textDocument: { uri } });
}

/** Read the file on disk. */
function onDisk(): string {
   return readFileSync(workspace!.resolve(FILE), 'utf-8');
}

/** Record every announced save of `uri` by author. */
function recordSaves(services: ReturnType<typeof createOrderFlowServices>, uri: string): string[] {
   const savedBy: string[] = [];
   services.shared.model.ModelService.onModelSaved(uri, event => {
      savedBy.push(event.sourceClientId);
   });
   return savedBy;
}

/**
 * Wait until the store has handled the editor's `didSave` and its read-back has
 * run: a disk task queued after the report runs after the read-back, and the
 * save listeners, which look the document up asynchronously, get a moment more.
 */
async function readBackDone(services: ReturnType<typeof createOrderFlowServices>, uri: string, reported: () => boolean): Promise<void> {
   await waitFor(reported, { timeoutMs: 500 });
   await tick(0);
   await services.shared.workspace.FileSystemTaskQueue.enqueue(uri, async () => undefined);
   await tick(20);
}

function watchReports(services: ReturnType<typeof createOrderFlowServices>): () => boolean {
   let reported = false;
   services.shared.workspace.TextDocuments.onDidSaveInLanguageClient(() => {
      reported = true;
   });
   return () => reported;
}

describe('an editor save', () => {
   it('is advertised, so an editor sends willSaveWaitUntil and didSave', async () => {
      const { initialized } = await boot();
      const sync = initialized.capabilities.textDocumentSync as TextDocumentSyncOptions;
      expect(sync.willSaveWaitUntil).toBe(true);
      expect(sync.save).toBe(true);
   });

   it('waits for a server save of the file that is still writing', async () => {
      const { harness, uri, services } = await boot();
      GatedFileSystemProvider.gate = new Deferred();
      const serverSave = services.shared.workspace.AstDocumentManager.save(uri, 'form');
      const answer = track(willSave(harness, uri));
      // Long enough for an answer that does not wait for the save to arrive.
      await tick(50);
      expect(answer.settled).toBe(false);
      GatedFileSystemProvider.gate.resolve();
      await serverSave;
      await expect(willSave(harness, uri)).resolves.toEqual([]);
      expect(answer.settled).toBe(true);
   });

   it('holds a server save queued during it until its didSave, and is announced as the language client', async () => {
      const { harness, uri, services } = await boot();
      const savedBy = recordSaves(services, uri);
      await expect(willSave(harness, uri)).resolves.toEqual([]);
      // The editor writes the file itself between the answer and its didSave.
      workspace!.write(FILE, SERVER_TEXT);
      const serverSave = track(services.shared.workspace.AstDocumentManager.save(uri, 'form'));
      // Long enough for a server save that does not wait for the didSave to finish.
      await tick(50);
      expect(serverSave.settled).toBe(false);

      await didSave(harness, uri);
      // Well inside the hold's own cap, so only the didSave can have released it.
      await waitFor(() => serverSave.settled, { timeoutMs: 500 });
      await waitFor(() => savedBy.includes('language-client'), { timeoutMs: 500 });
      expect([...savedBy].sort()).toEqual(['form', 'language-client']);
   });

   it('of text older than the store holds is not announced as a save of the document', async () => {
      const { harness, uri, services } = await boot();
      const savedBy = recordSaves(services, uri);
      const reported = watchReports(services);
      await expect(willSave(harness, uri)).resolves.toEqual([]);
      // The editor writes text older than the store's: the form's edit reached
      // the store while the editor was saving.
      workspace!.write(FILE, EDITOR_TEXT);
      await didSave(harness, uri);
      await readBackDone(services, uri, reported);
      expect(savedBy).toEqual([]);
   });

   it('is announced once a server save queued behind it has written the store text', async () => {
      const { harness, uri, services } = await boot();
      const savedBy = recordSaves(services, uri);
      await expect(willSave(harness, uri)).resolves.toEqual([]);
      workspace!.write(FILE, EDITOR_TEXT);
      GatedFileSystemProvider.gate = new Deferred();
      const serverSave = services.shared.workspace.AstDocumentManager.save(uri, 'form');
      await didSave(harness, uri);
      // Long enough for a read-back that does not wait for the server's write.
      await tick(50);
      GatedFileSystemProvider.gate.resolve();
      await serverSave;
      await waitFor(() => savedBy.includes('language-client'), { timeoutMs: 500 });
      expect(onDisk()).toBe(SERVER_TEXT);
   });

   it('followed at once by the close of its only open is announced once', async () => {
      const { harness, uri, services } = await boot({ editorText: EDITOR_TEXT, withForm: false });
      const savedBy = recordSaves(services, uri);
      await expect(willSave(harness, uri)).resolves.toEqual([]);
      workspace!.write(FILE, EDITOR_TEXT);
      // Back to back, so the close releases the document while its save is read back.
      void didSave(harness, uri);
      await harness.closeDocument(uri);
      await waitFor(() => savedBy.length > 0, { timeoutMs: 500 });
      await tick(50);
      expect(savedBy).toEqual(['language-client']);
   });

   it('whose file cannot be read back is not announced, and fails nothing', async () => {
      const { harness, uri, services } = await boot();
      const savedBy = recordSaves(services, uri);
      const reported = watchReports(services);
      await expect(willSave(harness, uri)).resolves.toEqual([]);
      workspace!.write(FILE, SERVER_TEXT);
      GatedFileSystemProvider.failReads = true;
      await didSave(harness, uri);
      await readBackDone(services, uri, reported);
      expect(savedBy).toEqual([]);
      // The server goes on answering: a later editor save is announced.
      GatedFileSystemProvider.failReads = false;
      await expect(willSave(harness, uri)).resolves.toEqual([]);
      await didSave(harness, uri);
      await waitFor(() => savedBy.includes('language-client'), { timeoutMs: 500 });
   });
});

describe('the disk baseline of an editor-held document', () => {
   it('is the file an editor save left, so a save of the shared text turns the document clean', async () => {
      const { harness, uri, services } = await boot();
      const textDocuments = services.shared.workspace.TextDocuments;
      const reported = watchReports(services);
      expect(textDocuments.isDirty(uri)).toBe(true);
      await expect(willSave(harness, uri)).resolves.toEqual([]);

      workspace!.write(FILE, SERVER_TEXT);
      await didSave(harness, uri);
      await readBackDone(services, uri, reported);

      expect(textDocuments.isDirty(uri)).toBe(false);
   });

   it('is the file a watched change reports, written by another process', async () => {
      const { harness, uri, services } = await boot();
      const textDocuments = services.shared.workspace.TextDocuments;
      expect(textDocuments.isDirty(uri)).toBe(true);

      workspace!.write(FILE, SERVER_TEXT);
      await harness.client.sendNotification(DidChangeWatchedFilesNotification.type, { changes: [{ uri, type: FileChangeType.Changed }] });

      await waitFor(() => !textDocuments.isDirty(uri), { timeoutMs: 1000 });
   });
});
