/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * Client sessions over the data head's wire, against the real stack: the
 * connection registers a session, requests carrying its id act as it, and the
 * connection's end closes everything its sessions have open.
 *
 * The real text store is needed because what is under test is which client an
 * open belongs to, which the framework's stub store does not keep per client.
 */

import {
   DATA_SESSION_UNSAVED_LOST,
   DataConnectionWithEvents,
   DataSession,
   isDocumentNotOpenError,
   isDuplicateClientIdError,
   isSessionClosedError,
   type ResolvedMessage,
   type RpcProxy,
   type TransferElement,
   TransferDocument
} from '@hydranium/protocol';
import { makeFakeDataPort, waitFor } from '@hydranium/protocol/testing';
import { type DuplexConnectionPair, makeDuplexConnectionPair } from '@hydranium/protocol/testing/node';
import { DataServer, type DataServerUriWatchRecord } from '@hydranium/data-server';
import { makeDataServerHarness, type DataServerHarness } from '@hydranium/data-server/testing';
import {
   type AstDocument,
   type ClientSessionUpdateAllArgs,
   type ClientSessionWriteArgs,
   DefaultClientSession,
   HydraniumTextDocuments,
   initializeWorkspaceProgrammatically,
   type ServerSharedServices
} from '@hydranium/core';
import type { AstNode } from '@hydranium/langium';
import type {
   DataServerProtocol,
   TransferUpdateDocumentArgs,
   TransferDocumentDirtyChangedEvent,
   TransferUpdateDocumentsArgs,
   WatchModelDocumentArgs
} from '@hydranium/protocol/data';
import { Emitter, type Event } from 'vscode-jsonrpc';
import type { CancellationToken } from 'vscode-languageserver';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import type { DomainModel } from '../src/language-server/generated-hydranium/transfer-model.js';
import { makeScratchWorkspaceHarness, makeServices, type OrderFlowHarness, type ScratchOrderFlowHarness } from './order-flow-harness.js';

const FILE = 'wire-session.domain';
const OTHER_FILE = 'wire-session-other.domain';
const NEW_FILE = 'wire-session-new.domain';
const CLEAN = `entity Solo {
   a : string
}
`;
const EDITED = `entity Solo {
   a : string
   b : string
}
`;
const THEIRS = `entity Solo {
   a : string
   c : string
}
`;
const SESSION = 'form#wire-1';
const GRACE_MS = 300;

type Harness = DataServerHarness<DataServer<DomainModel>, DomainModel>;

/**
 * Records the writes it is sent, can lose its connection as a dropped
 * transport ends it, runs a hook after each watch, which a restore sends
 * between its re-open and any write it sends again, and can hold the answer
 * to an update it has applied.
 */
class RestoreProbeServer extends DataServer<DomainModel> {
   readonly writes: string[] = [];
   afterWatch?: () => Promise<void>;
   /** Set, an update is applied at once and answers once this settles. */
   answerGate?: Promise<void>;

   lose(): void {
      this.dispose('lost');
   }

   override async updateModelDocument(args: TransferUpdateDocumentArgs<DomainModel>): Promise<TransferDocument<DomainModel>> {
      this.writes.push(`update ${args.uri}`);
      const held = this.answerGate;
      if (!held) {
         return super.updateModelDocument(args);
      }
      // Applied at once and answered once released, stamped as it is sent,
      // as a write whose validation outlasts the calls after it.
      const astDocument = await this.requireSession(args.clientId).update(this.toSessionWrite(args));
      await held;
      return this.encodeDocument(astDocument);
   }

   override async updateModelDocuments(args: TransferUpdateDocumentsArgs<DomainModel>): Promise<TransferDocument<DomainModel>[]> {
      this.writes.push(`updates ${args.updates.map(update => update.uri).join(' ')}`);
      return super.updateModelDocuments(args);
   }

   override async watchModelDocument(args: WatchModelDocumentArgs): Promise<void> {
      await super.watchModelDocument(args);
      await this.afterWatch?.();
   }
}

type ProbeHarness = DataServerHarness<RestoreProbeServer, DomainModel>;

/** Fails the snapshot an open answers with once told to, leaving the open itself intact. */
class SnapshotFailingServer extends DataServer<DomainModel> {
   failSnapshots = false;

   override async getModelDocument(args: { uri: string }): Promise<TransferDocument<DomainModel>> {
      if (this.failSnapshots) {
         throw new Error('snapshot refused');
      }
      return super.getModelDocument(args);
   }
}

let scratch: ScratchOrderFlowHarness | undefined;
const heads: Harness[] = [];

afterEach(() => {
   heads.splice(0).forEach(head => head.dispose());
   scratch?.workspace.dispose();
   scratch = undefined;
});

interface Booted {
   readonly services: OrderFlowHarness;
   readonly uri: string;
   readonly otherUri: string;
   readonly newUri: string;
   readonly path: (file: string) => string;
   /** A fresh data-server connection on the booted services. */
   readonly connect: () => ProbeHarness;
}

/** Boot a scratch workspace, with the text store's `releaseGraceMs` when given. */
async function boot(releaseGraceMs?: number): Promise<Booted> {
   scratch = await makeScratchWorkspaceHarness(
      workspace => {
         workspace.write(FILE, CLEAN);
         workspace.write(OTHER_FILE, CLEAN);
      },
      releaseGraceMs === undefined
         ? {}
         : {
              extraSharedModules: [
                 { workspace: { TextDocuments: (shared: ServerSharedServices) => new HydraniumTextDocuments(shared, { releaseGraceMs }) } }
              ]
           }
   );
   const { harness: services, workspace } = scratch;
   return {
      services,
      uri: workspace.uri(FILE),
      otherUri: workspace.uri(OTHER_FILE),
      newUri: workspace.uri(NEW_FILE),
      path: file => workspace.resolve(file),
      connect: () => {
         const head = makeDataServerHarness<RestoreProbeServer, DomainModel>({
            server: channel => new RestoreProbeServer(channel, services.shared)
         });
         heads.push(head);
         return head;
      }
   };
}

/** Settle a promise into its rejection, or `undefined` when it resolved. */
async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
   return promise.then(
      () => undefined,
      (error: unknown) => error
   );
}

describe('data head sessions', () => {
   it('refuses a write under an id that is not a registered session, and opens nothing', async () => {
      const { services, uri, connect } = await boot();
      const { proxy } = connect();

      const failure = await rejectionOf(proxy.updateModelDocument({ uri, clientId: 'plain-client', model: EDITED, baseVersion: 'any' }));

      expect(isSessionClosedError(failure)).toBe(true);
      expect(services.shared.workspace.TextDocuments.isOpenInClient(uri, 'plain-client')).toBe(false);
      expect(services.shared.workspace.TextDocuments.isOpen(uri)).toBe(false);
   });

   it('refuses an id live on another connection, or in the server process', async () => {
      const { services, connect } = await boot();
      await connect().proxy.createSession({ clientId: SESSION });
      services.shared.model.ModelService.createSession('diagram', 'diagram-1');
      const { proxy } = connect();

      expect(isDuplicateClientIdError(await rejectionOf(proxy.createSession({ clientId: SESSION })))).toBe(true);
      expect(isDuplicateClientIdError(await rejectionOf(proxy.createSession({ clientId: 'diagram-1' })))).toBe(true);
   });

   it('lets a registration with the session’s resume token take its id over from a connection not yet closed', async () => {
      // The client whose connection dropped before the server noticed: the old
      // session is still live, and only the token it registered with may end it.
      const { services, uri, connect } = await boot();
      const textDocuments = services.shared.workspace.TextDocuments;
      const stale = connect();
      await stale.proxy.createSession({ clientId: SESSION, resumeToken: 'secret' });
      await stale.proxy.openModelDocument({ uri, clientId: SESSION });
      await stale.proxy.watchModelDocument({ uri, clientId: SESSION });
      const { proxy } = connect();

      expect(isDuplicateClientIdError(await rejectionOf(proxy.createSession({ clientId: SESSION })))).toBe(true);
      expect(isDuplicateClientIdError(await rejectionOf(proxy.createSession({ clientId: SESSION, resumeToken: 'guess' })))).toBe(true);
      await proxy.createSession({ clientId: SESSION, resumeToken: 'secret' });

      expect(textDocuments.isOpenInClient(uri, SESSION)).toBe(false);
      const staleWatches = stale.server as unknown as { uriWatchRecords: Map<string, DataServerUriWatchRecord> };
      expect([...staleWatches.uriWatchRecords.values()].some(record => record.watchers.has(SESSION))).toBe(false);
      const late = await rejectionOf(stale.proxy.updateModelDocument({ uri, clientId: SESSION, model: EDITED, baseVersion: 'any' }));
      expect(isSessionClosedError(late)).toBe(true);
      await proxy.openModelDocument({ uri, clientId: SESSION });
      await proxy.updateModelDocument({ uri, clientId: SESSION, model: EDITED, baseVersion: 'any' });
   });

   it('closeSession closes everything the session has open, drops its watches and frees the id', async () => {
      const { services, uri, otherUri, connect } = await boot();
      const textDocuments = services.shared.workspace.TextDocuments;
      const head = connect();
      await head.proxy.createSession({ clientId: SESSION });
      await head.proxy.openModelDocument({ uri, clientId: SESSION, options: { mode: 'compact' } });
      await head.proxy.openModelDocument({ uri: otherUri, clientId: SESSION });
      await head.proxy.watchModelDocument({ uri, clientId: SESSION });
      expect(services.shared.model.ModelService.getSession(SESSION)?.openOptions(uri)).toEqual({ mode: 'compact' });

      await head.proxy.closeSession({ clientId: SESSION });

      expect(textDocuments.isOpenInClient(uri, SESSION)).toBe(false);
      expect(textDocuments.isOpenInClient(otherUri, SESSION)).toBe(false);
      const internal = head.server as unknown as { uriWatchRecords: Map<string, DataServerUriWatchRecord> };
      expect([...internal.uriWatchRecords.values()].some(record => record.watchers.has(SESSION))).toBe(false);
      expect(services.shared.model.ModelService.getSession(SESSION)).toBeUndefined();
      await head.proxy.createSession({ clientId: SESSION });
   });

   it('ends every session of a connection when it closes, and no other connection’s', async () => {
      const { services, uri, connect } = await boot();
      const textDocuments = services.shared.workspace.TextDocuments;
      const closing = connect();
      const staying = connect();
      await closing.proxy.createSession({ clientId: SESSION });
      await closing.proxy.openModelDocument({ uri, clientId: SESSION });
      await staying.proxy.createSession({ clientId: 'tree#wire-2' });
      await staying.proxy.openModelDocument({ uri, clientId: 'tree#wire-2' });

      closing.server.dispose();

      expect(textDocuments.isOpenInClient(uri, SESSION)).toBe(false);
      expect(services.shared.model.ModelService.getSession(SESSION)).toBeUndefined();
      expect(textDocuments.isOpenInClient(uri, 'tree#wire-2')).toBe(true);
   });

   it('fails a write and a close under a session id after closeSession, and opens nothing', async () => {
      const { services, uri, connect } = await boot();
      const { proxy } = connect();
      await proxy.createSession({ clientId: SESSION });
      await proxy.closeSession({ clientId: SESSION });

      const late = await rejectionOf(proxy.updateModelDocument({ uri, clientId: SESSION, model: EDITED, baseVersion: 'any' }));
      const lateClose = await rejectionOf(proxy.closeModelDocument({ uri, clientId: SESSION }));

      expect(isSessionClosedError(late)).toBe(true);
      expect(isSessionClosedError(lateClose)).toBe(true);
      expect(services.shared.workspace.TextDocuments.isOpen(uri)).toBe(false);
   });

   it('forgets a resume token once its session ended some other way', async () => {
      const { services, connect } = await boot();
      const head = connect();
      await head.proxy.createSession({ clientId: SESSION, resumeToken: 'secret' });
      services.shared.model.ModelService.getSession(SESSION)?.dispose();
      await head.proxy.createSession({ clientId: SESSION });

      // The old token names a session that has ended, so it takes over nothing.
      const takeover = await rejectionOf(connect().proxy.createSession({ clientId: SESSION, resumeToken: 'secret' }));

      expect(isDuplicateClientIdError(takeover)).toBe(true);
      expect(services.shared.model.ModelService.getSession(SESSION)).toBeDefined();
   });

   it('refuses a session request that runs after its connection closed, and leaves nothing open or registered', async () => {
      // Called on the server directly: a request that reached the server before
      // the disconnect is exactly a handler invocation that outlives teardown.
      const { services, uri, connect } = await boot();
      const textDocuments = services.shared.workspace.TextDocuments;
      const head = connect();
      await head.proxy.createSession({ clientId: SESSION });
      head.server.dispose();

      const open = await rejectionOf(head.server.openModelDocument({ uri, clientId: SESSION }));
      const register = await rejectionOf(head.server.createSession({ clientId: 'late#wire-3' }));

      expect(isSessionClosedError(open)).toBe(true);
      expect(isSessionClosedError(register)).toBe(true);
      expect(textDocuments.isOpen(uri)).toBe(false);
      expect(services.shared.model.ModelService.getSession('late#wire-3')).toBeUndefined();
   });

   it('fails a session write in flight when its connection closes, and leaves nothing held', async () => {
      const { services, uri, connect } = await boot();
      const textDocuments = services.shared.workspace.TextDocuments;
      const head = connect();
      await head.proxy.createSession({ clientId: SESSION });
      const opened = await head.proxy.openModelDocument({ uri, clientId: SESSION });

      const write = rejectionOf(
         head.server.updateModelDocument({ uri, clientId: SESSION, model: EDITED, baseVersion: opened.model!.version })
      );
      head.server.dispose();

      expect(isDocumentNotOpenError(await write)).toBe(true);
      expect(textDocuments.isOpenInClient(uri, SESSION)).toBe(false);
      expect(textDocuments.get(uri)?.getText() ?? CLEAN).toBe(CLEAN);
   });

   it('undoes a session open whose snapshot fails, and keeps an open the session already had', async () => {
      const { services, uri, otherUri } = await boot();
      const textDocuments = services.shared.workspace.TextDocuments;
      const head = makeDataServerHarness<SnapshotFailingServer, DomainModel>({
         server: channel => new SnapshotFailingServer(channel, services.shared)
      });
      heads.push(head);
      await head.proxy.createSession({ clientId: SESSION });
      await head.proxy.openModelDocument({ uri: otherUri, clientId: SESSION });
      head.server.failSnapshots = true;

      await expect(head.proxy.openModelDocument({ uri, clientId: SESSION })).rejects.toThrow(/snapshot refused/);
      await expect(head.proxy.openModelDocument({ uri: otherUri, clientId: SESSION })).rejects.toThrow(/snapshot refused/);

      expect(textDocuments.isOpenInClient(uri, SESSION)).toBe(false);
      expect(textDocuments.isOpenInClient(otherUri, SESSION)).toBe(true);
   });

   it('createModelDocument creates a document open for the session, on disk only once saved', async () => {
      const { services, newUri, path, connect } = await boot();
      const { proxy } = connect();
      await proxy.createSession({ clientId: SESSION });

      const created = await proxy.createModelDocument({ uri: newUri, clientId: SESSION, text: CLEAN });
      expect(TransferDocument.assertLoaded(created).model.root.$type).toBe('DomainModel');
      expect(services.shared.workspace.TextDocuments.isOpenInClient(newUri, SESSION)).toBe(true);
      expect(() => readFileSync(path(NEW_FILE), 'utf8')).toThrow();

      await proxy.saveModelDocument({ uri: newUri, clientId: SESSION, model: EDITED, baseVersion: created.model!.version });
      expect(readFileSync(path(NEW_FILE), 'utf8')).toBe(EDITED);
   });

   it('hands a session only the fields of a write, whatever else the wire request carries', async () => {
      const writes: object[] = [];
      class RecordingSession extends DefaultClientSession<AstNode> {
         protected override updateDocument(
            args: ClientSessionWriteArgs<TransferElement>,
            cancelToken?: CancellationToken
         ): Promise<AstDocument<AstNode>> {
            writes.push({ ...args });
            return super.updateDocument(args, cancelToken);
         }

         protected override updateDocuments(
            args: ClientSessionUpdateAllArgs<TransferElement>,
            cancelToken?: CancellationToken
         ): Promise<AstDocument<AstNode>[]> {
            writes.push(...args.updates.map(update => ({ ...update })));
            return super.updateDocuments(args, cancelToken);
         }
      }
      scratch = await makeScratchWorkspaceHarness(workspace => workspace.write(FILE, CLEAN), {
         extraSharedModules: [
            {
               model: {
                  ClientSessionFactory: (shared: ServerSharedServices) => ({
                     create: (clientId: string, label: string) => new RecordingSession(shared, { clientId, label })
                  })
               }
            }
         ]
      });
      const shared = scratch.harness.shared;
      const uri = scratch.workspace.uri(FILE);
      const head = makeDataServerHarness<DataServer<DomainModel>, DomainModel>({
         server: channel => new DataServer<DomainModel>(channel, shared)
      });
      heads.push(head);
      await head.proxy.createSession({ clientId: SESSION });
      await head.proxy.openModelDocument({ uri, clientId: SESSION });
      const wire = (model: string): TransferUpdateDocumentArgs<DomainModel> =>
         ({ uri, clientId: SESSION, model, baseVersion: 'any', note: 'wire only' }) as TransferUpdateDocumentArgs<DomainModel>;

      await head.proxy.updateModelDocument(wire(EDITED));
      await head.proxy.saveModelDocument(wire(CLEAN));
      await head.proxy.updateModelDocuments({ clientId: SESSION, updates: [wire(EDITED)] });

      const written = { uri, baseVersion: 'any' };
      expect(writes).toEqual([
         { ...written, model: EDITED },
         { ...written, model: CLEAN },
         { ...written, model: EDITED }
      ]);
   });

   it('createModelDocument refuses an existing file, and an id that is not a session of the connection', async () => {
      const { uri, newUri, connect } = await boot();
      const { proxy } = connect();
      await proxy.createSession({ clientId: SESSION });

      await expect(proxy.createModelDocument({ uri, clientId: SESSION, text: CLEAN })).rejects.toThrow(/exists/);
      const plain = await rejectionOf(proxy.createModelDocument({ uri: newUri, clientId: 'plain-client', text: CLEAN }));
      expect(isSessionClosedError(plain)).toBe(true);
      expect(String(plain)).toContain('not registered');
      // The sentence can reach an end user, so the id travels in `data` only.
      expect(String(plain)).not.toContain('plain-client');
      expect((plain as { data?: { clientId?: string } }).data?.clientId).toBe('plain-client');
   });
});

/**
 * A `DataSession` over whichever harness `current` answers, recording what its
 * host is told: the part of a `DataConnection` a restore talks to, with the
 * connection's transport replaced by switching harnesses.
 */
function sessionOver(
   current: () => Harness,
   reported: ResolvedMessage[],
   onDidChangeDirty?: Event<TransferDocumentDirtyChangedEvent>
): DataSession<DomainModel, DataServerProtocol<DomainModel>> {
   return new DataSession<DomainModel, DataServerProtocol<DomainModel>>(
      'form#restore',
      {
         connected: async () => current().proxy as RpcProxy<DataServerProtocol<DomainModel>>,
         reportError: (_error, message) => reported.push(message),
         onDidChangeDirty
      },
      'form'
   );
}

/** End a data connection as the server sees it, then the pair. */
function drop(head: Harness): void {
   head.server.dispose();
   head.dispose();
}

describe('DataSession restore against the real stack', () => {
   it('reports a write based on any version that a revert took, and sends it nowhere', async () => {
      // The session is the document's only client, so ending it reverts the
      // document to disk.
      const { services, uri, connect } = await boot();
      const textDocuments = services.shared.workspace.TextDocuments;
      let head = connect();
      const reported: ResolvedMessage[] = [];
      const session = sessionOver(() => head, reported);
      await session.openDocument({ uri });
      await session.updateDocument({ uri, model: EDITED, baseVersion: 'any' });

      drop(head);
      head = connect();
      await session.connected();

      expect(reported.map(message => message.code)).toEqual([DATA_SESSION_UNSAVED_LOST.code]);
      expect(reported[0].params).toEqual({ uris: uri });
      expect(textDocuments.get(uri)?.getText()).toBe(CLEAN);
      expect(textDocuments.isOpenInClient(uri, 'form#restore')).toBe(true);
   });

   it('reports a write based on any version that a restarted server never had, and sends it nowhere', async () => {
      const { uri, connect } = await boot();
      let head: Harness = connect();
      const reported: ResolvedMessage[] = [];
      const session = sessionOver(() => head, reported);
      await session.openDocument({ uri });
      await session.updateDocument({ uri, model: EDITED, baseVersion: 'any' });

      drop(head);
      const restarted = makeServices();
      await initializeWorkspaceProgrammatically(restarted.shared, scratch!.workspace.root);
      head = makeDataServerHarness<DataServer<DomainModel>, DomainModel>({
         server: channel => new DataServer<DomainModel>(channel, restarted.shared)
      });
      heads.push(head);
      await session.connected();

      expect(reported.map(message => message.code)).toEqual([DATA_SESSION_UNSAVED_LOST.code]);
      expect(restarted.shared.workspace.TextDocuments.get(uri)?.getText()).toBe(CLEAN);
   });

   it('reports nothing when another client kept the document, and the edits with it', async () => {
      const { services, uri, connect } = await boot();
      const textDocuments = services.shared.workspace.TextDocuments;
      await services.shared.model.ModelService.createSession('bystander').open(uri);
      let head = connect();
      const reported: ResolvedMessage[] = [];
      const session = sessionOver(() => head, reported);
      await session.openDocument({ uri });
      await session.updateDocument({ uri, model: EDITED, baseVersion: 'any' });

      drop(head);
      head = connect();
      await session.connected();

      expect(reported).toEqual([]);
      expect(textDocuments.get(uri)?.getText()).toBe(EDITED);
   });
});

/** Outlast the release grace of a store booted with {@link GRACE_MS}. */
function outlastGrace(): Promise<void> {
   return new Promise(resolve => setTimeout(resolve, GRACE_MS + 200));
}

describe('DataSession re-apply against the real stack', () => {
   it('writes nothing to a document the release grace kept, which still holds the edit', async () => {
      const { services, uri, connect } = await boot();
      const textDocuments = services.shared.workspace.TextDocuments;
      let head = connect();
      const reported: ResolvedMessage[] = [];
      const session = sessionOver(() => head, reported);
      const opened = await session.openDocument({ uri });
      const written = await session.updateDocument({ uri, model: EDITED, baseVersion: opened.model!.version });

      head.server.lose();
      head.dispose();
      head = connect();
      await session.connected();

      expect(head.server.writes).toEqual([]);
      expect(reported).toEqual([]);
      expect(textDocuments.get(uri)?.getText()).toBe(EDITED);
      expect(textDocuments.version(uri)).toBe(written.model!.version);
   });

   it('writes the edit again to a document reverted after the grace', async () => {
      const { services, uri, connect } = await boot(GRACE_MS);
      const textDocuments = services.shared.workspace.TextDocuments;
      let head = connect();
      const reported: ResolvedMessage[] = [];
      const session = sessionOver(() => head, reported);
      const opened = await session.openDocument({ uri });
      await session.updateDocument({ uri, model: EDITED, baseVersion: opened.model!.version });

      head.server.lose();
      head.dispose();
      await outlastGrace();
      expect(textDocuments.get(uri)).toBeUndefined();
      head = connect();
      await session.connected();

      expect(head.server.writes).toEqual([`update ${uri}`]);
      expect(reported).toEqual([]);
      expect(textDocuments.get(uri)?.getText()).toBe(EDITED);
      expect(textDocuments.isDirty(uri)).toBe(true);
   });

   it('reports, and writes nothing to, a document another client edited meanwhile', async () => {
      const { services, uri, connect } = await boot();
      const textDocuments = services.shared.workspace.TextDocuments;
      let head = connect();
      const reported: ResolvedMessage[] = [];
      const session = sessionOver(() => head, reported);
      const opened = await session.openDocument({ uri });
      await session.updateDocument({ uri, model: EDITED, baseVersion: opened.model!.version });

      drop(head);
      const other = services.shared.model.ModelService.createSession('other');
      await other.open(uri);
      await other.update({ uri, model: THEIRS, baseVersion: 'any' });
      head = connect();
      await session.connected();

      expect(head.server.writes).toEqual([]);
      expect(reported.map(message => message.params)).toEqual([{ uris: uri }]);
      expect(textDocuments.get(uri)?.getText()).toBe(THEIRS);
   });

   it('writes the edit again to a restarted server', async () => {
      const { uri, connect } = await boot();
      let head: ProbeHarness = connect();
      const reported: ResolvedMessage[] = [];
      const session = sessionOver(() => head, reported);
      const opened = await session.openDocument({ uri });
      await session.updateDocument({ uri, model: EDITED, baseVersion: opened.model!.version });

      drop(head);
      const restarted = makeServices();
      await initializeWorkspaceProgrammatically(restarted.shared, scratch!.workspace.root);
      head = makeDataServerHarness<RestoreProbeServer, DomainModel>({
         server: channel => new RestoreProbeServer(channel, restarted.shared)
      });
      heads.push(head);
      await session.connected();

      expect(head.server.writes).toEqual([`update ${uri}`]);
      expect(reported).toEqual([]);
      expect(restarted.shared.workspace.TextDocuments.get(uri)?.getText()).toBe(EDITED);
   });

   it('writes a set written together again in one call', async () => {
      const { services, uri, otherUri, connect } = await boot();
      const textDocuments = services.shared.workspace.TextDocuments;
      let head = connect();
      const reported: ResolvedMessage[] = [];
      const session = sessionOver(() => head, reported);
      const opened = await session.openDocument({ uri });
      const otherOpened = await session.openDocument({ uri: otherUri });
      await session.updateDocuments({
         updates: [
            { uri, model: EDITED, baseVersion: opened.model!.version },
            { uri: otherUri, model: EDITED, baseVersion: otherOpened.model!.version }
         ]
      });

      drop(head);
      head = connect();
      await session.connected();

      expect(head.server.writes).toEqual([`updates ${uri} ${otherUri}`]);
      expect(reported).toEqual([]);
      expect(textDocuments.get(uri)?.getText()).toBe(EDITED);
      expect(textDocuments.get(otherUri)?.getText()).toBe(EDITED);
   });

   it('writes nothing of a set one of whose documents another client edited, and reports the set', async () => {
      const { services, uri, otherUri, connect } = await boot();
      const textDocuments = services.shared.workspace.TextDocuments;
      let head = connect();
      const reported: ResolvedMessage[] = [];
      const session = sessionOver(() => head, reported);
      const opened = await session.openDocument({ uri });
      const otherOpened = await session.openDocument({ uri: otherUri });
      await session.updateDocuments({
         updates: [
            { uri, model: EDITED, baseVersion: opened.model!.version },
            { uri: otherUri, model: EDITED, baseVersion: otherOpened.model!.version }
         ]
      });

      drop(head);
      const other = services.shared.model.ModelService.createSession('other');
      await other.open(otherUri);
      await other.update({ uri: otherUri, model: THEIRS, baseVersion: 'any' });
      head = connect();
      await session.connected();

      expect(head.server.writes).toEqual([]);
      expect(reported.map(message => message.params)).toEqual([{ uris: `${uri}, ${otherUri}` }]);
      expect(textDocuments.get(uri)?.getText()).toBe(CLEAN);
      expect(textDocuments.get(otherUri)?.getText()).toBe(THEIRS);
   });

   it('reports a write sent again that conflicts with an edit made after the re-open, and sends it once', async () => {
      const { services, uri, connect } = await boot();
      const textDocuments = services.shared.workspace.TextDocuments;
      let head = connect();
      const reported: ResolvedMessage[] = [];
      const session = sessionOver(() => head, reported);
      const opened = await session.openDocument({ uri });
      await session.updateDocument({ uri, model: EDITED, baseVersion: opened.model!.version });

      drop(head);
      head = connect();
      const other = services.shared.model.ModelService.createSession('other');
      head.server.afterWatch = async () => {
         head.server.afterWatch = undefined;
         await other.open(uri);
         await other.update({ uri, model: THEIRS, baseVersion: 'any' });
      };
      await session.connected();

      expect(head.server.writes).toEqual([`update ${uri}`]);
      expect(reported.map(message => message.params)).toEqual([{ uris: uri }]);
      expect(textDocuments.get(uri)?.getText()).toBe(THEIRS);
   });

   it('reports nothing to a restarted server for a write another client saved with an edit of its own', async () => {
      const { services, uri } = await boot();
      const reported: ResolvedMessage[] = [];
      const cleaned: string[] = [];
      const dirtyChanged = new Emitter<TransferDocumentDirtyChangedEvent>();
      let head: Harness;
      const session = sessionOver(() => head, reported, dirtyChanged.event);
      head = makeDataServerHarness<DataServer<DomainModel>, DomainModel>({
         server: channel => new DataServer<DomainModel>(channel, services.shared),
         client: {
            onDocumentDirtyChanged: event => {
               dirtyChanged.fire(event);
               if (!event.text?.dirty) {
                  cleaned.push(event.uri);
               }
            }
         }
      });
      heads.push(head);
      const opened = await session.openDocument({ uri });
      await session.updateDocument({ uri, model: EDITED, baseVersion: opened.model!.version });
      const other = services.shared.model.ModelService.createSession('other');
      await other.open(uri);
      await other.save({ uri, model: THEIRS, baseVersion: 'any' });
      await waitFor(() => cleaned.includes(uri), { message: 'the save never turned the document clean for the session' });

      drop(head);
      const restarted = makeServices();
      await initializeWorkspaceProgrammatically(restarted.shared, scratch!.workspace.root);
      const probe = makeDataServerHarness<RestoreProbeServer, DomainModel>({
         server: channel => new RestoreProbeServer(channel, restarted.shared)
      });
      heads.push(probe);
      head = probe;
      await session.connected();

      expect(probe.server.writes).toEqual([]);
      expect(reported).toEqual([]);
      expect(restarted.shared.workspace.TextDocuments.get(uri)?.getText()).toBe(THEIRS);
   });

   it('sends and reports nothing after a restart for a write that answered after the session saved it', async () => {
      const { services, uri } = await boot();
      const reported: ResolvedMessage[] = [];
      const dirtyChanged = new Emitter<TransferDocumentDirtyChangedEvent>();
      let head: ProbeHarness;
      const session = sessionOver(() => head, reported, dirtyChanged.event);
      head = makeDataServerHarness<RestoreProbeServer, DomainModel>({
         server: channel => new RestoreProbeServer(channel, services.shared),
         client: { onDocumentDirtyChanged: event => dirtyChanged.fire(event) }
      });
      heads.push(head);
      const opened = await session.openDocument({ uri });
      let release!: () => void;
      head.server.answerGate = new Promise<void>(resolve => {
         release = resolve;
      });
      const late = session.updateDocument({ uri, model: EDITED, baseVersion: opened.model!.version });
      const textDocuments = services.shared.workspace.TextDocuments;
      await waitFor(() => textDocuments.get(uri)?.getText() === EDITED, { message: 'the write was never applied' });
      await session.saveDocument({ uri, model: EDITED, baseVersion: 'any' });
      // Another client moves the text on before the write answers, so the
      // answer carries neither the saved text nor the write's base.
      const other = services.shared.model.ModelService.createSession('other');
      await other.open(uri);
      await other.update({ uri, model: THEIRS, baseVersion: 'any' });
      release();
      await late;

      drop(head);
      const restarted = makeServices();
      await initializeWorkspaceProgrammatically(restarted.shared, scratch!.workspace.root);
      const probe = makeDataServerHarness<RestoreProbeServer, DomainModel>({
         server: channel => new RestoreProbeServer(channel, restarted.shared)
      });
      heads.push(probe);
      head = probe;
      await session.connected();

      expect(probe.server.writes).toEqual([]);
      expect(reported).toEqual([]);
      expect(restarted.shared.workspace.TextDocuments.get(uri)?.getText()).toBe(EDITED);
   });
});

describe('DataConnection.watchDocument against the real stack', () => {
   it('delivers update events to a watcher that opened nothing, until its handle is disposed', async () => {
      const { services, uri, connect } = await boot();
      const pairs: DuplexConnectionPair[] = [];
      const servers: DataServer<DomainModel>[] = [];
      const port = makeFakeDataPort({
         connect: () => {
            const pair = makeDuplexConnectionPair();
            pairs.push(pair);
            servers.push(new DataServer<DomainModel>(pair.left, services.shared));
            return pair.right;
         }
      });
      const connection = new DataConnectionWithEvents<DomainModel>(port);
      const updated: string[] = [];
      connection.events.onDidUpdateDocument(event => updated.push(event.document.uri));
      const writer = connect();
      try {
         const watch = await connection.watchDocument(uri, 'outline');
         expect(services.shared.workspace.TextDocuments.get(uri)).toBeUndefined();

         await writer.proxy.createSession({ clientId: SESSION });
         await writer.proxy.openModelDocument({ uri, clientId: SESSION });
         await writer.proxy.updateModelDocument({ uri, clientId: SESSION, model: EDITED, baseVersion: 'any' });
         await waitFor(() => updated.length > 0, { message: 'the watcher heard no update' });

         watch.dispose();
         // Answered after the unwatch, which was sent first on the same connection.
         await (await connection.connected()).getModelDocument({ uri });
         const heard = updated.length;
         await writer.proxy.updateModelDocument({ uri, clientId: SESSION, model: CLEAN, baseVersion: 'any' });
         await (await connection.connected()).getModelDocument({ uri });

         expect(updated.length).toBe(heard);
      } finally {
         connection.dispose();
         servers.forEach(server => server.dispose());
         pairs.forEach(pair => pair.dispose());
         port.dispose();
      }
   });
});
