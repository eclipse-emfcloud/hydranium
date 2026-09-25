/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * The disk baseline the text store keeps per open document, and the dirty
 * state read from it. The store is real; the disk behind it is a map.
 */

import { makeFakeClock, type FakeClock } from '@hydranium/protocol/testing';
import { URI } from '@hydranium/langium';
import { describe, expect, it } from 'vitest';
import type { TextDocument } from 'vscode-languageserver-textdocument';
import type { ServerSharedServices } from '../../src/langium/module.js';
import { type DocumentDirtyChangedEvent, HydraniumTextDocuments } from '../../src/documents/hydranium-text-documents.js';
import { LANGUAGE_CLIENT_ID } from '../../src/documents/client-ids.js';
import { DefaultFileSystemTaskQueue } from '../../src/documents/file-system-task-queue.js';
import { DefaultDocumentUriPolicy } from '../../src/langium/workspace/document-uri-policy.js';
import { makeNoopTracer } from '../../src/testing/index.js';

const FILE = URI.file('/hydranium-test/dirty.a').toString();
const DISK = 'on disk\n';
const EDITED = 'edited\n';

/** Reaches the store's protected editor-save path, which the LSP connection drives. */
class EditorSavingTextDocuments extends HydraniumTextDocuments<TextDocument> {
   editorSaved(uri: string): Promise<void> {
      return this.notifyLanguageClientSave({ textDocument: { uri } });
   }
}

interface DirtyRig {
   readonly docs: EditorSavingTextDocuments;
   readonly clock: FakeClock;
   /** What the fake disk holds, by URI; a missing entry is a missing file. */
   readonly files: Map<string, string>;
   /** Every dirty flip, as `uri dirty`, in delivery order. */
   readonly flips: string[];
}

function makeRig(revertGraceMs = 0): DirtyRig {
   const clock = makeFakeClock();
   const uriPolicy = new DefaultDocumentUriPolicy();
   const files = new Map<string, string>([[FILE, DISK]]);
   const services = {
      Clock: clock,
      Tracer: { for: () => makeNoopTracer() },
      workspace: {
         DocumentUriPolicy: uriPolicy,
         FileSystemTaskQueue: new DefaultFileSystemTaskQueue({ workspace: { DocumentUriPolicy: uriPolicy } }),
         WorkspaceManager: { ready: Promise.resolve() },
         WorkspaceLock: { write: async (action: (token: unknown) => unknown) => action(undefined) },
         DocumentBuilder: { markNextReason: () => undefined, update: async () => undefined },
         FileSystemProvider: {
            exists: async (uri: URI) => files.has(uri.toString()),
            readFile: async (uri: URI) => {
               const text = files.get(uri.toString());
               if (text === undefined) {
                  throw Object.assign(new Error(`ENOENT: ${uri.fsPath}`), { code: 'ENOENT', path: uri.fsPath });
               }
               return text;
            }
         }
      }
   } as unknown as ServerSharedServices;
   const docs = new EditorSavingTextDocuments(services, { revertGraceMs });
   const flips: string[] = [];
   docs.onDidChangeDirty((event: DocumentDirtyChangedEvent) => flips.push(`${event.uri} ${event.dirty}`));
   return { docs, clock, files, flips };
}

function open(docs: HydraniumTextDocuments<TextDocument>, clientId: string, text = DISK): void {
   docs.notifyDidOpenTextDocument({ textDocument: { uri: FILE, languageId: 'plaintext', version: 1, text } }, clientId);
}

describe('HydraniumTextDocuments — disk baseline and dirty state', () => {
   it('opens clean on the text it opened with, and flips on each change of the answer', () => {
      const { docs, flips } = makeRig();
      open(docs, 'form');
      expect(docs.isDirty(FILE)).toBe(false);

      docs.applyContentChange(FILE, EDITED, 'form');
      docs.applyContentChange(FILE, 'edited again\n', 'form');
      docs.applyContentChange(FILE, DISK, 'form');

      expect(flips).toEqual([`${FILE} true`, `${FILE} false`]);
      expect(docs.isDirty(FILE)).toBe(false);
   });

   it('reads an editor change against the baseline as a server write is', () => {
      const { docs, flips } = makeRig();
      open(docs, LANGUAGE_CLIENT_ID);

      docs.notifyDidChangeTextDocument({ textDocument: { uri: FILE, version: 2 }, contentChanges: [{ text: EDITED }] });

      expect(docs.isDirty(FILE)).toBe(true);
      expect(flips).toEqual([`${FILE} true`]);
   });

   it('answers clean for a URI no client has open', () => {
      const { docs } = makeRig();
      expect(docs.isDirty(FILE)).toBe(false);
   });

   it('takes a baseline it is given: the file text cleans, no file dirties', () => {
      const { docs, flips } = makeRig();
      open(docs, 'form');
      docs.applyContentChange(FILE, EDITED, 'form');

      docs.updateDiskBaseline(FILE, EDITED);
      expect(docs.isDirty(FILE)).toBe(false);
      docs.updateDiskBaseline(FILE, undefined);

      expect(docs.isDirty(FILE)).toBe(true);
      expect(flips).toEqual([`${FILE} true`, `${FILE} false`, `${FILE} true`]);
   });

   it('takes the text a save announces as the file, before the save is announced', () => {
      const { docs, flips } = makeRig();
      open(docs, 'form');
      docs.applyContentChange(FILE, EDITED, 'form');
      const dirtyAtSave: boolean[] = [];
      docs.onDidSave(() => dirtyAtSave.push(docs.isDirty(FILE)));

      docs.notifyDidSaveTextDocument({ textDocument: { uri: FILE }, text: EDITED }, 'form');

      expect(dirtyAtSave).toEqual([false]);
      expect(flips).toEqual([`${FILE} true`, `${FILE} false`]);
   });

   it('keeps the baseline for a save announced without its text', () => {
      const { docs } = makeRig();
      open(docs, 'form');
      docs.applyContentChange(FILE, EDITED, 'form');

      docs.notifyDidSaveTextDocument({ textDocument: { uri: FILE } }, 'form');

      expect(docs.isDirty(FILE)).toBe(true);
   });

   it('ignores a baseline for a URI no client has open', () => {
      const { docs, flips } = makeRig();
      docs.updateDiskBaseline(FILE, undefined);
      open(docs, 'form');

      expect(docs.isDirty(FILE)).toBe(false);
      expect(flips).toEqual([]);
   });

   it('opens dirty on integrity-staged content, which is not on disk', () => {
      const { docs, flips } = makeRig();
      docs.stagePendingContent(FILE, 'repaired\n');

      open(docs, LANGUAGE_CLIENT_ID);

      expect(docs.isDirty(FILE)).toBe(true);
      expect(flips).toEqual([`${FILE} true`]);
   });

   it('flips on a repair committed to the store, and not on one that changes nothing', () => {
      const { docs, flips } = makeRig();
      open(docs, 'form');

      docs.commitRepair(FILE, DISK, DISK);
      expect(flips).toEqual([]);
      docs.commitRepair(FILE, DISK, 'repaired\n');

      expect(docs.isDirty(FILE)).toBe(true);
      expect(flips).toEqual([`${FILE} true`]);
   });

   it('turns clean when the last close releases a dirty document', () => {
      const { docs, flips } = makeRig();
      open(docs, 'form');
      docs.applyContentChange(FILE, EDITED, 'form');

      docs.notifyDidCloseTextDocument({ textDocument: { uri: FILE } }, 'form');

      expect(docs.isDirty(FILE)).toBe(false);
      expect(flips).toEqual([`${FILE} true`, `${FILE} false`]);
   });

   it('stays dirty while a lost client waits out the grace, and turns clean when the grace releases it', async () => {
      const { docs, clock, flips } = makeRig(1_000);
      open(docs, 'form');
      docs.applyContentChange(FILE, EDITED, 'form');

      docs.notifyDidCloseTextDocument({ textDocument: { uri: FILE } }, 'form', 'lost');
      expect(docs.isDirty(FILE)).toBe(true);
      await clock.advance(1_000);

      expect(docs.isDirty(FILE)).toBe(false);
      expect(flips).toEqual([`${FILE} true`, `${FILE} false`]);
   });

   it('opens clean for another client that releases a document waiting out the grace', () => {
      const { docs, flips } = makeRig(1_000);
      open(docs, 'form');
      docs.applyContentChange(FILE, EDITED, 'form');
      docs.notifyDidCloseTextDocument({ textDocument: { uri: FILE } }, 'form', 'lost');

      open(docs, 'other');

      expect(docs.isDirty(FILE)).toBe(false);
      expect(flips).toEqual([`${FILE} true`, `${FILE} false`]);
   });

   it('reloads the baseline from the file, and counts a file it cannot read as none', async () => {
      const { docs, files, flips } = makeRig();
      open(docs, 'form');
      docs.applyContentChange(FILE, EDITED, 'form');

      files.set(FILE, EDITED);
      await docs.reloadDiskBaseline(FILE);
      expect(docs.isDirty(FILE)).toBe(false);
      files.delete(FILE);
      await docs.reloadDiskBaseline(FILE);

      expect(docs.isDirty(FILE)).toBe(true);
      expect(flips).toEqual([`${FILE} true`, `${FILE} false`, `${FILE} true`]);
   });

   it('takes the read-back of an editor save as the baseline, whether or not it matches the store', async () => {
      const { docs, files } = makeRig();
      open(docs, LANGUAGE_CLIENT_ID);
      docs.notifyDidChangeTextDocument({ textDocument: { uri: FILE, version: 2 }, contentChanges: [{ text: EDITED }] });

      files.set(FILE, EDITED);
      await docs.editorSaved(FILE);
      expect(docs.isDirty(FILE)).toBe(false);
      files.set(FILE, 'older\n');
      await docs.editorSaved(FILE);

      expect(docs.isDirty(FILE)).toBe(true);
   });
});
