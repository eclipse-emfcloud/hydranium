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
   type WrittenAstDocument,
   type ClientSession,
   type ClientSessionFactory,
   type ClientSessionPersistArgs,
   type ClientSessionWriteArgs,
   DefaultClientSession,
   DefaultModelService,
   DocumentNotOpenError,
   DuplicateClientIdError,
   LANGUAGE_CLIENT_ID,
   RealpathDocumentUriPolicy,
   ReentrantWriteLockError,
   ReservedClientIdError,
   type ServerSharedServices,
   SessionClosedError
} from '@hydranium/core';
import { type AstNode, DocumentState, URI } from '@hydranium/langium';
import { asModelVersion, isConflictError, type TextVersion, type TransferElement, UNKNOWN_CLIENT_ID } from '@hydranium/protocol';
import { type CancellationToken, FileChangeType, type FileEvent } from 'vscode-languageserver';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { afterEach, describe, expect, it, onTestFinished } from 'vitest';
import { isDomainModel, isEntity } from '../src/language-server/ast.js';
import type { OrderFlowSharedServices } from '../src/language-server/order-flow-module.js';
import { makeCapturingTracer } from '@hydranium/core/testing';
import { makeScratchWorkspaceHarness, type OrderFlowHarness, type ScratchOrderFlowHarness, WORKSPACE_FILES } from './order-flow-harness.js';

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
      expect(() => models.createSession('lsp', LANGUAGE_CLIENT_ID)).toThrow(ReservedClientIdError);

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
      expect(session.openOptions(uri)).toEqual({ mode: 'compact' });
   });
});

describe('ClientSession writes', () => {
   it('refuses to write a document the session does not have open, and opens nothing', async () => {
      const { harness, uri } = await boot();
      const session = harness.shared.model.ModelService.createSession('form');

      await expect(session.update({ uri, model: EDITED, baseVersion: 'any' })).rejects.toBeInstanceOf(DocumentNotOpenError);
      await expect(session.save({ uri, model: EDITED, baseVersion: 'any' })).rejects.toBeInstanceOf(DocumentNotOpenError);

      expect(harness.shared.workspace.TextDocuments.isOpenInClient(uri, session.clientId)).toBe(false);
      expect(harness.shared.workspace.TextDocuments.isOpen(uri)).toBe(false);
   });

   it('writes and saves a document it has open, and recognises its own save', async () => {
      const { harness, uri, path } = await boot();
      const models = harness.shared.model.ModelService;
      const session = models.createSession('form');
      const savedBy: string[] = [];
      models.onModelSaved(event => savedBy.push(event.sourceClientId), { uri });

      await session.open(uri);
      await session.save({ uri, model: EDITED, baseVersion: 'any' });

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

      const write = session.update({ uri, model: EDITED, baseVersion: 'any' });
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

      const write = session.update({ uri, model: EDITED, baseVersion: 'any' });
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

      const write = session.save({ uri, model: EDITED, baseVersion: 'any' });
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

      await expect(session.save({ uri, model: EDITED, baseVersion: 'any' })).rejects.toBeInstanceOf(DocumentNotOpenError);

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

      await expect(session.save({ uri, model: EDITED, baseVersion: 'any' })).rejects.toBeInstanceOf(DocumentNotOpenError);

      expect(readFileSync(path(FILE), 'utf8')).toBe(CLEAN);
   });
});

/**
 * Run `intervene` once, when the service starts serialising a document whose URI
 * ends with `file`, before that serialisation continues: a write that has passed
 * its door check and has not applied yet.
 */
function interveneWhileSerialising(harness: OrderFlowHarness, file: string, intervene: () => Promise<unknown>): void {
   const models = harness.shared.model.ModelService;
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
            { uri, model: EDITED, baseVersion: asModelVersion(textDocuments.version(uri)) },
            { uri: otherUri, model: EDITED, baseVersion: asModelVersion(textDocuments.version(otherUri)) }
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
            { uri, model: EDITED, baseVersion: asModelVersion(before) },
            { uri: otherUri, model: EDITED, baseVersion: asModelVersion(textDocuments.version(otherUri) + 5) }
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
      interveneWhileSerialising(harness, OTHER_FILE, () => bystander.update({ uri: otherUri, model: `${CLEAN}\n`, baseVersion: 'any' }));

      const write = session.updateAll({
         updates: [
            { uri, model: EDITED, baseVersion: asModelVersion(before) },
            { uri: otherUri, model: EDITED, baseVersion: asModelVersion(otherBefore) }
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
            { uri, model: EDITED, baseVersion: 'any' },
            { uri: otherUri, model: EDITED, baseVersion: 'any' }
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
               { uri, model: EDITED, baseVersion: 'any' },
               { uri, model: `${EDITED}\n`, baseVersion: 'any' }
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

      expect(session.openOptions(uri)).toEqual({ mode: 'first' });
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

      expect(session.openOptions(uri)).toEqual({ mode: 'first' });
   });

   it('drops the options with the open, so a later open without any has none', async () => {
      const { harness, uri } = await boot();
      const session = harness.shared.model.ModelService.createSession('form');

      await session.open(uri, { mode: 'first' });
      await session.close(uri);
      expect(session.openOptions(uri)).toBeUndefined();
      await session.open(uri);

      expect(session.openOptions(uri)).toBeUndefined();
   });

   it("shows a listener of the store's open the options of that open, not of an earlier one", async () => {
      const { harness, uri } = await boot();
      const session = harness.shared.model.ModelService.createSession('form');
      await session.open(uri, { mode: 'first' });
      await session.close(uri);
      const heard: unknown[] = [];
      harness.shared.workspace.TextDocuments.onDidOpen(event => {
         if (event.clientId === session.clientId) {
            heard.push(session.openOptions(uri));
         }
      });

      await session.open(uri, { mode: 'second' });
      await session.close(uri);
      await session.open(uri);

      expect(heard).toEqual([{ mode: 'second' }, undefined]);
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
         ['update', () => session.update({ uri, model: EDITED, baseVersion: 'any' })],
         ['save', () => session.save({ uri, model: EDITED, baseVersion: 'any' })],
         ['close', () => session.close(uri)],
         ['delete', () => session.delete({ uri, baseVersion: 'any' })],
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

      await session.save({ uri: newUri, model: CLEAN, baseVersion: 'any' });
      expect(readFileSync(path(NEW_FILE), 'utf8')).toBe(CLEAN);
   });

   it('resolves with the version it created the document at, not one a write made before it resolved', async () => {
      const { harness, newUri } = await boot();
      const store = harness.shared.workspace.TextDocuments;
      const session = harness.shared.model.ModelService.createSession('form');
      let createdAt: number | undefined;
      const listener = store.onDidOpen(event => {
         createdAt = event.document.version;
         queueMicrotask(() => void harness.shared.workspace.AstDocumentManager.update(newUri, EDITED, 'other'));
      });
      onTestFinished(() => listener.dispose());

      const version = await session.create(newUri, CLEAN);

      expect({ version, later: store.version(newUri) > version }).toEqual({ version: createdAt, later: true });
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

describe('ClientSession.create under RealpathDocumentUriPolicy', () => {
   // The policy answers "no loadable content" for a path not on disk, which a
   // created document is until its first save.
   it('builds a created document before its first save and after it', async () => {
      scratch = await makeScratchWorkspaceHarness(undefined, {
         extraSharedModules: [
            { workspace: { DocumentUriPolicy: (services: ServerSharedServices) => new RealpathDocumentUriPolicy(services) } }
         ]
      });
      const models = scratch.harness.shared.model.ModelService;
      const newUri = scratch.workspace.uri(NEW_FILE);
      const session = models.createSession('form');
      const builtFields = async (): Promise<string[]> => {
         const { root } = await models.validated(newUri);
         const entities = isDomainModel(root) ? root.declarations.filter(isEntity) : [];
         return entities.flatMap(entity => entity.fields.map(field => `${entity.name}.${field.name}`));
      };

      await session.create(newUri, CLEAN);
      expect(await builtFields()).toEqual(['Solo.a']);
      // The lookup every LSP request handler makes for its document.
      const registered = await scratch.harness.shared.workspace.LangiumDocuments.getOrCreateDocument(URI.parse(newUri));
      expect(registered.textDocument.getText()).toBe(CLEAN);

      await session.save({ uri: newUri, model: EDITED, baseVersion: 'any' });
      expect(readFileSync(scratch.workspace.resolve(NEW_FILE), 'utf8')).toBe(EDITED);
      expect(await builtFields()).toEqual(['Solo.a', 'Solo.b']);
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
   it('closes the open of a deleted file, so a later write fails as not open and its options are gone', async () => {
      const { harness, uri, path } = await boot();
      const session = harness.shared.model.ModelService.createSession('form');
      await session.open(uri, { mode: 'compact' });

      rmSync(path(FILE));
      await harness.shared.workspace.DocumentBuilder.update([], [URI.parse(uri)]);

      expect(harness.shared.workspace.TextDocuments.isOpenInClient(uri, session.clientId)).toBe(false);
      expect(session.openOptions(uri)).toBeUndefined();
      await expect(session.update({ uri, model: EDITED, baseVersion: 'any' })).rejects.toBeInstanceOf(DocumentNotOpenError);
   });

   it('names the unknown client on the deletion event of a file deleted outside any session', async () => {
      const { harness, uri, path } = await boot();
      const deletedBy: string[] = [];
      harness.shared.model.ModelService.onModelDeleted(event => deletedBy.push(event.sourceClientId), { uri });

      rmSync(path(FILE));
      await harness.shared.workspace.DocumentBuilder.update([], [URI.parse(uri)]);

      expect(deletedBy).toEqual([UNKNOWN_CLIENT_ID]);
   });
});

describe('ClientSession.delete', () => {
   /** Hold every file removal back until the returned release is called. */
   function holdDeletes(harness: OrderFlowHarness): () => void {
      const fileSystem = harness.shared.workspace.FileSystemProvider;
      const deleteFile = fileSystem.deleteFile.bind(fileSystem);
      let release = (): void => undefined;
      const held = new Promise<void>(resolve => (release = resolve));
      fileSystem.deleteFile = async target => {
         await held;
         return deleteFile(target);
      };
      return release;
   }

   it('removes the file and the document, and closes its open', async () => {
      const { harness, uri, path } = await boot();
      const textDocuments = harness.shared.workspace.TextDocuments;
      const session = harness.shared.model.ModelService.createSession('form');
      await session.open(uri);

      await session.delete({ uri, baseVersion: asModelVersion(textDocuments.version(uri)) });

      expect(existsSync(path(FILE))).toBe(false);
      expect(harness.shared.workspace.LangiumDocuments.getDocument(URI.parse(uri))).toBeUndefined();
      expect(textDocuments.isOpenInClient(uri, session.clientId)).toBe(false);
   });

   it("closes every other session's open and names the deleting session on the deletion event", async () => {
      const { harness, uri } = await boot();
      const models = harness.shared.model.ModelService;
      const bystander = models.createSession('bystander');
      await bystander.open(uri);
      const session = models.createSession('form');
      await session.open(uri);
      const deletedBy: string[] = [];
      models.onModelDeleted(event => deletedBy.push(event.sourceClientId), { uri });

      await session.delete({ uri, baseVersion: 'any' });

      expect(harness.shared.workspace.TextDocuments.isOpenInClient(uri, bystander.clientId)).toBe(false);
      await expect(bystander.update({ uri, model: EDITED, baseVersion: 'any' })).rejects.toBeInstanceOf(DocumentNotOpenError);
      expect(deletedBy).toEqual([session.clientId]);
   });

   it("leaves the editor's open of the document alone", async () => {
      const { harness, uri, path } = await boot();
      const textDocuments = harness.shared.workspace.TextDocuments;
      textDocuments.notifyDidOpenTextDocument({ textDocument: { uri, languageId: 'domain', version: 1, text: CLEAN } });
      const session = harness.shared.model.ModelService.createSession('form');
      await session.open(uri);

      await session.delete({ uri, baseVersion: 'any' });

      expect(existsSync(path(FILE))).toBe(false);
      expect(textDocuments.isOpenInClient(uri, LANGUAGE_CLIENT_ID)).toBe(true);
      expect(textDocuments.isOpenInClient(uri, session.clientId)).toBe(false);
   });

   it('refuses a stale base version and deletes nothing', async () => {
      const { harness, uri, path } = await boot();
      const textDocuments = harness.shared.workspace.TextDocuments;
      const session = harness.shared.model.ModelService.createSession('form');
      await session.open(uri);
      const seen = asModelVersion(textDocuments.version(uri));
      await session.update({ uri, model: EDITED, baseVersion: 'any' });

      const refusal = await session.delete({ uri, baseVersion: seen }).then(
         () => undefined,
         (error: unknown) => error
      );

      expect(isConflictError(refusal)).toBe(true);
      expect(existsSync(path(FILE))).toBe(true);
      expect(textDocuments.isOpenInClient(uri, session.clientId)).toBe(true);
      expect(textDocuments.get(uri)?.getText()).toBe(EDITED);
   });

   it('refuses a document the session does not have open and deletes nothing', async () => {
      const { harness, uri, path } = await boot();
      const models = harness.shared.model.ModelService;
      await models.createSession('bystander').open(uri);
      const session = models.createSession('form');

      await expect(session.delete({ uri, baseVersion: 'any' })).rejects.toBeInstanceOf(DocumentNotOpenError);
      expect(existsSync(path(FILE))).toBe(true);
   });

   it('deletes a created document that was never saved', async () => {
      const { harness, newUri, path } = await boot();
      const session = harness.shared.model.ModelService.createSession('form');
      await session.create(newUri, CLEAN);

      await session.delete({ uri: newUri, baseVersion: 'any' });

      expect(existsSync(path(NEW_FILE))).toBe(false);
      expect(harness.shared.workspace.LangiumDocuments.getDocument(URI.parse(newUri))).toBeUndefined();
      expect(harness.shared.workspace.TextDocuments.isOpen(newUri)).toBe(false);
   });

   it('removes the document of a file that is already gone', async () => {
      const { harness, uri, path } = await boot();
      const session = harness.shared.model.ModelService.createSession('form');
      await session.open(uri);
      rmSync(path(FILE));

      await session.delete({ uri, baseVersion: 'any' });

      expect(harness.shared.workspace.LangiumDocuments.getDocument(URI.parse(uri))).toBeUndefined();
      expect(harness.shared.workspace.TextDocuments.isOpenInClient(uri, session.clientId)).toBe(false);
   });

   it('rejects and changes nothing when the file cannot be removed', async () => {
      const { harness, uri, path } = await boot();
      const models = harness.shared.model.ModelService;
      const textDocuments = harness.shared.workspace.TextDocuments;
      const bystander = models.createSession('bystander');
      await bystander.open(uri);
      const session = models.createSession('form');
      await session.open(uri);
      const deleted: string[] = [];
      models.onModelDeleted(event => deleted.push(event.uri), { uri });
      harness.shared.workspace.FileSystemProvider.deleteFile = () => Promise.reject(new Error('disk refused'));

      await expect(session.delete({ uri, baseVersion: 'any' })).rejects.toThrow('disk refused');

      expect(existsSync(path(FILE))).toBe(true);
      expect(deleted).toEqual([]);
      expect(textDocuments.isOpenInClient(uri, session.clientId)).toBe(true);
      expect(textDocuments.isOpenInClient(uri, bystander.clientId)).toBe(true);
      await bystander.update({ uri, model: EDITED, baseVersion: 'any' });
      expect(textDocuments.get(uri)?.getText()).toBe(EDITED);
   });

   it("refuses another session's persist made while the file is being removed, so the file stays gone", async () => {
      const { harness, uri, path } = await boot();
      const models = harness.shared.model.ModelService;
      const bystander = models.createSession('bystander');
      await bystander.open(uri);
      const session = models.createSession('form');
      await session.open(uri);
      const release = holdDeletes(harness);

      const deleting = session.delete({ uri, baseVersion: 'any' });
      const persisting = bystander.persist({ uri, baseVersion: 'any' });
      release();

      await expect(persisting).rejects.toBeInstanceOf(DocumentNotOpenError);
      await deleting;
      expect(existsSync(path(FILE))).toBe(false);
   });

   it("refuses another session's update made while the file is being removed, so the document goes", async () => {
      const { harness, uri } = await boot();
      const models = harness.shared.model.ModelService;
      const bystander = models.createSession('bystander');
      await bystander.open(uri);
      const session = models.createSession('form');
      await session.open(uri);
      const release = holdDeletes(harness);

      const deleting = session.delete({ uri, baseVersion: 'any' });
      const updating = bystander.update({ uri, model: EDITED, baseVersion: 'any' });
      release();

      await expect(updating).rejects.toBeInstanceOf(DocumentNotOpenError);
      await deleting;
      expect(harness.shared.workspace.LangiumDocuments.getDocument(URI.parse(uri))).toBeUndefined();
      expect(harness.shared.workspace.TextDocuments.isOpenInClient(uri, bystander.clientId)).toBe(false);
   });

   it('resolves once the document is removed, even when the build after the removal fails, and logs that failure', async () => {
      const { tracer, lines } = makeCapturingTracer();
      scratch = await makeScratchWorkspaceHarness(workspace => workspace.write(FILE, CLEAN), {
         extraSharedModules: [{ Tracer: () => tracer }]
      });
      const harness = scratch.harness;
      const uri = scratch.workspace.uri(FILE);
      const builder = harness.shared.workspace.DocumentBuilder;
      const scheduleUpdate = builder.scheduleUpdate.bind(builder);
      builder.scheduleUpdate = async (changed, deleted, reason) => {
         await scheduleUpdate(changed, deleted, reason);
         throw new Error('build failed');
      };
      const session = harness.shared.model.ModelService.createSession('form');
      await session.open(uri);

      await session.delete({ uri, baseVersion: 'any' });

      expect(existsSync(scratch.workspace.resolve(FILE))).toBe(false);
      expect(harness.shared.workspace.LangiumDocuments.getDocument(URI.parse(uri))).toBeUndefined();
      expect(lines.filter(line => line.level === 'error' && line.message.includes('build failed'))).toHaveLength(1);
   });

   it.each([false, true])(
      'refuses a delete from inside a write-lock holder and removes nothing, allowReentrantBuilds %s',
      async allowReentrantBuilds => {
         scratch = await makeScratchWorkspaceHarness(workspace => workspace.write(FILE, CLEAN), {
            extraSharedModules: [
               {
                  model: {
                     ModelService: (services: OrderFlowSharedServices) => new DefaultModelService(services, { allowReentrantBuilds })
                  }
               }
            ]
         });
         const { harness, workspace } = scratch;
         const uri = workspace.uri(FILE);
         const session = harness.shared.model.ModelService.createSession('form');
         await session.open(uri);

         let refusal: unknown;
         await harness.shared.workspace.WorkspaceLock.write(async () => {
            refusal = await session.delete({ uri, baseVersion: 'any' }).then(
               () => undefined,
               (error: unknown) => error
            );
         });

         expect({
            refused: refusal instanceof ReentrantWriteLockError,
            fileExists: existsSync(workspace.resolve(FILE)),
            deleting: harness.shared.workspace.AstDocumentManager.isDeleting(uri),
            open: harness.shared.workspace.TextDocuments.isOpenInClient(uri, session.clientId)
         }).toEqual({ refused: true, fileExists: true, deleting: false, open: true });
      }
   );

   it("closes the deleting session's open when a change merged over the deletion keeps the document", async () => {
      const { harness, uri, path } = await boot();
      const models = harness.shared.model.ModelService;
      const textDocuments = harness.shared.workspace.TextDocuments;
      const bystander = models.createSession('bystander');
      await bystander.open(uri);
      const session = models.createSession('form');
      await session.open(uri);
      // A change requested before the deletion build starts, as a file
      // watcher's late report of a save is, merges over the deletion.
      const builder = harness.shared.workspace.DocumentBuilder;
      const scheduleUpdate = builder.scheduleUpdate.bind(builder);
      builder.scheduleUpdate = (changed, deleted, reason) => {
         const scheduled = scheduleUpdate(changed, deleted, reason);
         if (deleted.length > 0) {
            void scheduleUpdate([URI.parse(uri)], []);
         }
         return scheduled;
      };

      await session.delete({ uri, baseVersion: 'any' });

      expect({
         fileExists: existsSync(path(FILE)),
         documentExists: harness.shared.workspace.LangiumDocuments.getDocument(URI.parse(uri)) !== undefined,
         deleterOpen: textDocuments.isOpenInClient(uri, session.clientId),
         bystanderOpen: textDocuments.isOpenInClient(uri, bystander.clientId)
      }).toEqual({ fileExists: false, documentExists: true, deleterOpen: false, bystanderOpen: true });
   });
});

describe("a file watcher's late report of a session's delete", () => {
   /**
    * Report `changes` as a file watcher does, beside a change of `otherUri`,
    * and resolve once the build carrying that change has run its update
    * listeners, which is when a deletion it carries has closed its opens.
    */
   function reportBeside(harness: OrderFlowHarness, otherUri: string, changes: FileEvent[]): Promise<void> {
      const other = URI.parse(otherUri).toString();
      const updated = new Promise<void>(resolve => {
         const listener = harness.shared.workspace.DocumentBuilder.onUpdate(changed => {
            if (changed.some(uri => uri.toString() === other)) {
               listener.dispose();
               resolve();
            }
         });
      });
      harness.shared.lsp.DocumentUpdateHandler.didChangeWatchedFiles({
         changes: [...changes, { uri: otherUri, type: FileChangeType.Changed }]
      });
      return updated;
   }

   it.each(['unsaved', 'saved'] as const)('leaves a document created again at the URI open, %s', async state => {
      const { harness, uri, otherUri, path } = await boot();
      const models = harness.shared.model.ModelService;
      const session = models.createSession('form');
      await session.open(uri);
      await session.delete({ uri, baseVersion: 'any' });
      await session.create(uri, CLEAN);
      if (state === 'saved') {
         await session.persist({ uri, baseVersion: 'any' });
      }
      await models.validated(uri);
      const deletedBy: string[] = [];
      models.onModelDeleted(event => deletedBy.push(event.sourceClientId), { uri });

      await reportBeside(harness, otherUri, [{ uri, type: FileChangeType.Deleted }]);

      expect({
         deletedBy,
         open: harness.shared.workspace.TextDocuments.isOpenInClient(uri, session.clientId),
         fileExists: existsSync(path(FILE))
      }).toEqual({ deletedBy: [], open: true, fileExists: state === 'saved' });
   });

   it('still removes a document whose deletion the watcher reports after a change of its gone file', async () => {
      const { harness, uri, otherUri, path } = await boot();
      const models = harness.shared.model.ModelService;
      const textDocuments = harness.shared.workspace.TextDocuments;
      const session = models.createSession('form');
      await session.open(uri);
      await models.validated(uri);
      rmSync(path(FILE));
      // The change finds no file, so the document loses its disk baseline.
      const turnedDirty = new Promise<void>(resolve => {
         const listener = textDocuments.onDidChangeDirty(() => {
            if (textDocuments.isDirty(uri)) {
               listener.dispose();
               resolve();
            }
         });
      });
      await reportBeside(harness, otherUri, [{ uri, type: FileChangeType.Changed }]);
      await turnedDirty;
      const deletedBy: string[] = [];
      models.onModelDeleted(event => deletedBy.push(event.sourceClientId), { uri });

      await reportBeside(harness, otherUri, [{ uri, type: FileChangeType.Deleted }]);

      expect({ deletedBy, open: textDocuments.isOpenInClient(uri, session.clientId) }).toEqual({
         deletedBy: [UNKNOWN_CLIENT_ID],
         open: false
      });
   });

   it('still removes a document no client holds once its file is deleted outside the server', async () => {
      const { harness, uri, otherUri, path } = await boot();
      const models = harness.shared.model.ModelService;
      await models.validated(uri);
      rmSync(path(FILE));
      const deletedBy: string[] = [];
      models.onModelDeleted(event => deletedBy.push(event.sourceClientId), { uri });

      await reportBeside(harness, otherUri, [{ uri, type: FileChangeType.Deleted }]);

      expect({ deletedBy, documentExists: harness.shared.workspace.LangiumDocuments.getDocument(URI.parse(uri)) !== undefined }).toEqual({
         deletedBy: [UNKNOWN_CLIENT_ID],
         documentExists: false
      });
   });

   it('still removes a document created again at the URI once its saved file is deleted outside the server', async () => {
      const { harness, uri, otherUri, path } = await boot();
      const models = harness.shared.model.ModelService;
      const session = models.createSession('form');
      await session.open(uri);
      await session.delete({ uri, baseVersion: 'any' });
      await session.create(uri, CLEAN);
      await session.persist({ uri, baseVersion: 'any' });
      await models.validated(uri);
      rmSync(path(FILE));
      const deletedBy: string[] = [];
      models.onModelDeleted(event => deletedBy.push(event.sourceClientId), { uri });

      await reportBeside(harness, otherUri, [{ uri, type: FileChangeType.Deleted }]);

      expect({ deletedBy, open: harness.shared.workspace.TextDocuments.isOpenInClient(uri, session.clientId) }).toEqual({
         deletedBy: [UNKNOWN_CLIENT_ID],
         open: false
      });
   });
});

describe('ClientSession.delete and its dependents', () => {
   it('credits the rebuild of the dependents to the deleting session', async () => {
      scratch = await makeScratchWorkspaceHarness();
      const { harness, workspace } = scratch;
      const models = harness.shared.model.ModelService;
      const uri = workspace.uri(WORKSPACE_FILES.ordersDomain);
      const session = models.createSession('form');
      await session.open(uri);
      const causes: string[] = [];
      models.onModelUpdated(event => {
         if (event.reason === 'rebuilt') {
            causes.push(event.causedBy ?? 'no cause');
         }
      });

      await session.delete({ uri, baseVersion: 'any' });

      expect(causes.length).toBeGreaterThan(0);
      expect(new Set(causes)).toEqual(new Set([session.clientId]));
   });
});

describe('ClientSession.delete at each of its awaits', () => {
   /** Hold the file removal back until the returned release is called; `reached` settles once it is held. */
   function holdRemoval(harness: OrderFlowHarness): { reached: Promise<void>; release: () => void } {
      const fileSystem = harness.shared.workspace.FileSystemProvider;
      const deleteFile = fileSystem.deleteFile.bind(fileSystem);
      let release = (): void => undefined;
      let reach = (): void => undefined;
      const reached = new Promise<void>(resolve => (reach = resolve));
      const held = new Promise<void>(resolve => (release = resolve));
      fileSystem.deleteFile = async target => {
         reach();
         await held;
         return deleteFile(target);
      };
      return { reached, release };
   }

   it('refuses a second delete of the URI while one is under way, and keeps it marked until that one settles', async () => {
      const { harness, uri } = await boot();
      const manager = harness.shared.workspace.AstDocumentManager;
      const session = harness.shared.model.ModelService.createSession('form');
      await session.open(uri);
      const { reached, release } = holdRemoval(harness);

      const first = manager.delete(uri, session.clientId);
      await reached;
      await expect(manager.delete(uri, 'other')).rejects.toThrow(`Cannot delete ${uri}: a delete of it is under way`);
      expect(manager.isDeleting(uri)).toBe(true);
      release();
      await first;

      expect(manager.isDeleting(uri)).toBe(false);
   });

   it('rejects and changes nothing when the build of a document no build has reached yet fails', async () => {
      const { harness, newUri } = await boot();
      const builder = harness.shared.workspace.DocumentBuilder;
      const session = harness.shared.model.ModelService.createSession('form');
      await session.create(newUri, CLEAN);
      const scheduleUpdate = builder.scheduleUpdate.bind(builder);
      builder.scheduleUpdate = (changed, deleted, reason) =>
         deleted.length === 0 ? Promise.reject(new Error('build refused')) : scheduleUpdate(changed, deleted, reason);

      await expect(session.delete({ uri: newUri, baseVersion: 'any' })).rejects.toThrow('build refused');

      builder.scheduleUpdate = scheduleUpdate;
      expect(harness.shared.workspace.TextDocuments.isOpenInClient(newUri, session.clientId)).toBe(true);
      await session.update({ uri: newUri, model: EDITED, baseVersion: 'any' });
   });

   it("refuses another session's write between the removal of the file and the build that removes the document", async () => {
      const { harness, uri } = await boot();
      const models = harness.shared.model.ModelService;
      const builder = harness.shared.workspace.DocumentBuilder;
      const bystander = models.createSession('bystander');
      await bystander.open(uri);
      const session = models.createSession('form');
      await session.open(uri);
      const scheduleUpdate = builder.scheduleUpdate.bind(builder);
      let release = (): void => undefined;
      const held = new Promise<void>(resolve => (release = resolve));
      let reach = (): void => undefined;
      const reached = new Promise<void>(resolve => (reach = resolve));
      builder.scheduleUpdate = async (changed, deleted, reason) => {
         if (deleted.length > 0) {
            reach();
            await held;
         }
         return scheduleUpdate(changed, deleted, reason);
      };

      const deleting = session.delete({ uri, baseVersion: 'any' });
      await reached;
      const writes = [bystander.update({ uri, model: EDITED, baseVersion: 'any' }), bystander.persist({ uri, baseVersion: 'any' })];
      release();

      for (const write of writes) {
         await expect(write).rejects.toBeInstanceOf(DocumentNotOpenError);
      }
      await deleting;
      expect(harness.shared.workspace.LangiumDocuments.getDocument(URI.parse(uri))).toBeUndefined();
   });

   it('completes a delete whose session closes the document while the file is being removed', async () => {
      const { harness, uri, path } = await boot();
      const session = harness.shared.model.ModelService.createSession('form');
      await session.open(uri);
      const { reached, release } = holdRemoval(harness);

      const deleting = session.delete({ uri, baseVersion: 'any' });
      await reached;
      await session.close(uri);
      release();
      await deleting;

      expect(existsSync(path(FILE))).toBe(false);
      expect(harness.shared.workspace.LangiumDocuments.getDocument(URI.parse(uri))).toBeUndefined();
   });

   it('completes a delete whose session ends while the file is being removed, and leaves the URI free to create', async () => {
      const { harness, uri, path } = await boot();
      const models = harness.shared.model.ModelService;
      const session = models.createSession('form');
      await session.open(uri);
      const { reached, release } = holdRemoval(harness);

      const deleting = session.delete({ uri, baseVersion: 'any' });
      await reached;
      session.dispose();
      release();
      await deleting;

      expect(existsSync(path(FILE))).toBe(false);
      await models.createSession('other').create(uri, EDITED);
      expect(harness.shared.workspace.TextDocuments.get(uri)?.getText()).toBe(EDITED);
   });

   it('closes an open another session made while the file was being removed', async () => {
      const { harness, uri } = await boot();
      const models = harness.shared.model.ModelService;
      const session = models.createSession('form');
      await session.open(uri);
      const late = models.createSession('late');
      const { reached, release } = holdRemoval(harness);

      const deleting = session.delete({ uri, baseVersion: 'any' });
      await reached;
      await late.open(uri);
      release();
      await deleting;

      expect(harness.shared.workspace.TextDocuments.isOpenInClient(uri, late.clientId)).toBe(false);
   });

   it('reports one deletion, naming the deleting session, when a file watcher reports the file gone while it is being removed', async () => {
      const { harness, uri, path } = await boot();
      const models = harness.shared.model.ModelService;
      const session = models.createSession('form');
      await session.open(uri);
      const deletedBy: string[] = [];
      models.onModelDeleted(event => deletedBy.push(event.sourceClientId), { uri });
      const { reached, release } = holdRemoval(harness);

      const deleting = session.delete({ uri, baseVersion: 'any' });
      await reached;
      rmSync(path(FILE));
      await harness.shared.workspace.DocumentBuilder.update([], [URI.parse(uri)]);
      release();
      await deleting;

      expect(deletedBy).toEqual([session.clientId]);
   });
});

describe('a session keeps no options of an open that ended', () => {
   class InspectingSession extends DefaultClientSession<AstNode> {
      heldOptions(): string[] {
         return [...this.openOptionsByUri.keys()];
      }
   }

   async function bootInspecting(): Promise<{ session: InspectingSession; uri: string; harness: OrderFlowHarness; filePath: string }> {
      scratch = await makeScratchWorkspaceHarness(workspace => workspace.write(FILE, CLEAN), {
         extraSharedModules: [
            {
               model: {
                  ClientSessionFactory: (services: ServerSharedServices) => ({
                     create: (clientId: string, label: string) => new InspectingSession(services, { clientId, label })
                  })
               }
            }
         ]
      });
      const harness = scratch.harness;
      const uri = scratch.workspace.uri(FILE);
      const session = harness.shared.model.ModelService.createSession('form') as InspectingSession;
      await session.open(uri, { mode: 'compact' });
      return { session, uri, harness, filePath: scratch.workspace.resolve(FILE) };
   }

   it('drops the options when the session closes the document', async () => {
      const { session, uri } = await bootInspecting();

      await session.close(uri);

      expect(session.heldOptions()).toEqual([]);
   });

   it('drops the options when the store ends the open for a deleted file', async () => {
      const { session, uri, harness, filePath } = await bootInspecting();

      rmSync(filePath);
      await harness.shared.workspace.DocumentBuilder.update([], [URI.parse(uri)]);

      expect(harness.shared.workspace.TextDocuments.isOpenInClient(uri, session.clientId)).toBe(false);
      expect(session.heldOptions()).toEqual([]);
   });
});

describe('ClientSessionFactory', () => {
   class LabelledSession extends DefaultClientSession<AstNode> {
      describe(): string {
         return `${this.label} (${this.clientId})`;
      }
   }

   it('builds the handle of createSession while registration stays in createSession', async () => {
      scratch = await makeScratchWorkspaceHarness(undefined, {
         extraSharedModules: [
            {
               model: {
                  ClientSessionFactory: (services: ServerSharedServices) => ({
                     create: (clientId: string, label: string) => new LabelledSession(services, { clientId, label })
                  })
               }
            }
         ]
      });
      const models = scratch.harness.shared.model.ModelService;

      const session: ClientSession<AstNode> = models.createSession('form', 'form-1');

      expect(session).toBeInstanceOf(LabelledSession);
      expect((session as LabelledSession).describe()).toBe('form (form-1)');
      expect(() => models.createSession('form', 'form-1')).toThrow(DuplicateClientIdError);
   });

   it('writes a save through the session subclass’s own update', async () => {
      class CountingSession extends DefaultClientSession<AstNode> {
         updates = 0;
         protected override updateDocument(
            args: ClientSessionWriteArgs<TransferElement>,
            cancelToken?: CancellationToken
         ): Promise<WrittenAstDocument<AstNode>> {
            this.updates++;
            return super.updateDocument(args, cancelToken);
         }
      }
      scratch = await makeScratchWorkspaceHarness(workspace => workspace.write(FILE, CLEAN), {
         extraSharedModules: [
            {
               model: {
                  ClientSessionFactory: (services: ServerSharedServices) => ({
                     create: (clientId: string, label: string) => new CountingSession(services, { clientId, label })
                  })
               }
            }
         ]
      });
      const uri = scratch.workspace.uri(FILE);
      const session = scratch.harness.shared.model.ModelService.createSession('form') as CountingSession;
      await session.open(uri);

      await session.save({ uri, model: EDITED, baseVersion: 'any' });

      expect(session.updates).toBe(1);
      expect(readFileSync(scratch.workspace.resolve(FILE), 'utf8')).toBe(EDITED);
   });

   it('writes a save and a persist to disk through the session subclass’s own persist', async () => {
      class CountingSession extends DefaultClientSession<AstNode> {
         persists = 0;
         protected override persistDocument(args: ClientSessionPersistArgs): Promise<TextVersion> {
            this.persists++;
            return super.persistDocument(args);
         }
      }
      scratch = await makeScratchWorkspaceHarness(workspace => workspace.write(FILE, CLEAN), {
         extraSharedModules: [
            {
               model: {
                  ClientSessionFactory: (services: ServerSharedServices) => ({
                     create: (clientId: string, label: string) => new CountingSession(services, { clientId, label })
                  })
               }
            }
         ]
      });
      const uri = scratch.workspace.uri(FILE);
      const session = scratch.harness.shared.model.ModelService.createSession('form') as CountingSession;
      await session.open(uri);

      await session.save({ uri, model: EDITED, baseVersion: 'any' });
      await session.persist({ uri, baseVersion: 'any' });

      expect(session.persists).toBe(2);
      expect(readFileSync(scratch.workspace.resolve(FILE), 'utf8')).toBe(EDITED);
   });

   it('frees the id again when building the handle throws', async () => {
      const failing: ClientSessionFactory = {
         create: () => {
            throw new Error('no handle');
         }
      };
      scratch = await makeScratchWorkspaceHarness(undefined, {
         extraSharedModules: [{ model: { ClientSessionFactory: () => failing } }]
      });
      const models = scratch.harness.shared.model.ModelService;

      expect(() => models.createSession('form', 'form-1')).toThrow('no handle');
      expect(() => scratch?.harness.shared.workspace.TextDocuments.registerSession('form-1')).not.toThrow();
   });
});
