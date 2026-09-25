/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * The revert to disk that follows a document's last close, through the real
 * stack and with no language server: the text store runs it for every head.
 * The observable is the built document's text, which is what every read and
 * every integrity pass sees.
 *
 * Most grace cases rebind the text store with a short `revertGraceMs`, the
 * one way a server sets it, so that a test can outlast it.
 */

import { HydraniumTextDocuments, INTEGRITY_CLIENT_ID, REVERT_ON_CLOSE_CLIENT_ID, type ServerSharedServices } from '@hydranium/core';
import { DataServer } from '@hydranium/data-server';
import { makeDataServerHarness, type DataServerHarness } from '@hydranium/data-server/testing';
import { DocumentState, URI } from '@hydranium/langium';
import { DataSession, type ResolvedMessage, type RpcProxy } from '@hydranium/protocol';
import type { DataServerProtocol } from '@hydranium/protocol/data';
import { waitFor } from '@hydranium/protocol/testing';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import type { DomainModel } from '../src/language-server/generated-hydranium/transfer-model.js';
import { makeScratchWorkspaceHarness, type OrderFlowHarness, type ScratchOrderFlowHarness, WORKSPACE_FILES } from './order-flow-harness.js';

const FILE = 'revert.domain';
const CLEAN = `entity Solo {
   a : string
}
`;
const EDITED = `entity Solo {
   a : string
   b : string
}
`;
const GRACE_MS = 300;

/** A data server whose connection can be lost, as a dropped transport would end it. */
class LosableDataServer extends DataServer<DomainModel> {
   lose(): void {
      this.dispose('lost');
   }
}

type Head = DataServerHarness<LosableDataServer, DomainModel>;

let scratch: ScratchOrderFlowHarness | undefined;
const heads: Head[] = [];

afterEach(() => {
   heads.splice(0).forEach(head => head.dispose());
   scratch?.workspace.dispose();
   scratch = undefined;
});

interface Booted {
   readonly services: OrderFlowHarness;
   readonly uri: string;
   readonly path: (file: string) => string;
   /** The text the build currently holds for `uri`. */
   readonly built: () => string | undefined;
}

async function boot(revertGraceMs?: number): Promise<Booted> {
   scratch = await makeScratchWorkspaceHarness(
      workspace => workspace.write(FILE, CLEAN),
      revertGraceMs === undefined
         ? {}
         : {
              extraSharedModules: [
                 { workspace: { TextDocuments: (shared: ServerSharedServices) => new HydraniumTextDocuments(shared, { revertGraceMs }) } }
              ]
           }
   );
   const { harness: services, workspace } = scratch;
   const uri = workspace.uri(FILE);
   return {
      services,
      uri,
      path: file => workspace.resolve(file),
      built: () => services.shared.workspace.LangiumDocuments.getDocument(URI.parse(uri))?.textDocument.getText()
   };
}

/** Outlast what a revert would take, for a test asserting that none happens. */
function outlastRevert(ms = GRACE_MS + 200): Promise<void> {
   return new Promise(resolve => setTimeout(resolve, ms));
}

describe('revert grace', () => {
   it('refuses a create of a document waiting out the grace, and says so', async () => {
      const { services, path } = await boot(GRACE_MS);
      const models = services.shared.model.ModelService;
      const uri = URI.file(path('never-saved.domain')).toString();
      const lost = models.createSession('form');
      await lost.create(uri, CLEAN);

      lost.dispose('lost');
      const refusal = await models
         .createSession('form')
         .create(uri, EDITED)
         .then(
            () => undefined,
            (error: unknown) => error
         );

      expect(String(refusal)).toContain('revert grace');
      expect(services.shared.workspace.TextDocuments.get(uri)?.getText()).toBe(CLEAN);
   });

   it('keeps a lost session’s unsaved text for a session under its id that opens the document within the grace', async () => {
      const { services, uri, built } = await boot(GRACE_MS);
      const models = services.shared.model.ModelService;
      const textDocuments = services.shared.workspace.TextDocuments;
      const lost = models.createSession('form');
      await lost.open(uri);
      const written = await lost.update({ uri, model: EDITED, basedOn: 'anything' });

      lost.dispose('lost');
      const back = models.createSession('form', lost.clientId);
      await back.open(uri);
      await outlastRevert();

      expect(textDocuments.get(uri)?.getText()).toBe(EDITED);
      expect(textDocuments.version(uri)).toBe(written.version);
      expect(built()).toBe(EDITED);
   });

   it('opens a lost session’s document from disk for another session within the grace', async () => {
      const { services, uri, built } = await boot(GRACE_MS);
      const models = services.shared.model.ModelService;
      const textDocuments = services.shared.workspace.TextDocuments;
      const lost = models.createSession('form');
      await lost.open(uri);
      const written = await lost.update({ uri, model: EDITED, basedOn: 'anything' });

      lost.dispose('lost');
      const other = models.createSession('form');
      await other.open(uri);

      expect(textDocuments.get(uri)?.getText()).toBe(CLEAN);
      expect(textDocuments.version(uri)).toBeGreaterThan(written.version);
      expect(textDocuments.isRevertPending(uri)).toBe(false);
      await waitFor(() => built() === CLEAN, { timeoutMs: 2000 });
   });

   it('writes no unsaved text of a document waiting out the grace to disk when integrity repairs it', async () => {
      // The flow-node rule renames the duplicate task. The session's connection
      // is lost in the step that applies the unsaved write, so the repair runs
      // in a build of a document open for no client, waiting out the grace;
      // under the default 'silent' sync mode a closed document's repair is
      // written to disk, which would persist the lost session's unsaved text.
      const { services, path } = await boot(GRACE_MS);
      const sourcePath = path(WORKSPACE_FILES.fulfillmentProcess);
      const uri = URI.file(sourcePath).toString();
      const textDocuments = services.shared.workspace.TextDocuments;
      const onDisk = readFileSync(sourcePath, 'utf8');
      const lastBrace = onDisk.lastIndexOf('}');
      const duplicated = `${onDisk.slice(0, lastBrace)}   task Pay writes Order.status = PAID\n${onDisk.slice(lastBrace)}`;
      const lost = services.shared.model.ModelService.createSession('diagram');
      await lost.open(uri);
      const listener = textDocuments.onDidChangeContent(event => {
         if (event.clientId === lost.clientId) {
            lost.dispose('lost');
         }
      });

      try {
         await lost.update({ uri, model: duplicated, basedOn: 'anything' });
         await services.shared.workspace.DocumentBuilder.waitUntil(DocumentState.Validated, URI.parse(uri));
      } finally {
         listener.dispose();
      }

      expect(textDocuments.isRevertPending(uri)).toBe(true);
      expect(textDocuments.getAuthor(uri)).toBe(INTEGRITY_CLIENT_ID);
      expect(textDocuments.get(uri)?.getText()).toContain('Pay__1');
      expect(readFileSync(sourcePath, 'utf8')).toBe(onDisk);
      // Let the revert run while the scratch workspace it reads still exists.
      const built = (): string | undefined =>
         services.shared.workspace.LangiumDocuments.getDocument(URI.parse(uri))?.textDocument.getText();
      await waitFor(() => built() === onDisk, { timeoutMs: GRACE_MS + 2000 });
   });
});

describe('revert grace over the data head', () => {
   function connect(services: OrderFlowHarness): Head {
      const head = makeDataServerHarness<LosableDataServer, DomainModel>({
         server: channel => new LosableDataServer(channel, services.shared)
      });
      heads.push(head);
      return head;
   }

   function sessionOver(current: () => Head, reported: ResolvedMessage[]): DataSession<DomainModel, DataServerProtocol<DomainModel>> {
      return new DataSession<DomainModel, DataServerProtocol<DomainModel>>(
         'form#grace',
         {
            connected: async () => current().proxy as RpcProxy<DataServerProtocol<DomainModel>>,
            reportError: (_error, message) => reported.push(message)
         },
         'form'
      );
   }

   it('hands a data session back its unsaved edits when it comes back within the grace, and reports nothing', async () => {
      const { services, uri, built } = await boot(GRACE_MS);
      let head = connect(services);
      const reported: ResolvedMessage[] = [];
      const session = sessionOver(() => head, reported);
      await session.openDocument({ uri });
      await session.updateDocument({ uri, model: EDITED, basedOn: 'anything' });

      head.server.lose();
      head = connect(services);
      await session.connected();
      expect(services.shared.workspace.TextDocuments.isRevertPending(uri)).toBe(false);
      await outlastRevert();

      expect(reported).toEqual([]);
      expect(services.shared.workspace.TextDocuments.get(uri)?.getText()).toBe(EDITED);
      expect(built()).toBe(EDITED);
   });

   it('hands a data session back its unsaved edits under the default grace, and reports nothing', async () => {
      const { services, uri, built } = await boot();
      const textDocuments = services.shared.workspace.TextDocuments;
      let head = connect(services);
      const reported: ResolvedMessage[] = [];
      const session = sessionOver(() => head, reported);
      await session.openDocument({ uri });
      await session.updateDocument({ uri, model: EDITED, basedOn: 'anything' });

      head.server.lose();
      expect(textDocuments.isRevertPending(uri)).toBe(true);
      head = connect(services);
      await session.connected();

      expect(reported).toEqual([]);
      expect(textDocuments.isRevertPending(uri)).toBe(false);
      expect(textDocuments.get(uri)?.getText()).toBe(EDITED);
      expect(built()).toBe(EDITED);
   });

   it('broadcasts a lost session’s revert once, when the grace runs out, to a connection that watches nothing', async () => {
      const { services, uri, built } = await boot(GRACE_MS);
      const head = connect(services);
      const observer = connect(services);
      const reverts = (): number => observer.events.filter(event => event.sourceClientId === REVERT_ON_CLOSE_CLIENT_ID).length;
      await head.proxy.createSession({ clientId: 'form#lost' });
      await head.proxy.openModelDocument({ uri, clientId: 'form#lost' });
      await head.proxy.updateModelDocument({ uri, clientId: 'form#lost', model: EDITED, basedOn: 'anything' });

      head.server.lose();
      await outlastRevert(GRACE_MS / 2);
      expect(reverts()).toBe(0);

      await waitFor(() => built() === CLEAN && reverts() > 0, { timeoutMs: GRACE_MS + 2000 });
      await outlastRevert(100);
      expect(reverts()).toBe(1);
      expect(observer.events.find(event => event.sourceClientId === REVERT_ON_CLOSE_CLIENT_ID)?.document.uri).toBe(uri);
   });

   it('opens a lost session’s document from disk for a session of another connection within the grace, and broadcasts the revert', async () => {
      const { services, uri, built } = await boot(GRACE_MS);
      const textDocuments = services.shared.workspace.TextDocuments;
      const head = connect(services);
      const other = connect(services);
      const watcher = connect(services);
      const reverts = (): number => watcher.events.filter(event => event.sourceClientId === REVERT_ON_CLOSE_CLIENT_ID).length;
      await head.proxy.createSession({ clientId: 'form#lost' });
      const onDisk = await head.proxy.openModelDocument({ uri, clientId: 'form#lost' });
      await head.proxy.updateModelDocument({ uri, clientId: 'form#lost', model: EDITED, basedOn: 'anything' });

      head.server.lose();
      await other.proxy.createSession({ clientId: 'tree#other' });
      const opened = await other.proxy.openModelDocument({ uri, clientId: 'tree#other' });

      expect(opened.root).toEqual(onDisk.root);
      expect(textDocuments.get(uri)?.getText()).toBe(CLEAN);
      expect(textDocuments.isRevertPending(uri)).toBe(false);
      await waitFor(() => built() === CLEAN && reverts() > 0, { timeoutMs: 2000 });
   });

   it('broadcasts no revert for a lost session’s document it opens again within the grace', async () => {
      const { services, uri } = await boot(GRACE_MS);
      const head = connect(services);
      const observer = connect(services);
      await head.proxy.createSession({ clientId: 'form#lost' });
      await head.proxy.openModelDocument({ uri, clientId: 'form#lost' });
      await head.proxy.updateModelDocument({ uri, clientId: 'form#lost', model: EDITED, basedOn: 'anything' });

      head.server.lose();
      await observer.proxy.createSession({ clientId: 'form#lost' });
      await observer.proxy.openModelDocument({ uri, clientId: 'form#lost' });
      // A build the reopen's write drives, which a revert mark left behind
      // by the close would take for the revert.
      await observer.proxy.updateModelDocument({ uri, clientId: 'form#lost', model: CLEAN, basedOn: 'anything' });
      await outlastRevert();

      expect(observer.events.filter(event => event.sourceClientId === REVERT_ON_CLOSE_CLIENT_ID)).toEqual([]);
   });

   it('reverts a data session’s document at once when its connection closes it on purpose', async () => {
      const { services, uri, built } = await boot(GRACE_MS);
      const head = connect(services);
      await head.proxy.createSession({ clientId: 'form#closing' });
      await head.proxy.openModelDocument({ uri, clientId: 'form#closing' });
      await head.proxy.updateModelDocument({ uri, clientId: 'form#closing', model: EDITED, basedOn: 'anything' });

      await head.proxy.closeSession({ clientId: 'form#closing' });

      expect(services.shared.workspace.TextDocuments.get(uri)).toBeUndefined();
      await waitFor(() => built() === CLEAN, { timeoutMs: GRACE_MS - 100 });
   });
});
