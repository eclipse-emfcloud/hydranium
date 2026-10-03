/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * The version sync service over a real text store and ledger, with the
 * builder's `scheduleUpdate` recorded rather than run.
 */

import { describe, expect, it } from 'vitest';
import { DocumentState, OperationCancelled, URI } from '@hydranium/langium';
import { STALE_VERSION, UNRECORDED_VERSION } from '@hydranium/protocol';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { HydraniumTextDocuments } from '../../src/documents/hydranium-text-documents.js';
import { type RecoveryBuildRequest, DefaultVersionSyncService } from '../../src/documents/version-sync-service.js';
import type { ServerSharedServices } from '../../src/langium/module.js';
import { makeCapturingLogger, makeFakeAstNode, makeTestServices } from '../../src/testing/index.js';

const URI_A = 'file:///a.x';
const URI_B = 'file:///b.x';

interface ScheduledBuild {
   readonly changed: string[];
   readonly deleted: string[];
   readonly reason: string | undefined;
}

interface SyncRig {
   readonly sync: DefaultVersionSyncService;
   readonly services: ServerSharedServices;
   readonly textDocuments: HydraniumTextDocuments;
   readonly documents: ReturnType<typeof makeTestServices>['documents'];
   /** Every `scheduleUpdate` the service made, in order. */
   readonly builds: ScheduledBuild[];
   /** What the next builds do instead of resolving: one entry per build, taken in order. */
   readonly outcomes: Array<'fail' | (() => Promise<void>)>;
   readonly warnings: () => string[];
   readonly errors: () => string[];
}

function makeRig(): SyncRig {
   const { logger, lines } = makeCapturingLogger();
   const bundle = makeTestServices({ logger });
   const textDocuments = new HydraniumTextDocuments(bundle.services);
   const services = {
      ...bundle.services,
      workspace: { ...bundle.services.workspace, TextDocuments: textDocuments }
   } as ServerSharedServices;
   const sync = new DefaultVersionSyncService(services);
   services.workspace.VersionSyncService = sync;
   const builds: ScheduledBuild[] = [];
   const outcomes: SyncRig['outcomes'] = [];
   bundle.documentBuilder.scheduleUpdate = (changed: URI[], deleted: URI[], reason?: string) => {
      builds.push({ changed: changed.map(String), deleted: deleted.map(String), reason });
      const outcome = outcomes.shift();
      if (outcome === 'fail') {
         return Promise.reject(new Error(`build ${builds.length} failed`));
      }
      return outcome ? outcome() : Promise.resolve();
   };
   const messages = (level: string): string[] => lines.filter(line => line.level === level).map(line => line.message);
   return {
      sync,
      services,
      textDocuments,
      documents: bundle.documents,
      builds,
      outcomes,
      warnings: () => messages('warn'),
      errors: () => messages('error')
   };
}

/** Register a root for `uri` parsed from `text`, whose text document stands at `version`. */
function register(rig: SyncRig, uri: string, text: string, version = 0): ReturnType<SyncRig['documents']['set']> {
   return rig.documents.set(uri, makeFakeAstNode({ $type: 'Element' }), {
      textDocument: TextDocument.create(uri, 'plaintext', version, text)
   });
}

/** Settle every lock read and build the service queued. */
async function settle(rig: SyncRig): Promise<void> {
   for (let i = 0; i < 5; i++) {
      await rig.services.workspace.WorkspaceLock.read(() => undefined);
   }
}

function open(rig: SyncRig, uri: string, version: number, text: string): void {
   rig.textDocuments.notifyDidOpenTextDocument({ textDocument: { uri, languageId: 'plaintext', version, text } }, 'reader');
}

describe('DefaultVersionSyncService.modelProduced', () => {
   it('re-stamps a rebuilt closed document with the stepped sequence version', () => {
      const rig = makeRig();
      open(rig, URI_A, 1, '');
      rig.textDocuments.notifyDidChangeTextDocument(
         { textDocument: { uri: URI_A, version: 2 }, contentChanges: [{ text: 'edited\n' }] },
         'reader'
      );
      rig.textDocuments.notifyDidCloseTextDocument({ textDocument: { uri: URI_A } }, 'reader');
      // The revert reads the pre-edit disk content into a factory-fresh document.
      const document = register(rig, URI_A, '');

      rig.sync.modelProduced(document);

      expect({
         document: document.textDocument.version,
         store: rig.textDocuments.version(URI_A),
         recorded: rig.services.workspace.ModelLedger.versionOf(document.parseResult.value)
      }).toEqual({ document: 3, store: 3, recorded: 3 });
   });

   it('re-stamps an unchanged rebuilt closed document without stepping the sequence', () => {
      const rig = makeRig();
      open(rig, URI_A, 1, '');
      rig.textDocuments.notifyDidChangeTextDocument(
         { textDocument: { uri: URI_A, version: 2 }, contentChanges: [{ text: 'saved\n' }] },
         'reader'
      );
      rig.textDocuments.notifyDidCloseTextDocument({ textDocument: { uri: URI_A } }, 'reader');
      const document = register(rig, URI_A, 'saved\n');

      rig.sync.modelProduced(document);

      expect({ document: document.textDocument.version, store: rig.textDocuments.version(URI_A) }).toEqual({ document: 2, store: 2 });
   });

   it('keeps the factory version of a never-tracked document', () => {
      const rig = makeRig();
      const document = register(rig, URI_B, 'x\n');

      rig.sync.modelProduced(document);

      expect(document.textDocument.version).toBe(0);
   });

   it('announces every reconciled root, and syncs each to the store’s version', () => {
      const rig = makeRig();
      const asked: Array<{ uri: string; version: number }> = [];
      rig.sync.syncTo = (uri, version) => {
         asked.push({ uri: uri.toString(), version });
         return undefined;
      };
      const announced: string[] = [];
      rig.sync.onDidRecordModel(document => announced.push(document.uri.toString()));
      open(rig, URI_A, 1, 'open\n');
      const recorded: number[] = [];

      for (const [uri, text] of [
         [URI_A, 'open\n'],
         [URI_A, 'file\n'],
         [URI_B, 'closed\n']
      ]) {
         const document = register(rig, uri, text);
         rig.services.workspace.ModelLedger.record(document.parseResult.value, STALE_VERSION);
         rig.sync.modelProduced(document);
         recorded.push(rig.services.workspace.ModelLedger.versionOf(document.parseResult.value));
      }

      expect({ announced, asked, recorded }).toEqual({
         announced: [URI_A, URI_A, URI_B],
         asked: [
            { uri: URI_A, version: 1 },
            { uri: URI_A, version: 1 },
            { uri: URI_B, version: 0 }
         ],
         recorded: [1, STALE_VERSION, 0]
      });
   });

   it('records the origin’s version of a root not registered, and leaves the store alone', () => {
      const rig = makeRig();
      const announced: string[] = [];
      rig.sync.onDidRecordModel(document => announced.push(document.uri.toString()));
      const probe = register(rig, URI_A, '');
      rig.documents.clear();

      rig.sync.modelProduced(probe, { version: 4 });

      expect({
         recorded: rig.services.workspace.ModelLedger.versionOf(probe.parseResult.value),
         sequence: rig.textDocuments.textState(URI_A),
         announced
      }).toEqual({ recorded: 4, sequence: undefined, announced: [] });
   });

   it('marks a root registered below Parsed as a placeholder, and announces nothing', () => {
      const rig = makeRig();
      const announced: string[] = [];
      rig.sync.onDidRecordModel(document => announced.push(document.uri.toString()));
      const document = rig.documents.set(URI_A, makeFakeAstNode({ $type: 'Element' }), { state: DocumentState.Changed });

      rig.sync.modelProduced(document, { version: 2 });

      const ledger = rig.services.workspace.ModelLedger;
      expect({
         placeholder: ledger.isPlaceholder(document.parseResult.value),
         version: ledger.versionOf(document.parseResult.value),
         announced
      }).toEqual({ placeholder: true, version: UNRECORDED_VERSION, announced: [] });
   });

   it('reconciles and records the origin’s text in place of the parsed one', () => {
      const rig = makeRig();
      const document = register(rig, URI_A, 'unrepaired\n');
      rig.sync.modelProduced(document);

      rig.sync.modelProduced(document, { text: 'repaired\n' });

      const ledger = rig.services.workspace.ModelLedger;
      expect({
         version: ledger.versionOf(document.parseResult.value),
         text: ledger.textOf(document.parseResult.value),
         store: rig.textDocuments.version(URI_A)
      }).toEqual({ version: 1, text: 'repaired\n', store: 1 });
   });
});

describe('DefaultVersionSyncService.syncTo', () => {
   const uri = URI.parse(URI_A);

   function behindRig(recorded: number | undefined): SyncRig {
      const rig = makeRig();
      const document = register(rig, URI_A, 'a');
      if (recorded !== undefined) {
         rig.services.workspace.ModelLedger.record(document.parseResult.value, recorded);
      }
      return rig;
   }

   it.each([
      ['builds a root recorded below the version', 1, true, [URI_A]],
      ['builds nothing for a root at the version', 2, false, []],
      ['builds nothing for a root nothing recorded', undefined, false, []]
   ])('%s', async (_case, recorded, behind, expected) => {
      const rig = behindRig(recorded);

      const answer = rig.sync.syncTo(uri, 2);
      await settle(rig);

      expect({ behind: answer !== undefined, built: rig.builds.flatMap(build => build.changed) }).toEqual({ behind, built: expected });
   });

   it('builds nothing for a placeholder', async () => {
      const rig = makeRig();
      const document = rig.documents.set(URI_A, makeFakeAstNode({ $type: 'Element' }), { state: DocumentState.Changed });
      rig.sync.modelProduced(document);

      expect(rig.sync.syncTo(uri, 2)).toBeUndefined();
   });

   it('builds nothing for a root a registered check defers the build of', async () => {
      const rig = behindRig(1);
      rig.sync.registerDeferredBuilds(deferred => deferred.toString() === URI_A);

      const answer = rig.sync.syncTo(uri, 2);
      await settle(rig);

      expect({ answer: await answer, builds: rig.builds }).toEqual({ answer: true, builds: [] });
   });

   it('builds nothing for a root a build synced before the lock read ran', async () => {
      const rig = behindRig(1);
      const lock = rig.services.workspace.WorkspaceLock;
      let release!: () => void;
      const held = new Promise<void>(resolve => (release = resolve));
      let entered!: () => void;
      const holding = new Promise<void>(resolve => (entered = resolve));
      const building = lock.write(() => {
         entered();
         return held;
      });
      await holding;

      const answer = rig.sync.syncTo(uri, 2);
      rig.services.workspace.ModelLedger.record(rig.documents.getDocument(uri)!.parseResult.value, 2);
      release();
      await building;
      await settle(rig);

      expect({ behind: answer !== undefined, builds: rig.builds }).toEqual({ behind: true, builds: [] });
   });
});

describe('DefaultVersionSyncService.requestRecoveryBuild', () => {
   const uri = URI.parse(URI_A);
   const needed = (overrides: Partial<RecoveryBuildRequest> = {}): RecoveryBuildRequest => ({ stillNeeded: () => true, ...overrides });

   it('builds once for requests made while the first waits for the lock', async () => {
      const rig = makeRig();
      let release!: () => void;
      const building = rig.services.workspace.WorkspaceLock.write(() => new Promise<void>(resolve => (release = resolve)));
      await Promise.resolve();

      const answers = [
         rig.sync.requestRecoveryBuild(uri, needed()),
         rig.sync.requestRecoveryBuild(uri, needed()),
         rig.sync.requestRecoveryBuild(uri, needed())
      ];
      release();
      await building;

      expect({ answers: await Promise.all(answers), builds: rig.builds.length }).toEqual({ answers: [true, true, true], builds: 1 });
   });

   it('builds once more after a build that a request arrived during, asking that request again first', async () => {
      const rig = makeRig();
      let finish!: () => void;
      rig.outcomes.push(() => new Promise<void>(resolve => (finish = resolve)));
      const first = rig.sync.requestRecoveryBuild(uri, needed());
      await settle(rig);
      let asked = 0;
      let stillNeeded = true;

      const second = rig.sync.requestRecoveryBuild(uri, {
         stillNeeded: () => {
            asked++;
            return stillNeeded;
         }
      });
      const third = rig.sync.requestRecoveryBuild(uri, { stillNeeded: () => false });
      finish();
      await first;
      await settle(rig);
      stillNeeded = false;
      const skipped = rig.sync.requestRecoveryBuild(uri, { stillNeeded: () => stillNeeded });
      await settle(rig);

      expect({ asked, builds: rig.builds.length, answers: await Promise.all([second, third, skipped]) }).toEqual({
         asked: 1,
         builds: 2,
         answers: [true, true, true]
      });
   });

   it('builds a deferred URI for a request that ignores the deferral, with its reason', async () => {
      const rig = makeRig();
      rig.sync.registerDeferredBuilds(() => true);

      await rig.sync.requestRecoveryBuild(uri, needed({ ignoreDeferred: true, reason: 'didClose' }));

      expect(rig.builds).toEqual([{ changed: [URI_A], deleted: [], reason: 'didClose' }]);
   });

   it('removes the document when a still-needed request of the batch asks to', async () => {
      const rig = makeRig();
      let release!: () => void;
      const building = rig.services.workspace.WorkspaceLock.write(() => new Promise<void>(resolve => (release = resolve)));
      await Promise.resolve();

      const answers = [
         rig.sync.requestRecoveryBuild(uri, needed()),
         rig.sync.requestRecoveryBuild(uri, needed({ deleted: true })),
         rig.sync.requestRecoveryBuild(uri, { deleted: true, reason: 'ignored', stillNeeded: () => false })
      ];
      release();
      await building;
      await Promise.all(answers);

      expect(rig.builds).toEqual([{ changed: [], deleted: [URI_A], reason: undefined }]);
   });

   it('retries a failed build once', async () => {
      const rig = makeRig();
      rig.outcomes.push('fail');

      const answer = await rig.sync.requestRecoveryBuild(uri, needed());

      expect({ answer, builds: rig.builds.length, warnings: rig.warnings().length, errors: rig.errors() }).toEqual({
         answer: true,
         builds: 2,
         warnings: 1,
         errors: []
      });
   });

   it('gives up on a build that fails again, answering false and logging an error', async () => {
      const rig = makeRig();
      rig.outcomes.push('fail', 'fail');

      const answer = await rig.sync.requestRecoveryBuild(uri, needed());
      await settle(rig);

      expect({ answer, builds: rig.builds.length, errors: rig.errors().map(error => error.split('\n')[0]) }).toEqual({
         answer: false,
         builds: 2,
         errors: ['Requested build failed again; giving up. Error: build 2 failed']
      });
   });

   it('answers a request whose build succeeded true, though a later batch gives up', async () => {
      const rig = makeRig();
      let finish!: () => void;
      rig.outcomes.push(() => new Promise<void>(resolve => (finish = resolve)), 'fail', 'fail');
      const first = rig.sync.requestRecoveryBuild(uri, needed());
      await settle(rig);

      const second = rig.sync.requestRecoveryBuild(uri, needed());
      finish();

      expect({ first: await first, second: await second, builds: rig.builds.length }).toEqual({ first: true, second: false, builds: 3 });
   });

   it('gives a request that joins a failing batch retries of its own', async () => {
      const rig = makeRig();
      let failFirst!: () => void;
      rig.outcomes.push(() => new Promise<void>((_resolve, reject) => (failFirst = () => reject(new Error('first')))), 'fail');
      const first = rig.sync.requestRecoveryBuild(uri, needed());
      await settle(rig);

      const late = rig.sync.requestRecoveryBuild(uri, needed());
      failFirst();

      expect({ first: await first, late: await late, builds: rig.builds.length }).toEqual({ first: false, late: true, builds: 3 });
   });

   it('builds a request again, spending no retry, when a later write cancels its build before it runs', async () => {
      const rig = makeRig();
      const lock = rig.services.workspace.WorkspaceLock;
      let completed = 0;
      rig.outcomes.push(() => {
         const build = lock.write(token => {
            // As Langium's update checks its token.
            if (token.isCancellationRequested) {
               throw OperationCancelled;
            }
            completed++;
         });
         // An edit after the build is queued, before it runs.
         queueMicrotask(() => void lock.write(() => undefined));
         return build;
      });

      const answer = await rig.sync.requestRecoveryBuild(uri, needed());

      expect({ answer, completed, builds: rig.builds.length, warnings: rig.warnings(), errors: rig.errors() }).toEqual({
         answer: true,
         completed: 0,
         builds: 2,
         warnings: [],
         errors: []
      });
   });

   it('builds rather than removes the document when a change request follows a deletion in one batch', async () => {
      const rig = makeRig();
      let release!: () => void;
      const building = rig.services.workspace.WorkspaceLock.write(() => new Promise<void>(resolve => (release = resolve)));
      await Promise.resolve();

      const answers = [rig.sync.requestRecoveryBuild(uri, needed({ deleted: true })), rig.sync.requestRecoveryBuild(uri, needed())];
      release();
      await building;
      await Promise.all(answers);

      expect(rig.builds).toEqual([{ changed: [URI_A], deleted: [], reason: undefined }]);
   });
});
