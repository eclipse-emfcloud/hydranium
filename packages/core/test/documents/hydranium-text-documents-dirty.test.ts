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

import { textHash } from '@hydranium/protocol';
import { makeFakeClock, tick, waitFor, type FakeClock } from '@hydranium/protocol/testing';
import { type Event, isOperationCancelled, type LangiumDocument, OperationCancelled, URI } from '@hydranium/langium';
import { DefaultModelLedger } from '../../src/documents/model-ledger.js';
import { DefaultVersionSyncService } from '../../src/documents/version-sync-service.js';
import { describe, expect, it, vi } from 'vitest';
import { TextDocument } from 'vscode-languageserver-textdocument';
import type { ServerSharedServices } from '../../src/langium/module.js';
import { type DocumentDirtyChangedEvent } from '../../src/documents/dirty-state-tracker.js';
import { HydraniumTextDocuments } from '../../src/documents/hydranium-text-documents.js';
import { LANGUAGE_CLIENT_ID } from '../../src/documents/client-ids.js';
import { DefaultFileSystemTaskQueue } from '../../src/documents/file-system-task-queue.js';
import { DefaultDocumentUriPolicy } from '../../src/langium/workspace/document-uri-policy.js';
import { makeFakeAstNode, makeNoopTracer, makeStubLangiumDocuments, type StubLangiumDocuments } from '../../src/testing/index.js';
import { DefaultDocumentReleaseHandler } from '../../src/documents/document-release-handler.js';

const FILE = URI.file('/hydranium-test/dirty.a').toString();
const OTHER_FILE = URI.file('/hydranium-test/other.a').toString();
const DISK = 'on disk\n';
const EDITED = 'edited\n';

/** Reaches the store's protected editor-save path, which the LSP connection drives. */
class EditorSavingTextDocuments extends HydraniumTextDocuments<TextDocument> {
   editorSaved(uri: string): Promise<void> {
      return this.notifyLanguageClientSave({ textDocument: { uri } });
   }
}

/** Counts the reads of {@link onDidRecordModel}. */
class CountingVersionSyncService extends DefaultVersionSyncService {
   parseSubscriptions = 0;

   override get onDidRecordModel(): Event<LangiumDocument> {
      this.parseSubscriptions++;
      return super.onDidRecordModel;
   }
}

interface DirtyRig {
   readonly docs: EditorSavingTextDocuments;
   /** How many times the store subscribed to the parses the sync service records. */
   readonly parseSubscriptions: number;
   readonly sync: DefaultVersionSyncService;
   /** The registry, holding {@link FILE} until a build removes it. */
   readonly documents: StubLangiumDocuments;
   readonly clock: FakeClock;
   /** What the fake disk holds, by URI; a missing entry is a missing file. */
   readonly files: Map<string, string>;
   /** Every dirty flip, as `uri dirty`, in delivery order; `undefined` for a flip without text. */
   readonly flips: string[];
   /** The version of each flip in {@link flips} that carries text. */
   readonly flipVersions: number[];
   /** The text hash of each flip in {@link flips} that carries text. */
   readonly flipHashes: string[];
   /** How many write-lock sections have run to their end, a revert's included. */
   readonly locksReleased: number;
   /** How many `onUpdate` listeners are subscribed. */
   readonly updateListeners: number;
   /**
    * Make the next build run `before`, then throw `error`; `OperationCancelled`
    * resolves its write, as Langium's lock does.
    */
   failNextBuild(error?: unknown, before?: () => void): void;
   /** Build {@link FILE} from the fake disk, as a later build does. */
   buildFromFile(): Promise<void>;
   /** Hold the next revert rebuild until the returned function is called. */
   holdNextBuild(): () => void;
}

function makeRig(releaseGraceMs = 0): DirtyRig {
   const clock = makeFakeClock();
   const uriPolicy = new DefaultDocumentUriPolicy();
   const files = new Map<string, string>([[FILE, DISK]]);
   let locksReleased = 0;
   let nextBuildError: unknown;
   let beforeNextBuildError: (() => void) | undefined;
   const updateListeners: Array<(changed: URI[], deleted: URI[]) => void> = [];
   const langiumDocuments = makeStubLangiumDocuments([{ uri: FILE, root: makeFakeAstNode({ $type: 'Root' }) }]);
   const heldBuilds: Promise<void>[] = [];
   const write = async (action: (token: unknown) => unknown): Promise<unknown> => {
      try {
         return await action(undefined);
      } catch (err: unknown) {
         if (isOperationCancelled(err)) {
            return undefined;
         }
         throw err;
      } finally {
         locksReleased++;
      }
   };
   // As the document factory's re-parse: the rebuilt text reaches the sequence.
   // A deletion removes the document and is announced, as Langium's `update` does.
   const update = async (changed: URI[], deleted: URI[] = []): Promise<void> => {
      if (nextBuildError !== undefined) {
         const error = nextBuildError;
         const before = beforeNextBuildError;
         nextBuildError = undefined;
         beforeNextBuildError = undefined;
         // After the reset, so `before` can fail the build after this one too.
         before?.();
         throw error;
      }
      await heldBuilds.shift();
      // The stub holds FILE alone.
      if (deleted.some(uri => uri.toString() === FILE)) {
         langiumDocuments.clear();
      }
      for (const listener of updateListeners) {
         listener(changed, deleted);
      }
      for (const uri of changed) {
         const textDocument = TextDocument.create(uri.toString(), 'plaintext', 0, files.get(uri.toString()) ?? '');
         sync.modelProduced(langiumDocuments.set(uri, makeFakeAstNode({ $type: 'Root' }), { textDocument }));
      }
   };
   const services = {
      Clock: clock,
      Tracer: { for: () => makeNoopTracer() },
      workspace: {
         DocumentUriPolicy: uriPolicy,
         LangiumDocuments: langiumDocuments,
         FileSystemTaskQueue: new DefaultFileSystemTaskQueue({ workspace: { DocumentUriPolicy: uriPolicy } }),
         WorkspaceManager: { ready: Promise.resolve() },
         WorkspaceLock: { write, read: async (action: () => unknown) => action() },
         ModelLedger: new DefaultModelLedger(),
         DocumentBuilder: {
            markNextReason: () => undefined,
            update,
            scheduleUpdate: async (changed: URI[], deleted: URI[]) => {
               await write(() => update(changed, deleted));
            },
            onUpdate: (listener: (changed: URI[], deleted: URI[]) => void) => {
               updateListeners.push(listener);
               return { dispose: () => updateListeners.splice(updateListeners.indexOf(listener), 1) };
            }
         },
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
   const sync = new CountingVersionSyncService(services);
   services.workspace.VersionSyncService = sync;
   services.workspace.DocumentReleaseHandler = new DefaultDocumentReleaseHandler(services);
   const docs = new EditorSavingTextDocuments(services, { releaseGraceMs });
   Object.assign(services.workspace, { TextDocuments: docs });
   const flips: string[] = [];
   const flipVersions: number[] = [];
   const flipHashes: string[] = [];
   docs.onDidChangeDirty((event: DocumentDirtyChangedEvent) => {
      flips.push(`${event.uri} ${event.text?.dirty}`);
      if (event.text) {
         flipVersions.push(event.text.version);
         flipHashes.push(event.text.hash);
      }
   });
   return {
      docs,
      get parseSubscriptions() {
         return sync.parseSubscriptions;
      },
      sync,
      documents: langiumDocuments,
      clock,
      files,
      flips,
      flipVersions,
      flipHashes,
      get locksReleased() {
         return locksReleased;
      },
      get updateListeners() {
         return updateListeners.length;
      },
      failNextBuild: (error: unknown = new Error('build failed'), before?: () => void) => {
         nextBuildError = error;
         beforeNextBuildError = before;
      },
      buildFromFile: async () => {
         await write(() => update([URI.parse(FILE)]));
      },
      holdNextBuild: () => {
         let release!: () => void;
         heldBuilds.push(new Promise<void>(resolve => (release = resolve)));
         return () => release();
      }
   };
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

      docs.setDiskBaseline(FILE, EDITED);
      expect(docs.isDirty(FILE)).toBe(false);
      docs.setDiskBaseline(FILE, undefined);

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
      docs.setDiskBaseline(FILE, undefined);
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

   it("turns clean at the reverted text's version once the revert of a dirty document has run", async () => {
      const rig = makeRig();
      open(rig.docs, 'form');
      rig.docs.applyContentChange(FILE, EDITED, 'form');

      rig.docs.notifyDidCloseTextDocument({ textDocument: { uri: FILE } }, 'form');
      expect(rig.docs.isDirty(FILE)).toBe(false);
      expect(rig.flips).toEqual([`${FILE} true`]);
      await waitFor(() => rig.flips.length === 2);

      expect(rig.flips[1]).toBe(`${FILE} false`);
      expect(rig.flipVersions).toEqual([2, 3]);
      expect(rig.docs.version(FILE)).toBe(3);
   });

   it('keeps the version in the clean flip when the file already holds the released text', async () => {
      const rig = makeRig();
      open(rig.docs, 'form');
      rig.docs.applyContentChange(FILE, EDITED, 'form');
      rig.files.set(FILE, EDITED);

      rig.docs.notifyDidCloseTextDocument({ textDocument: { uri: FILE } }, 'form');
      await waitFor(() => rig.flips.length === 2);

      expect(rig.flipVersions).toEqual([2, 2]);
   });

   it('turns clean once for a released dirty document reopened before its revert, which takes no write', async () => {
      const rig = makeRig();
      open(rig.docs, 'form');
      rig.docs.applyContentChange(FILE, EDITED, 'form');

      rig.docs.notifyDidCloseTextDocument({ textDocument: { uri: FILE } }, 'form');
      open(rig.docs, 'other');
      expect(rig.flips).toEqual([`${FILE} true`, `${FILE} false`]);
      await tick();

      expect({ flips: rig.flips, versions: rig.flipVersions, locksReleased: rig.locksReleased }).toEqual({
         flips: [`${FILE} true`, `${FILE} false`],
         versions: [2, 3],
         locksReleased: 0
      });
   });

   it('leaves the clean flip of a second dirty release to its own revert', async () => {
      const rig = makeRig();
      const releaseFirst = rig.holdNextBuild();
      const releaseSecond = rig.holdNextBuild();
      open(rig.docs, 'form');
      rig.docs.applyContentChange(FILE, EDITED, 'form');
      rig.docs.notifyDidCloseTextDocument({ textDocument: { uri: FILE } }, 'form');
      await tick();
      open(rig.docs, 'form', EDITED);
      rig.docs.applyContentChange(FILE, 'edited again\n', 'form');
      rig.docs.notifyDidCloseTextDocument({ textDocument: { uri: FILE } }, 'form');
      const beforeFirstRevertEnds = [...rig.flips];

      releaseFirst();
      await waitFor(() => rig.locksReleased === 1);
      const afterFirstRevert = [...rig.flips];
      releaseSecond();
      await waitFor(() => rig.locksReleased === 2);

      expect(afterFirstRevert).toEqual(beforeFirstRevertEnds);
      expect(rig.flips.at(-1)).toBe(`${FILE} false`);
   });

   it("turns clean at the reverted text's version once the build after a failed revert has run", async () => {
      const rig = makeRig();
      open(rig.docs, 'form');
      rig.docs.applyContentChange(FILE, EDITED, 'form');
      rig.failNextBuild();

      rig.docs.notifyDidCloseTextDocument({ textDocument: { uri: FILE } }, 'form');
      await waitFor(() => rig.flips.length === 2);

      expect({ flips: rig.flips, versions: rig.flipVersions, hash: rig.flipHashes[1] }).toEqual({
         flips: [`${FILE} true`, `${FILE} false`],
         versions: [2, 3],
         hash: textHash(DISK)
      });
   });

   it("turns clean at the reverted text's version once the build a cancelled revert requests has run", async () => {
      const rig = makeRig();
      open(rig.docs, 'form');
      rig.docs.applyContentChange(FILE, EDITED, 'form');
      rig.failNextBuild(OperationCancelled);

      rig.docs.notifyDidCloseTextDocument({ textDocument: { uri: FILE } }, 'form');
      await waitFor(() => rig.flips.length === 2);

      expect({ flips: rig.flips, versions: rig.flipVersions, hash: rig.flipHashes[1] }).toEqual({
         flips: [`${FILE} true`, `${FILE} false`],
         versions: [2, 3],
         hash: textHash(DISK)
      });
   });

   it('names the file text when the connection goes after the revert parsed it', async () => {
      const rig = makeRig();
      open(rig.docs, 'form');
      rig.docs.applyContentChange(FILE, EDITED, 'form');
      // The revert parses, then its diagnostics publish finds the peer gone.
      rig.failNextBuild(new Error('Connection is disposed.'), () => {
         const textDocument = TextDocument.create(FILE, 'plaintext', 0, DISK);
         rig.sync.modelProduced(rig.documents.set(URI.parse(FILE), makeFakeAstNode({ $type: 'Root' }), { textDocument }));
      });

      rig.docs.notifyDidCloseTextDocument({ textDocument: { uri: FILE } }, 'form');
      await waitFor(() => rig.flips.length === 2);

      expect({ flips: rig.flips, hash: rig.flipHashes[1] }).toEqual({ flips: [`${FILE} true`, `${FILE} false`], hash: textHash(DISK) });
   });

   it('waits for the parse of its own document after a cancelled revert, not for any parse', async () => {
      const rig = makeRig();
      open(rig.docs, 'form');
      rig.docs.applyContentChange(FILE, EDITED, 'form');
      const releaseFollowUp = rig.holdNextBuild();
      rig.failNextBuild(OperationCancelled, () => {
         const textDocument = TextDocument.create(OTHER_FILE, 'plaintext', 0, DISK);
         rig.sync.modelProduced(rig.documents.set(URI.parse(OTHER_FILE), makeFakeAstNode({ $type: 'Root' }), { textDocument }));
      });

      rig.docs.notifyDidCloseTextDocument({ textDocument: { uri: FILE } }, 'form');
      await waitFor(() => rig.locksReleased === 1);
      const beforeOwnParse = [...rig.flips];
      releaseFollowUp();
      await waitFor(() => rig.flips.length === 2);

      expect({ beforeOwnParse, versions: rig.flipVersions, hash: rig.flipHashes[1] }).toEqual({
         beforeOwnParse: [`${FILE} true`],
         versions: [2, 3],
         hash: textHash(DISK)
      });
   });

   it('turns clean without text once the removal after a failed revert has run', async () => {
      const rig = makeRig();
      open(rig.docs, 'form');
      rig.docs.applyContentChange(FILE, EDITED, 'form');
      rig.files.delete(FILE);
      rig.failNextBuild();

      rig.docs.notifyDidCloseTextDocument({ textDocument: { uri: FILE } }, 'form');
      await waitFor(() => rig.flips.length === 2);

      expect(rig.flips).toEqual([`${FILE} true`, `${FILE} undefined`]);
   });

   it('turns clean without text, and stops waiting, once the build after a failed revert fails its retry too', async () => {
      const rig = makeRig();
      open(rig.docs, 'form');
      rig.docs.applyContentChange(FILE, EDITED, 'form');
      rig.failNextBuild(new Error('revert failed'), () => rig.failNextBuild(new Error('build failed'), () => rig.failNextBuild()));

      rig.docs.notifyDidCloseTextDocument({ textDocument: { uri: FILE } }, 'form');
      await waitFor(() => rig.locksReleased === 3);
      await tick();

      expect({ flips: rig.flips, updateListeners: rig.updateListeners }).toEqual({
         flips: [`${FILE} true`, `${FILE} undefined`],
         updateListeners: 0
      });
   });

   it('turns clean once for a document reopened between a cancelled revert and the build it requests', async () => {
      const rig = makeRig();
      open(rig.docs, 'form');
      rig.docs.applyContentChange(FILE, EDITED, 'form');
      const releaseFollowUp = rig.holdNextBuild();
      rig.failNextBuild(OperationCancelled);
      rig.docs.notifyDidCloseTextDocument({ textDocument: { uri: FILE } }, 'form');
      await waitFor(() => rig.locksReleased === 1);

      open(rig.docs, 'other');
      releaseFollowUp();
      await waitFor(() => rig.locksReleased === 2);

      expect(rig.flips).toEqual([`${FILE} true`, `${FILE} false`]);
   });

   it('waits for no parse after a revert that has no clean flip to send', async () => {
      const rig = makeRig();
      open(rig.docs, 'form');
      rig.docs.applyContentChange(FILE, EDITED, 'form');

      rig.docs.notifyDidCloseTextDocument({ textDocument: { uri: FILE } }, 'form');
      open(rig.docs, 'other');
      await tick();

      expect(rig.parseSubscriptions).toBe(0);
   });

   it('stays dirty while a lost client waits out the grace, and turns clean when the grace releases it', async () => {
      const { docs, clock, flips } = makeRig(1_000);
      open(docs, 'form');
      docs.applyContentChange(FILE, EDITED, 'form');

      docs.notifyDidCloseTextDocument({ textDocument: { uri: FILE } }, 'form', 'lost');
      expect(docs.isDirty(FILE)).toBe(true);
      await clock.advance(1_000);

      expect(docs.isDirty(FILE)).toBe(false);
      await waitFor(() => flips.length === 2);
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

describe('HydraniumTextDocuments — text state', () => {
   it('hashes the text of a held document once per version', () => {
      const { docs } = makeRig();
      open(docs, 'form');
      docs.applyContentChange(FILE, EDITED, 'form');
      const getText = vi.spyOn(docs.get(FILE)!, 'getText');

      const first = docs.textState(FILE);
      const reads = getText.mock.calls.length;
      const second = docs.textState(FILE);

      expect(first).toEqual({ version: 2, hash: textHash(EDITED), dirty: true });
      expect(second).toEqual(first);
      expect(getText.mock.calls.length).toBe(reads);
   });

   it('answers a released document with the hash it held, clean, without hashing its text again', async () => {
      const rig = makeRig();
      open(rig.docs, 'form');
      rig.docs.applyContentChange(FILE, EDITED, 'form');
      rig.files.set(FILE, EDITED);
      const held = rig.docs.textState(FILE);
      const getText = vi.spyOn(rig.docs.get(FILE)!, 'getText');

      rig.docs.notifyDidCloseTextDocument({ textDocument: { uri: FILE } }, 'form');

      expect(getText).not.toHaveBeenCalled();
      expect(rig.docs.textState(FILE)).toEqual({ ...held, dirty: false });
      await waitFor(() => rig.flips.length === 2);
      expect(rig.docs.textState(FILE)).toEqual({ version: 2, hash: textHash(EDITED), dirty: false });
   });

   it('answers nothing for a URI it never held', () => {
      const { docs } = makeRig();
      expect(docs.textState(FILE)).toBeUndefined();
   });
});
