/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * Client sessions through the real stack: `ModelService` hands out the handle,
 * the text store keeps the open table, and a real build runs behind every write.
 *
 * The real store is needed for its own open, close and delete paths and the
 * build behind every write, none of which the framework's stub store has.
 */

import {
   type ClientSession,
   DefaultClientSession,
   DefaultModelService,
   DocumentNotOpenError,
   DuplicateClientIdError,
   LANGUAGE_CLIENT_ID,
   type ServerSharedServices,
   SessionClosedError
} from '@hydranium/core';
import { type AstNode, DocumentState, URI } from '@hydranium/langium';
import { asSnapshotVersion, isConflictError } from '@hydranium/protocol';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { makeScratchWorkspaceHarness, type OrderFlowHarness, type ScratchOrderFlowHarness } from './order-flow-harness.js';

const FILE = 'session.domain';
const OTHER_FILE = 'session-other.domain';
const NEW_FILE = 'session-new.domain';
const CLEAN = `entity Solo {
   a : string
}
`;
const EDITED = `entity Solo {
   a : string
   b : string
}
`;

let scratch: ScratchOrderFlowHarness | undefined;

afterEach(() => {
   scratch?.workspace.dispose();
   scratch = undefined;
});

async function boot(): Promise<{
   harness: OrderFlowHarness;
   uri: string;
   otherUri: string;
   newUri: string;
   path: (file: string) => string;
}> {
   scratch = await makeScratchWorkspaceHarness(workspace => {
      workspace.write(FILE, CLEAN);
      workspace.write(OTHER_FILE, CLEAN);
   });
   const { harness, workspace } = scratch;
   return {
      harness,
      uri: workspace.uri(FILE),
      otherUri: workspace.uri(OTHER_FILE),
      newUri: workspace.uri(NEW_FILE),
      path: file => workspace.resolve(file)
   };
}

/**
 * Hold the disk read with index `which` (0 for the first issued) back until a
 * later macrotask, so the opens finish in a chosen order rather than the order
 * they started in.
 */
function delayRead(harness: OrderFlowHarness, which = 0): void {
   const fileSystem = harness.shared.workspace.FileSystemProvider;
   const readFile = fileSystem.readFile.bind(fileSystem);
   let issued = 0;
   fileSystem.readFile = async target => {
      if (issued++ === which) {
         await new Promise(resolve => setTimeout(resolve, 20));
      }
      return readFile(target);
   };
}

describe('ModelService.createSession', () => {
   it('mints a unique label#uuid id by default', async () => {
      const { harness } = await boot();
      const models = harness.shared.model.ModelService;

      const first = models.createSession('form');
      const second = models.createSession('form');
      const unlabelled = models.createSession();

      expect(first.clientId).toMatch(/^form#[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      expect(second.clientId).not.toBe(first.clientId);
      expect(first.label).toBe('form');
      expect(unlabelled.clientId).toMatch(/^session#/);
   });

   it('takes a fixed id, and refuses it while it is live or when the framework owns it', async () => {
      const { harness } = await boot();
      const models = harness.shared.model.ModelService;

      const session = models.createSession('form', 'form-1');

      expect(session.clientId).toBe('form-1');
      expect(models.getSession('form-1')).toBe(session);
      expect(() => models.createSession('form', 'form-1')).toThrow(DuplicateClientIdError);
      expect(() => models.createSession('lsp', LANGUAGE_CLIENT_ID)).toThrow(DuplicateClientIdError);

      session.dispose();
      expect(models.getSession('form-1')).toBeUndefined();
      expect(models.createSession('form', 'form-1').clientId).toBe('form-1');
   });

   it('refuses an id a client already has documents open under', async () => {
      const { harness, uri } = await boot();
      const models = harness.shared.model.ModelService;
      // A client that is not a session: the manager records opens for any id.
      await harness.shared.workspace.AstDocumentManager.open({ uri, clientId: 'wire-1' });

      expect(() => models.createSession('form', 'wire-1')).toThrow(DuplicateClientIdError);
   });

   it('types the open options it is created with', async () => {
      const { harness, uri } = await boot();
      const session = harness.shared.model.ModelService.createSession<{ readonly mode: string }>('form');

      const untyped = harness.shared.model.ModelService.createSession('other');
      await session.open(uri, { mode: 'compact' });
      // @ts-expect-error open options are an object even untyped, never a primitive
      const primitive = (): Promise<void> => untyped.open(uri, 'compact');

      expect(typeof primitive).toBe('function');
      expect(harness.shared.workspace.TextDocuments.openOptions(uri, session.clientId)).toEqual({ mode: 'compact' });
   });
});

describe('ClientSession writes', () => {
   it('refuses to write a document the session does not have open, and opens nothing', async () => {
      const { harness, uri } = await boot();
      const session = harness.shared.model.ModelService.createSession('form');

      await expect(session.update({ uri, model: EDITED, basedOn: 'anything' })).rejects.toBeInstanceOf(DocumentNotOpenError);
      await expect(session.save({ uri, model: EDITED, basedOn: 'anything' })).rejects.toBeInstanceOf(DocumentNotOpenError);

      expect(harness.shared.workspace.TextDocuments.isOpenInClient(uri, session.clientId)).toBe(false);
      expect(harness.shared.workspace.TextDocuments.isOpen(uri)).toBe(false);
   });

   it('writes and saves a document it has open, and recognises its own save', async () => {
      const { harness, uri, path } = await boot();
      const models = harness.shared.model.ModelService;
      const session = models.createSession('form');
      const savedBy: string[] = [];
      models.onModelSaved(uri, event => savedBy.push(event.sourceClientId));

      await session.open(uri);
      await session.save({ uri, model: EDITED, basedOn: 'anything' });

      expect(readFileSync(path(FILE), 'utf8')).toBe(EDITED);
      expect(savedBy.map(source => session.isOwnEcho(source))).toEqual([true]);
      expect(session.isOwnEcho('someone-else')).toBe(false);
   });

   it('fails a write whose open closed while it was in flight, and does not re-open', async () => {
      const { harness, uri } = await boot();
      const models = harness.shared.model.ModelService;
      const textDocuments = harness.shared.workspace.TextDocuments;
      // Another client keeps the document in the store, so a write that skipped
      // the check at apply would land rather than fail for want of a document.
      await models.createSession('bystander').open(uri);
      const session = models.createSession('form');
      await session.open(uri);

      const write = session.update({ uri, model: EDITED, basedOn: 'anything' });
      await session.close(uri);

      await expect(write).rejects.toBeInstanceOf(DocumentNotOpenError);
      expect(textDocuments.isOpenInClient(uri, session.clientId)).toBe(false);
      expect(textDocuments.get(uri)?.getText()).toBe(CLEAN);
   });

   it('fails an update in flight when its session ends, and leaves nothing behind', async () => {
      const { harness, uri } = await boot();
      const textDocuments = harness.shared.workspace.TextDocuments;
      const session = harness.shared.model.ModelService.createSession('form');
      await session.open(uri);

      const write = session.update({ uri, model: EDITED, basedOn: 'anything' });
      session.dispose();

      await expect(write).rejects.toBeInstanceOf(DocumentNotOpenError);
      expect(textDocuments.isOpenInClient(uri, session.clientId)).toBe(false);
      expect(textDocuments.openDocuments()).toEqual([]);
   });

   it('fails a save in flight when its session ends, and writes nothing to disk', async () => {
      const { harness, uri, path } = await boot();
      const textDocuments = harness.shared.workspace.TextDocuments;
      const session = harness.shared.model.ModelService.createSession('form');
      await session.open(uri);

      const write = session.save({ uri, model: EDITED, basedOn: 'anything' });
      session.dispose();

      await expect(write).rejects.toBeInstanceOf(DocumentNotOpenError);
      expect(readFileSync(path(FILE), 'utf8')).toBe(CLEAN);
      expect(textDocuments.openDocuments()).toEqual([]);
   });

   it('fails a save whose open closed after its text applied, before the save took the text, and writes nothing', async () => {
      const { harness, uri, path } = await boot();
      const models = harness.shared.model.ModelService;
      const textDocuments = harness.shared.workspace.TextDocuments;
      // Another client keeps the document in the store, so a save that skipped
      // the check would find text to write.
      await models.createSession('bystander').open(uri);
      const session = models.createSession('form');
      await session.open(uri);
      // The rebuild of the applied text parses it before the save goes on.
      harness.shared.workspace.DocumentBuilder.onDocumentPhase(DocumentState.Parsed, document => {
         if (document.textDocument.getText() === EDITED) {
            void session.close(uri);
         }
      });

      await expect(session.save({ uri, model: EDITED, basedOn: 'anything' })).rejects.toBeInstanceOf(DocumentNotOpenError);

      expect(textDocuments.get(uri)?.getText()).toBe(EDITED);
      expect(readFileSync(path(FILE), 'utf8')).toBe(CLEAN);
   });

   it('fails a save whose session ended after its text applied, and writes nothing', async () => {
      const { harness, uri, path } = await boot();
      const models = harness.shared.model.ModelService;
      await models.createSession('bystander').open(uri);
      const session = models.createSession('form');
      await session.open(uri);
      harness.shared.workspace.DocumentBuilder.onDocumentPhase(DocumentState.Parsed, document => {
         if (document.textDocument.getText() === EDITED) {
            session.dispose();
         }
      });

      await expect(session.save({ uri, model: EDITED, basedOn: 'anything' })).rejects.toBeInstanceOf(DocumentNotOpenError);

      expect(readFileSync(path(FILE), 'utf8')).toBe(CLEAN);
   });
});

/** `modelToText` is protected; the updateAll race tests step into it by name. */
type ModelToText = (uri: string, model: unknown, cancelToken?: unknown) => Promise<string>;

/**
 * Run `intervene` once, when the service starts serialising a document whose URI
 * ends with `file`, before that serialisation continues: a write that has passed
 * its door check and has not applied yet.
 */
function interveneWhileSerialising(harness: OrderFlowHarness, file: string, intervene: () => Promise<unknown>): void {
   const models = harness.shared.model.ModelService as unknown as { modelToText: ModelToText };
   const modelToText = models.modelToText.bind(models);
   let done = false;
   models.modelToText = async (uri, model, cancelToken) => {
      if (!done && uri.endsWith(file)) {
         done = true;
         await intervene();
      }
      return modelToText(uri, model, cancelToken);
   };
}

describe('ClientSession.updateAll', () => {
   it('applies every document of the set and rebuilds each', async () => {
      const { harness, uri, otherUri } = await boot();
      const textDocuments = harness.shared.workspace.TextDocuments;
      const session = harness.shared.model.ModelService.createSession('diagram');
      await session.open(uri);
      await session.open(otherUri);

      const documents = await session.updateAll({
         updates: [
            { uri, model: EDITED, basedOn: asSnapshotVersion(textDocuments.version(uri)) },
            { uri: otherUri, model: EDITED, basedOn: asSnapshotVersion(textDocuments.version(otherUri)) }
         ]
      });

      expect(documents.map(document => document.uri)).toEqual([uri, otherUri]);
      expect(documents.every(document => document.root !== undefined)).toBe(true);
      expect(textDocuments.get(uri)?.getText()).toBe(EDITED);
      expect(textDocuments.get(otherUri)?.getText()).toBe(EDITED);
   });

   it('applies nothing, and serialises nothing, when a later document of the set is stale', async () => {
      const { harness, uri, otherUri } = await boot();
      const textDocuments = harness.shared.workspace.TextDocuments;
      const session = harness.shared.model.ModelService.createSession('diagram');
      await session.open(uri);
      await session.open(otherUri);
      const before = textDocuments.version(uri);
      let serialised = 0;
      interveneWhileSerialising(harness, FILE, async () => {
         serialised++;
      });

      const write = session.updateAll({
         updates: [
            { uri, model: EDITED, basedOn: asSnapshotVersion(before) },
            { uri: otherUri, model: EDITED, basedOn: asSnapshotVersion(textDocuments.version(otherUri) + 5) }
         ]
      });

      await expect(write).rejects.toSatisfy(isConflictError);
      expect(textDocuments.get(uri)?.getText()).toBe(CLEAN);
      expect(textDocuments.version(uri)).toBe(before);
      expect(serialised).toBe(0);
   });

   it('applies nothing when another write overtakes a later document while the set is serialised', async () => {
      // The door check passes for both documents; only a check in the step that
      // applies them can see the foreign write that landed in between.
      const { harness, uri, otherUri } = await boot();
      const models = harness.shared.model.ModelService;
      const textDocuments = harness.shared.workspace.TextDocuments;
      const session = models.createSession('diagram');
      await session.open(uri);
      await session.open(otherUri);
      const before = textDocuments.version(uri);
      const otherBefore = textDocuments.version(otherUri);
      const bystander = models.createSession('bystander');
      await bystander.open(otherUri);
      interveneWhileSerialising(harness, OTHER_FILE, () => bystander.update({ uri: otherUri, model: `${CLEAN}\n`, basedOn: 'anything' }));

      const write = session.updateAll({
         updates: [
            { uri, model: EDITED, basedOn: asSnapshotVersion(before) },
            { uri: otherUri, model: EDITED, basedOn: asSnapshotVersion(otherBefore) }
         ]
      });

      await expect(write).rejects.toSatisfy(isConflictError);
      expect(textDocuments.get(uri)?.getText()).toBe(CLEAN);
      expect(textDocuments.version(uri)).toBe(before);
      expect(textDocuments.get(otherUri)?.getText()).toBe(`${CLEAN}\n`);
   });

   it('applies nothing when the session closes a later document while the set is serialised', async () => {
      const { harness, uri, otherUri } = await boot();
      const models = harness.shared.model.ModelService;
      const textDocuments = harness.shared.workspace.TextDocuments;
      // A bystander keeps the other document in the store, so the write fails
      // for want of the session's open rather than for want of a document.
      await models.createSession('bystander').open(otherUri);
      const session = models.createSession('diagram');
      await session.open(uri);
      await session.open(otherUri);
      interveneWhileSerialising(harness, OTHER_FILE, () => session.close(otherUri));

      const write = session.updateAll({
         updates: [
            { uri, model: EDITED, basedOn: 'anything' },
            { uri: otherUri, model: EDITED, basedOn: 'anything' }
         ]
      });

      await expect(write).rejects.toBeInstanceOf(DocumentNotOpenError);
      expect(textDocuments.get(uri)?.getText()).toBe(CLEAN);
      expect(textDocuments.get(otherUri)?.getText()).toBe(CLEAN);
   });

   it('refuses a set naming one document twice, before applying anything', async () => {
      const { harness, uri } = await boot();
      const textDocuments = harness.shared.workspace.TextDocuments;
      const session = harness.shared.model.ModelService.createSession('diagram');
      await session.open(uri);

      await expect(
         session.updateAll({
            updates: [
               { uri, model: EDITED, basedOn: 'anything' },
               { uri, model: `${EDITED}\n`, basedOn: 'anything' }
            ]
         })
      ).rejects.toThrow(/more than once/);
      expect(textDocuments.get(uri)?.getText()).toBe(CLEAN);
   });
});

describe('ClientSession open and close', () => {
   it('stores the options of the first open and keeps them across a repeat open', async () => {
      const { harness, uri } = await boot();
      const session = harness.shared.model.ModelService.createSession('form');

      await session.open(uri, { mode: 'first' });
      await session.open(uri, { mode: 'second' });

      expect(harness.shared.workspace.TextDocuments.openOptions(uri, session.clientId)).toEqual({ mode: 'first' });
   });

   // Both finishing orders, because each alone is satisfied by a rule other
   // than "the first call wins": first-to-finish passes when the first read is
   // fast, last-to-finish when it is slow.
   it.each([
      ['finishes last', 0],
      ['finishes first', 1]
   ])('keeps the options of the first of two concurrent opens when it %s', async (_order, slowRead) => {
      const { harness, uri } = await boot();
      delayRead(harness, slowRead);
      const session = harness.shared.model.ModelService.createSession('form');

      await Promise.all([session.open(uri, { mode: 'first' }), session.open(uri, { mode: 'second' })]);

      expect(harness.shared.workspace.TextDocuments.openOptions(uri, session.clientId)).toEqual({ mode: 'first' });
   });

   it('withOpen leaves open a document a plain open of the session is still opening', async () => {
      const { harness, uri } = await boot();
      delayRead(harness);
      const session = harness.shared.model.ModelService.createSession('form');

      const opening = session.open(uri);
      // The callback outlasts the plain open, so withOpen's close comes after it.
      await session.withOpen(uri, () => opening);

      expect(harness.shared.workspace.TextDocuments.isOpenInClient(uri, session.clientId)).toBe(true);
   });

   it('withOpen leaves open a document the session already had open', async () => {
      const { harness, uri } = await boot();
      const session = harness.shared.model.ModelService.createSession('form');
      await session.open(uri);

      await session.withOpen(uri, () => undefined);

      expect(harness.shared.workspace.TextDocuments.isOpenInClient(uri, session.clientId)).toBe(true);
   });

   it('withOpen opens for the callback and closes afterwards, also when it throws', async () => {
      const { harness, uri } = await boot();
      const textDocuments = harness.shared.workspace.TextDocuments;
      const session = harness.shared.model.ModelService.createSession('form');

      const seen = await session.withOpen(uri, () => textDocuments.isOpenInClient(uri, session.clientId));
      const failure = session.withOpen(uri, () => {
         throw new Error('callback failed');
      });

      expect(seen).toBe(true);
      await expect(failure).rejects.toThrow('callback failed');
      expect(textDocuments.isOpenInClient(uri, session.clientId)).toBe(false);
   });

   it('dispose closes everything the session has open, and every later call throws at once', async () => {
      const { harness, uri, otherUri } = await boot();
      const textDocuments = harness.shared.workspace.TextDocuments;
      const session = harness.shared.model.ModelService.createSession('form');
      await session.open(uri);
      await session.open(otherUri);

      session.dispose();

      expect(textDocuments.isOpenInClient(uri, session.clientId)).toBe(false);
      expect(textDocuments.isOpenInClient(otherUri, session.clientId)).toBe(false);
      const calls: Array<[string, () => unknown]> = [
         ['open', () => session.open(uri)],
         ['create', () => session.create(uri, CLEAN)],
         ['update', () => session.update({ uri, model: EDITED, basedOn: 'anything' })],
         ['save', () => session.save({ uri, model: EDITED, basedOn: 'anything' })],
         ['close', () => session.close(uri)],
         ['withOpen', () => session.withOpen(uri, () => undefined)],
         ['isOwnEcho', () => session.isOwnEcho(session.clientId)]
      ];
      for (const [name, call] of calls) {
         expect(call, name).toThrow(SessionClosedError);
      }
      expect(() => session.dispose()).not.toThrow();
   });

   it('rejects an open that was in flight when the session ended, and leaves nothing open', async () => {
      const { harness, uri } = await boot();
      const session = harness.shared.model.ModelService.createSession('form');

      const pending = session.open(uri);
      session.dispose();

      await expect(pending).rejects.toBeInstanceOf(SessionClosedError);
      expect(harness.shared.workspace.TextDocuments.isOpenInClient(uri, session.clientId)).toBe(false);
   });

   it('does not close the open of a new session that reuses the id of one that ended mid-open', async () => {
      const { harness, uri } = await boot();
      const models = harness.shared.model.ModelService;
      const fileSystem = harness.shared.workspace.FileSystemProvider;
      const readFile = fileSystem.readFile.bind(fileSystem);
      let release: () => void = () => undefined;
      const gate = new Promise<void>(resolve => {
         release = resolve;
      });
      let first = true;
      // Holds the old session's disk read open until the new session is in, so
      // the old open completes last.
      fileSystem.readFile = async target => {
         if (first) {
            first = false;
            await gate;
         }
         return readFile(target);
      };
      const old = models.createSession('form', 'form-1');
      // Settled into its outcome at once: it rejects before `freshOpen`
      // resolves, and a handler attached after that await is attached late.
      const pending = old.open(uri).then(
         () => undefined,
         (error: unknown) => error
      );
      old.dispose();
      const fresh = models.createSession('form', 'form-1');
      const freshOpen = fresh.open(uri);
      release();

      await freshOpen;
      expect(await pending).toBeInstanceOf(SessionClosedError);
      expect(harness.shared.workspace.TextDocuments.isOpenInClient(uri, 'form-1')).toBe(true);
   });

   it('ends the handle when the store closes its session directly', async () => {
      const { harness, uri } = await boot();
      const models = harness.shared.model.ModelService;
      const session = models.createSession('form');

      harness.shared.workspace.TextDocuments.closeSession(session.clientId);

      expect(() => session.open(uri)).toThrow(SessionClosedError);
      expect(models.getSession(session.clientId)).toBeUndefined();
   });
});

describe('ClientSession.create', () => {
   it('creates a document that exists nowhere, open in the session and unsaved until saved', async () => {
      const { harness, newUri, path } = await boot();
      const session = harness.shared.model.ModelService.createSession('form');

      await session.create(newUri, CLEAN);

      expect(harness.shared.workspace.TextDocuments.isOpenInClient(newUri, session.clientId)).toBe(true);
      expect(harness.shared.workspace.TextDocuments.get(newUri)?.getText()).toBe(CLEAN);
      expect(existsSync(path(NEW_FILE))).toBe(false);

      await session.save({ uri: newUri, model: CLEAN, basedOn: 'anything' });
      expect(readFileSync(path(NEW_FILE), 'utf8')).toBe(CLEAN);
   });

   it('refuses a URI that exists on disk', async () => {
      const { harness, uri } = await boot();
      const session = harness.shared.model.ModelService.createSession('form');

      await expect(session.create(uri, EDITED)).rejects.toThrow(/exists/);
      expect(harness.shared.workspace.TextDocuments.isOpenInClient(uri, session.clientId)).toBe(false);
   });

   it('refuses a URI another client has open, even one not yet on disk', async () => {
      const { harness, newUri } = await boot();
      const models = harness.shared.model.ModelService;
      await models.createSession('other').create(newUri, CLEAN);
      const session = models.createSession('form');

      await expect(session.create(newUri, EDITED)).rejects.toThrow(/open/);
      expect(harness.shared.workspace.TextDocuments.get(newUri)?.getText()).toBe(CLEAN);
   });
});

describe('ClientSession.create races', () => {
   it('lets exactly one of two concurrent creates of one URI succeed, keeping its text', async () => {
      const { harness, newUri } = await boot();
      const models = harness.shared.model.ModelService;
      const textDocuments = harness.shared.workspace.TextDocuments;
      const fileSystem = harness.shared.workspace.FileSystemProvider;
      const exists = fileSystem.exists.bind(fileSystem);
      let release: () => void = () => undefined;
      const gate = new Promise<void>(resolve => {
         release = resolve;
      });
      let waiting = 0;
      // Both disk checks answer together, so each create passes its open check
      // before either open has registered.
      fileSystem.exists = async target => {
         const answer = await exists(target);
         waiting += 1;
         if (waiting === 2) {
            release();
         }
         await gate;
         return answer;
      };
      const first = models.createSession('one');
      const second = models.createSession('two');

      const results = await Promise.allSettled([first.create(newUri, CLEAN), second.create(newUri, EDITED)]);

      expect(results.map(result => result.status).sort()).toEqual(['fulfilled', 'rejected']);
      const winner = results[0].status === 'fulfilled' ? first : second;
      expect(textDocuments.get(newUri)?.getText()).toBe(winner === first ? CLEAN : EDITED);
      expect(textDocuments.openDocuments()).toEqual([{ uri: newUri, clients: [winner.clientId] }]);
   });

   it('fails when another client created the document first and left before create resumed', async () => {
      const { harness, newUri } = await boot();
      const models = harness.shared.model.ModelService;
      const textDocuments = harness.shared.workspace.TextDocuments;
      const session = models.createSession('form');
      const notifyDidOpen = textDocuments.notifyDidOpenTextDocument.bind(textDocuments);
      let injected = false;
      // Another client's open of the new URI registers just before this
      // session's, with its own text, and closes again before create resumes.
      textDocuments.notifyDidOpenTextDocument = (params, clientId) => {
         if (!injected && clientId === session.clientId) {
            injected = true;
            notifyDidOpen({ textDocument: { ...params.textDocument, text: EDITED } }, 'other');
            notifyDidOpen(params, clientId);
            queueMicrotask(() => textDocuments.notifyDidCloseTextDocument({ textDocument: { uri: newUri } }, 'other'));
            return;
         }
         notifyDidOpen(params, clientId);
      };

      await expect(session.create(newUri, CLEAN)).rejects.toThrow(/open/);
      expect(textDocuments.isOpenInClient(newUri, session.clientId)).toBe(false);
   });

   it('opens nothing when the session ends while create checks the disk', async () => {
      const { harness, newUri } = await boot();
      const textDocuments = harness.shared.workspace.TextDocuments;
      const events: string[] = [];
      textDocuments.onDidOpen(event => events.push(`open ${event.clientId}`));
      textDocuments.onDidClose(event => events.push(`close ${event.clientId}`));
      const session = harness.shared.model.ModelService.createSession('form');

      const pending = session.create(newUri, CLEAN);
      session.dispose();

      await expect(pending).rejects.toBeInstanceOf(SessionClosedError);
      expect(events).toEqual([]);
   });
});

describe('deletion closes a session open', () => {
   it('closes the open of a deleted file, so a later write fails as not open', async () => {
      const { harness, uri, path } = await boot();
      const session = harness.shared.model.ModelService.createSession('form');
      await session.open(uri);

      rmSync(path(FILE));
      await harness.shared.workspace.DocumentBuilder.update([], [URI.parse(uri)]);

      expect(harness.shared.workspace.TextDocuments.isOpenInClient(uri, session.clientId)).toBe(false);
      await expect(session.update({ uri, model: EDITED, basedOn: 'anything' })).rejects.toBeInstanceOf(DocumentNotOpenError);
   });
});

describe('DefaultModelService.newSession', () => {
   class LabelledSession extends DefaultClientSession<AstNode> {
      describe(): string {
         return `${this.label} (${this.clientId})`;
      }
   }

   class LabellingModelService extends DefaultModelService<AstNode> {
      protected override newSession(clientId: string, label: string): LabelledSession {
         return new LabelledSession(this, this.sessionWriter(), this.services, clientId, label);
      }
   }

   it('builds the handle while registration stays in createSession', async () => {
      scratch = await makeScratchWorkspaceHarness(undefined, {
         extraSharedModules: [{ model: { ModelService: (services: ServerSharedServices) => new LabellingModelService(services) } }]
      });
      const models = scratch.harness.shared.model.ModelService;

      const session: ClientSession<AstNode> = models.createSession('form', 'form-1');

      expect(session).toBeInstanceOf(LabelledSession);
      expect((session as LabelledSession).describe()).toBe('form (form-1)');
      expect(() => models.createSession('form', 'form-1')).toThrow(DuplicateClientIdError);
   });

   it('frees the id again when building the handle throws', async () => {
      class FailingModelService extends DefaultModelService<AstNode> {
         protected override newSession(): LabelledSession {
            throw new Error('no handle');
         }
      }
      scratch = await makeScratchWorkspaceHarness(undefined, {
         extraSharedModules: [{ model: { ModelService: (services: ServerSharedServices) => new FailingModelService(services) } }]
      });
      const models = scratch.harness.shared.model.ModelService;

      expect(() => models.createSession('form', 'form-1')).toThrow('no handle');
      expect(() => scratch?.harness.shared.workspace.TextDocuments.registerSession('form-1')).not.toThrow();
   });
});
