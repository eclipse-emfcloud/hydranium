/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

// Stub the Theia editor and file-service modules before importing the SUT: the
// real ones pull DOM globals unavailable under Vitest's node environment. The
// SUT reads them only as injection tokens.
vi.mock('@theia/editor/lib/browser/editor-manager', () => ({ EditorManager: class EditorManager {} }));
vi.mock('@theia/filesystem/lib/browser/file-service', () => ({ FileService: class FileService {} }));

import { Deferred } from '@hydranium/protocol';
import { tick, waitFor } from '@hydranium/protocol/lib/testing';
import { Emitter } from '@theia/core';
import URI from '@theia/core/lib/common/uri';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EditorDiskSync, isResyncableEditorDocument } from '../../src/browser/editor-disk-sync';

const FILE = 'file:///workspace/a.domain';

/** The members of Theia's Monaco editor model the sync reads and resets. */
interface FakeDocument {
   readonly uri: string;
   dirty: boolean;
   text: string;
   readonly contentChanges: unknown[];
   resourceVersion: unknown;
   readonly reverts: unknown[];
   getText(): string;
   revert(options?: unknown): Promise<void>;
   run(operation: () => Promise<void>): Promise<void>;
   onModelWillSaveModel(listener: () => Promise<void>): { dispose(): void };
   /** Run the will-save listeners, as a save does before it writes. */
   willSave(): Promise<void>;
   /** Occupy the operation queue, as a save in flight does, until `finish` runs. */
   beginSave(): { finish(): void };
}

function fakeDocument(text: string, dirty = true): FakeDocument {
   let queue = Promise.resolve();
   const willSaveListeners: Array<() => Promise<void>> = [];
   const document: FakeDocument = {
      uri: FILE,
      dirty,
      text,
      contentChanges: [{ text: 'XY' }],
      resourceVersion: { etag: 'old', mtime: 1, encoding: 'utf8' },
      reverts: [],
      getText: () => document.text,
      revert: async options => {
         document.reverts.push(options);
         document.dirty = false;
      },
      run: operation => (queue = queue.then(operation)),
      onModelWillSaveModel: listener => {
         willSaveListeners.push(listener);
         return { dispose: () => willSaveListeners.splice(willSaveListeners.indexOf(listener), 1) };
      },
      willSave: async () => {
         await Promise.all(willSaveListeners.map(listener => listener()));
      },
      beginSave: () => {
         let finish!: () => void;
         void document.run(() => new Promise<void>(resolve => (finish = resolve)));
         return { finish: () => finish() };
      }
   };
   return document;
}

interface Rig {
   readonly sync: EditorDiskSync;
   readonly reads: string[];
   readonly warnings: string[];
   readonly errors: string[];
   /** Open an editor on `document`, as Theia does after the sync started. */
   openEditor(document: object): void;
   /** Report a change of `uri`, as the file watcher does. */
   change(type?: number): void;
   /** Resolve the pending read with `value`. */
   answerRead(value: string): void;
   /** Reject the pending read, as for a file gone or unreadable. */
   failRead(): void;
}

function makeRig(documents: FakeDocument[], sync = new EditorDiskSync()): Rig {
   const changes = new Emitter<{ changes: Array<{ type: number; resource: URI }> }>();
   const reads: string[] = [];
   let pending: Deferred<{ value: string; etag: string; mtime: number; encoding: string }> | undefined;
   const fileService = {
      onDidFilesChange: changes.event,
      read: (uri: URI) => {
         reads.push(uri.toString());
         pending = new Deferred();
         return pending.promise;
      }
   };
   const created = new Emitter<{ editor: { document: object }; onDidDispose: Emitter<void>['event'] }>();
   const widget = (document: object): { editor: { document: object }; onDidDispose: Emitter<void>['event'] } => ({
      editor: { document },
      onDidDispose: new Emitter<void>().event
   });
   const editorManager = { all: documents.map(widget), onCreated: created.event };
   const warnings: string[] = [];
   const errors: string[] = [];
   const logger = {
      warn: (message: string) => void warnings.push(message),
      error: (message: string) => void errors.push(message)
   };
   Object.assign(sync, { fileService, editorManager, logger });
   sync.onStart();
   return {
      sync,
      reads,
      warnings,
      errors,
      openEditor: document => {
         const opened = widget(document);
         editorManager.all.push(opened);
         created.fire(opened);
      },
      change: (type = 0) => changes.fire({ changes: [{ type, resource: new URI(FILE) }] }),
      answerRead: value => pending?.resolve({ value, etag: 'new', mtime: 2, encoding: 'utf8' }),
      failRead: () => pending?.reject(new Error('not found'))
   };
}

const OLD_VERSION = { etag: 'old', mtime: 1, encoding: 'utf8' };
const NEW_VERSION = { etag: 'new', mtime: 2, encoding: 'utf8' };

describe('EditorDiskSync', () => {
   afterEach(() => {
      vi.useRealTimers();
   });

   it('marks a dirty editor clean on the version it read when the file now holds its text', async () => {
      const document = fakeDocument('buffer');
      const rig = makeRig([document]);

      rig.change();
      await waitFor(() => rig.reads.length === 1);
      rig.answerRead('buffer');
      await waitFor(() => !document.dirty);

      expect(document.contentChanges).toEqual([]);
      expect(document.resourceVersion).toEqual(NEW_VERSION);
      expect(document.reverts).toEqual([{ soft: true }]);
   });

   it('leaves an editor alone whose buffer the file does not hold', async () => {
      const document = fakeDocument('buffer');
      const rig = makeRig([document]);

      rig.change();
      await waitFor(() => rig.reads.length === 1);
      rig.answerRead('other text');
      await tick();

      expect(document.dirty).toBe(true);
      expect(document.contentChanges).toHaveLength(1);
   });

   it('leaves an editor alone that was typed in while the file was read', async () => {
      const document = fakeDocument('buffer');
      const rig = makeRig([document]);

      rig.change();
      await waitFor(() => rig.reads.length === 1);
      document.text = 'buffer!';
      rig.answerRead('buffer');
      await tick();

      expect(document.dirty).toBe(true);
      expect(document.contentChanges).toHaveLength(1);
   });

   it('reads nothing for a clean editor', async () => {
      const rig = makeRig([fakeDocument('buffer', false)]);
      rig.change();
      await tick();

      expect(rig.reads).toEqual([]);
   });

   it('drops the pending edits a file holds before the editor saves, and lets the save go on', async () => {
      const document = fakeDocument('buffer');
      const rig = makeRig([]);
      rig.openEditor(document);

      const saving = document.willSave();
      rig.answerRead('buffer');
      await saving;

      expect(document.contentChanges).toEqual([]);
      expect(document.resourceVersion).toEqual(NEW_VERSION);
      expect(document.reverts).toEqual([]);
      expect(document.dirty).toBe(true);
   });

   it('keeps an edit made after the save began pending, for the save to write onto the file', async () => {
      // A save participant edits the buffer while the file is read.
      const document = fakeDocument('buffer');
      const rig = makeRig([document]);

      const saving = document.willSave();
      document.text = 'buffer!';
      document.contentChanges.push({ text: '!' });
      rig.answerRead('buffer');
      await saving;

      expect(document.contentChanges).toEqual([{ text: '!' }]);
      expect(document.resourceVersion).toEqual(NEW_VERSION);
      expect(document.reverts).toEqual([]);
   });

   it('leaves a save alone whose file does not hold the buffer', async () => {
      const document = fakeDocument('buffer');
      const rig = makeRig([document]);

      const saving = document.willSave();
      rig.answerRead('other text');
      await saving;

      expect(document.contentChanges).toHaveLength(1);
      expect(document.resourceVersion).toEqual(OLD_VERSION);
   });

   it('leaves a save alone whose file cannot be read', async () => {
      const document = fakeDocument('buffer');
      const rig = makeRig([document]);

      const saving = document.willSave();
      rig.failRead();
      await saving;

      expect(document.contentChanges).toHaveLength(1);
      expect(document.resourceVersion).toEqual(OLD_VERSION);
      expect(rig.errors).toEqual([]);
   });

   it('lets a save go on once the file has not been read within the bound, and ignores the late answer', async () => {
      vi.useFakeTimers();
      const document = fakeDocument('buffer');
      const rig = makeRig([document]);
      let saved = false;

      const saving = document.willSave().then(() => (saved = true));
      await vi.advanceTimersByTimeAsync(999);
      expect(saved).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await saving;
      rig.answerRead('buffer');
      await vi.advanceTimersByTimeAsync(10);

      expect(document.contentChanges).toHaveLength(1);
      expect(document.resourceVersion).toEqual(OLD_VERSION);
   });

   it('clears its bound once the file is read', async () => {
      vi.useFakeTimers();
      const document = fakeDocument('buffer');
      const rig = makeRig([document]);

      const saving = document.willSave();
      rig.answerRead('buffer');
      await saving;

      expect(vi.getTimerCount()).toBe(0);
   });

   it('logs a check that throws rather than failing the save or the sync', async () => {
      class ThrowingSync extends EditorDiskSync {
         protected override dropChangesOnDisk(): Promise<void> {
            throw new Error('check failed');
         }
         protected override syncIfOnDisk(): Promise<void> {
            throw new Error('sync failed');
         }
      }
      const document = fakeDocument('buffer');
      const rig = makeRig([document], new ThrowingSync());

      await document.willSave();
      rig.change();
      await waitFor(() => rig.errors.length === 2);
   });

   it('syncs after a save in flight rather than during it, and not at all once the save made it clean', async () => {
      // A save in flight removes the edits it sent from the pending ones when
      // it finishes; a sync during it would clear them first, and the save
      // would then remove the edits typed meanwhile.
      const document = fakeDocument('buffer');
      const rig = makeRig([document]);
      const save = document.beginSave();

      rig.change();
      await tick();
      expect(rig.reads).toEqual([]);
      document.dirty = false;
      document.contentChanges.splice(0);
      save.finish();
      await tick();

      expect(rig.reads).toEqual([]);
      expect(document.reverts).toEqual([]);
   });

   it('syncs once a save in flight has finished with the editor still dirty', async () => {
      const document = fakeDocument('buffer');
      const rig = makeRig([document]);
      const save = document.beginSave();

      rig.change();
      await tick();
      expect(rig.reads).toEqual([]);
      save.finish();
      await waitFor(() => rig.reads.length === 1);
      rig.answerRead('buffer');
      await waitFor(() => !document.dirty);

      expect(document.contentChanges).toEqual([]);
      expect(document.reverts).toEqual([{ soft: true }]);
   });

   it('warns once when an editor holds a document without the members it resets', async () => {
      const rig = makeRig([]);
      rig.openEditor({ uri: FILE, dirty: true });
      rig.openEditor({ uri: FILE, dirty: true });

      expect(rig.warnings).toHaveLength(1);
   });

   it('recognises only a document carrying the members it resets', () => {
      const document = fakeDocument('buffer');
      expect(isResyncableEditorDocument(document as never)).toBe(true);
      expect(isResyncableEditorDocument({ ...document, contentChanges: undefined } as never)).toBe(false);
   });
});
