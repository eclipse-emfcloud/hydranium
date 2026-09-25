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
   DataSession,
   isDocumentNotOpenError,
   isDuplicateClientIdError,
   isSessionClosedError,
   type ResolvedMessage,
   type RpcProxy,
   TransferDocument
} from '@hydranium/protocol';
import { DataServer } from '@hydranium/data-server';
import { makeDataServerHarness, type DataServerHarness } from '@hydranium/data-server/testing';
import { initializeWorkspaceProgrammatically } from '@hydranium/core';
import type { DataServerProtocol } from '@hydranium/protocol/data';
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
const SESSION = 'form#wire-1';

type Harness = DataServerHarness<DataServer<DomainModel>, DomainModel>;

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
   readonly connect: () => Harness;
}

async function boot(): Promise<Booted> {
   scratch = await makeScratchWorkspaceHarness(workspace => {
      workspace.write(FILE, CLEAN);
      workspace.write(OTHER_FILE, CLEAN);
   });
   const { harness: services, workspace } = scratch;
   return {
      services,
      uri: workspace.uri(FILE),
      otherUri: workspace.uri(OTHER_FILE),
      newUri: workspace.uri(NEW_FILE),
      path: file => workspace.resolve(file),
      connect: () => {
         const head = makeDataServerHarness<DataServer<DomainModel>, DomainModel>({
            server: channel => new DataServer<DomainModel>(channel, services.shared)
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

      const failure = await rejectionOf(proxy.updateModelDocument({ uri, clientId: 'plain-client', model: EDITED, basedOn: 'anything' }));

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
      const { proxy } = connect();

      expect(isDuplicateClientIdError(await rejectionOf(proxy.createSession({ clientId: SESSION })))).toBe(true);
      expect(isDuplicateClientIdError(await rejectionOf(proxy.createSession({ clientId: SESSION, resumeToken: 'guess' })))).toBe(true);
      await proxy.createSession({ clientId: SESSION, resumeToken: 'secret' });

      expect(textDocuments.isOpenInClient(uri, SESSION)).toBe(false);
      const late = await rejectionOf(stale.proxy.updateModelDocument({ uri, clientId: SESSION, model: EDITED, basedOn: 'anything' }));
      expect(isSessionClosedError(late)).toBe(true);
      await proxy.openModelDocument({ uri, clientId: SESSION });
      await proxy.updateModelDocument({ uri, clientId: SESSION, model: EDITED, basedOn: 'anything' });
   });

   it('closeSession closes everything the session has open, drops its watches and frees the id', async () => {
      const { services, uri, otherUri, connect } = await boot();
      const textDocuments = services.shared.workspace.TextDocuments;
      const head = connect();
      await head.proxy.createSession({ clientId: SESSION });
      await head.proxy.openModelDocument({ uri, clientId: SESSION, options: { mode: 'compact' } });
      await head.proxy.openModelDocument({ uri: otherUri, clientId: SESSION });
      await head.proxy.watchModelDocument({ uri, clientId: SESSION });
      expect(textDocuments.openOptions(uri, SESSION)).toEqual({ mode: 'compact' });

      await head.proxy.closeSession({ clientId: SESSION });

      expect(textDocuments.isOpenInClient(uri, SESSION)).toBe(false);
      expect(textDocuments.isOpenInClient(otherUri, SESSION)).toBe(false);
      const internal = head.server as unknown as { subscriptions: Map<string, Set<string>> };
      expect([...internal.subscriptions.values()].some(watchers => watchers.has(SESSION))).toBe(false);
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

      const late = await rejectionOf(proxy.updateModelDocument({ uri, clientId: SESSION, model: EDITED, basedOn: 'anything' }));
      const lateClose = await rejectionOf(proxy.closeModelDocument({ uri, clientId: SESSION }));

      expect(isSessionClosedError(late)).toBe(true);
      expect(isSessionClosedError(lateClose)).toBe(true);
      expect(services.shared.workspace.TextDocuments.isOpen(uri)).toBe(false);
   });

   it('forgets a resume token once its session ended some other way', async () => {
      const { services, connect } = await boot();
      const head = connect();
      await head.proxy.createSession({ clientId: SESSION, resumeToken: 'secret' });
      const resumable = (head.server as unknown as { resumableSessions(): Map<string, unknown> }).resumableSessions();
      expect(resumable.has(SESSION)).toBe(true);

      services.shared.model.ModelService.getSession(SESSION)?.dispose();

      expect(resumable.has(SESSION)).toBe(false);
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

      const write = rejectionOf(head.server.updateModelDocument({ uri, clientId: SESSION, model: EDITED, basedOn: opened.version }));
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
      expect(TransferDocument.assertLoaded(created).root.$type).toBe('DomainModel');
      expect(services.shared.workspace.TextDocuments.isOpenInClient(newUri, SESSION)).toBe(true);
      expect(() => readFileSync(path(NEW_FILE), 'utf8')).toThrow();

      await proxy.saveModelDocument({ uri: newUri, clientId: SESSION, model: EDITED, basedOn: created.version });
      expect(readFileSync(path(NEW_FILE), 'utf8')).toBe(EDITED);
   });

   it('createModelDocument refuses an existing file, and an id that is not a session of the connection', async () => {
      const { uri, newUri, connect } = await boot();
      const { proxy } = connect();
      await proxy.createSession({ clientId: SESSION });

      await expect(proxy.createModelDocument({ uri, clientId: SESSION, text: CLEAN })).rejects.toThrow(/exists/);
      const plain = await rejectionOf(proxy.createModelDocument({ uri: newUri, clientId: 'plain-client', text: CLEAN }));
      expect(isSessionClosedError(plain)).toBe(true);
      expect(String(plain)).toContain('never registered');
   });
});

/**
 * A `DataSession` over whichever harness `current` answers, recording what its
 * host is told: the part of a `DataConnection` a restore talks to, with the
 * connection's transport replaced by switching harnesses.
 */
function sessionOver(current: () => Harness, reported: ResolvedMessage[]): DataSession<DomainModel, DataServerProtocol<DomainModel>> {
   return new DataSession<DomainModel, DataServerProtocol<DomainModel>>(
      'form#restore',
      {
         connected: async () => current().proxy as RpcProxy<DataServerProtocol<DomainModel>>,
         releaseSession: () => undefined,
         reportError: (_error, message) => reported.push(message)
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
   it('reports unsaved edits a revert took, and sends them nowhere', async () => {
      // The session is the document's only client, so ending it reverts the
      // document to disk.
      const { services, uri, connect } = await boot();
      const textDocuments = services.shared.workspace.TextDocuments;
      let head = connect();
      const reported: ResolvedMessage[] = [];
      const session = sessionOver(() => head, reported);
      await session.openDocument({ uri });
      await session.updateDocument({ uri, model: EDITED, basedOn: 'anything' });

      drop(head);
      head = connect();
      await session.connected();

      expect(reported.map(message => message.code)).toEqual([DATA_SESSION_UNSAVED_LOST.code]);
      expect(reported[0].params).toEqual({ uris: uri });
      expect(textDocuments.get(uri)?.getText()).toBe(CLEAN);
      expect(textDocuments.isOpenInClient(uri, 'form#restore')).toBe(true);
   });

   it('reports unsaved edits a restarted server never had, and sends them nowhere', async () => {
      const { uri, connect } = await boot();
      let head = connect();
      const reported: ResolvedMessage[] = [];
      const session = sessionOver(() => head, reported);
      await session.openDocument({ uri });
      await session.updateDocument({ uri, model: EDITED, basedOn: 'anything' });

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
      await session.updateDocument({ uri, model: EDITED, basedOn: 'anything' });

      drop(head);
      head = connect();
      await session.connected();

      expect(reported).toEqual([]);
      expect(textDocuments.get(uri)?.getText()).toBe(EDITED);
   });
});
