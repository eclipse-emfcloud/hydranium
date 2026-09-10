/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * The data port and the session over it, driven against a **real** data server.
 *
 * A stub server would prove the session calls the methods it says it calls,
 * which is not the property at risk. Every behaviour this suite exists for is a
 * property of the server's actual lifecycle: that `watchModelDocument`
 * establishes a subscription only once a document is open, that `waitForReady`
 * gates on a workspace walk that really happens, and that a second connection
 * to the same shared services is a working connection. So this boots all three
 * order-flow languages over a throwaway copy of the sample workspace and puts a
 * real `DataServer` behind the port.
 *
 * The transport is the framework's in-process duplex pair rather than a TCP
 * socket. That is the right level here: the port's whole contract is "hand back
 * a listening `MessageConnection`", and which byte pipe carries it is the host
 * adapter's business, covered for the socket case by the server package's own
 * smoke suites.
 *
 * **One thing this suite does NOT cover, stated rather than implied.** The
 * readiness gate's *necessity* is not tested, only its presence: the workspace
 * is initialized before the port ever connects, so there is no window in which
 * an early request could be answered from an empty registry. Deleting the
 * `waitForReady` call reddens the error-reporting test but leaves the
 * project-listing one green — measured. Covering the necessity needs a server
 * whose workspace walk is still in flight, which is the socket smoke suites'
 * territory rather than this one's.
 */

import { initializeWorkspaceProgrammatically } from '@hydranium/core';
import { NodeFileSystem } from '@hydranium/core/lib/node';
import { type ScratchWorkspace, makeScratchWorkspace } from '@hydranium/core/lib/testing/node';
import { DataServer } from '@hydranium/data-server';
import {
   DATA_SERVER_NOT_READY,
   DataSession,
   type DataClientProtocol,
   type DataPort,
   type ResolvedMessage,
   type TransferDocumentSavedEvent,
   type TransferDocumentUpdatedEvent
} from '@hydranium/protocol';
import { waitFor } from '@hydranium/protocol/lib/testing';
import { type DuplexConnectionPair, makeDuplexConnectionPair } from '@hydranium/protocol/lib/testing/node';
import { createOrderFlowServices } from '@hydranium/example-order-flow-server/lib/language-server/order-flow-module';
import type {
   DomainModel,
   LayoutModel,
   ProcessModel
} from '@hydranium/example-order-flow-server/lib/language-server/generated-hydranium/transfer-model';
import { readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { Emitter, type Event, type MessageConnection } from 'vscode-jsonrpc';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/** The three transfer roots this server serves, as a host would name them. */
type OrderFlowTransferRoot = DomainModel | LayoutModel | ProcessModel;

/** The committed sample workspace this suite copies. */
const WORKSPACE_ROOT = path.resolve(__dirname, '../../workspace');
const FULFILLMENT_PROCESS = 'orders/fulfillment.process';

/** A writer that is deliberately NOT the session, so its writes are not echoes. */
const THIRD_PARTY = 'some-other-editor';

/**
 * A port over the framework's in-process duplex pair, standing in for a host
 * adapter. Counts `connect` calls, because "one connection shared across
 * concurrent callers" and "a fresh connection after a teardown" are both
 * assertions about that count and about nothing observable otherwise.
 */
class FakeDataPort implements DataPort {
   readonly clientId = 'order-flow-form';
   /** Every `connect()` so far, so a test can assert the generation count. */
   readonly connections: DuplexConnectionPair[] = [];
   /** Everything reported through the port, for the failure-path assertions. */
   readonly reported: Array<{ error: unknown; message: ResolvedMessage }> = [];

   protected readonly disposeEmitter = new Emitter<void>();
   readonly onDispose: Event<void> = this.disposeEmitter.event;

   constructor(protected readonly attachServer: (channel: MessageConnection) => void) {}

   async connect(): Promise<MessageConnection> {
      const pair = makeDuplexConnectionPair();
      this.connections.push(pair);
      // A real host connects to an already-running server; here the server is
      // constructed per connection, which is what `startSocketServer` does per
      // accepted socket too.
      this.attachServer(pair.left);
      return pair.right;
   }

   reportError(error: unknown, message: ResolvedMessage): void {
      this.reported.push({ error, message });
   }

   /** Simulate the host tearing the transport down — an LS restart. */
   fireDispose(): void {
      this.disposeEmitter.fire(undefined);
   }

   dispose(): void {
      this.disposeEmitter.dispose();
      for (const pair of this.connections) {
         pair.dispose();
      }
   }
}

/** A `DataClientProtocol` that captures, which is what a widget's would do first. */
function makeCapturingClient(): {
   client: DataClientProtocol<OrderFlowTransferRoot>;
   updates: TransferDocumentUpdatedEvent<OrderFlowTransferRoot>[];
} {
   const updates: TransferDocumentUpdatedEvent<OrderFlowTransferRoot>[] = [];
   const client: DataClientProtocol<OrderFlowTransferRoot> = {
      onDocumentUpdated(event: TransferDocumentUpdatedEvent<OrderFlowTransferRoot>): void {
         updates.push(event);
      },
      onDocumentSaved(_event: TransferDocumentSavedEvent<OrderFlowTransferRoot>): void {
         // Not this suite's subject; the save path is covered server-side.
      },
      onProjectsChanged(): void {
         // Likewise.
      }
   };
   return { client, updates };
}

let workspace: ScratchWorkspace | undefined;
let port: FakeDataPort | undefined;
let session: DataSession<OrderFlowTransferRoot> | undefined;
let updates: TransferDocumentUpdatedEvent<OrderFlowTransferRoot>[] = [];

/** URI of a workspace-relative path inside the scratch copy — what the wire carries. */
function uriOf(relativePath: string): string {
   if (!workspace) {
      throw new Error('scratch workspace not seeded');
   }
   return workspace.uri(relativePath);
}

/** Current on-disk text of a scratch file. */
function diskText(relativePath: string): string {
   if (!workspace) {
      throw new Error('scratch workspace not seeded');
   }
   return readFileSync(workspace.resolve(relativePath), 'utf8');
}

describe('order-flow data port', () => {
   beforeEach(async () => {
      // A throwaway copy, because the integrity service's default silent mode
      // persists its repairs, so a write test aimed at the committed workspace
      // would rewrite it.
      workspace = makeScratchWorkspace({ seed: WORKSPACE_ROOT, prefix: 'order-flow-port-' });
      const { shared } = createOrderFlowServices({ ...NodeFileSystem });
      await initializeWorkspaceProgrammatically(shared, workspace.root);

      port = new FakeDataPort(channel => {
         // The server registers its handlers on the channel in its
         // constructor; nothing else needs the instance.
         void new DataServer<OrderFlowTransferRoot>(channel, shared);
      });
      const capturing = makeCapturingClient();
      updates = capturing.updates;
      session = new DataSession<OrderFlowTransferRoot>(port, capturing.client);
   });

   afterEach(() => {
      session?.dispose();
      session = undefined;
      port?.dispose();
      port = undefined;
      workspace?.dispose();
      workspace = undefined;
      updates = [];
   });

   it('reaches a ready server through the port and answers a typed request', async () => {
      const server = await session!.connected();

      // Asserting the CONTENT is what proves the readiness gate did its job:
      // a client that connects before the workspace walk finishes gets a
      // correct answer from an EMPTY registry, which is indistinguishable from
      // a broken project tier unless the projects are named.
      const projects = await server.getProjects();
      expect(projects.map(project => project.id).sort()).toEqual(['commerce-core', 'orders']);
   });

   it('shares one connection across concurrent callers', async () => {
      await Promise.all([session!.connected(), session!.connected(), session!.connected()]);

      // The readiness promise is per-generation, not per-call, so three
      // concurrent callers must not open three transports.
      expect(port!.connections).toHaveLength(1);
   });

   it('opens a document and returns its transfer root', async () => {
      const document = await session!.openDocument(uriOf(FULFILLMENT_PROCESS));

      expect(document.uri).toBe(uriOf(FULFILLMENT_PROCESS));
      expect(document.root?.$type).toBe('ProcessModel');
      expect((document.root as ProcessModel).name).toBe('Fulfillment');
   });

   it('does not deliver a spurious update for merely opening a cold document', async () => {
      // The assertion that pins the open-then-watch ORDER, and the reason
      // `openDocument` exists. Watching first registers the watch but leaves no
      // dedup baseline, so the next phase event arrives as a `'changed'` that
      // no one changed — which a widget resetting its root to the server view
      // reads as a concurrent write, discarding whatever the user had typed.
      //
      // **It has to be a COLD document, and that is not a detail.** The
      // baseline is taken from `LangiumDocuments.getDocument`, so for any file
      // the initial workspace build already loaded the baseline is available
      // whichever order the two calls go in, and the wrong order is harmless.
      // Written against a warm workspace file this test passes with the order
      // deliberately reversed — measured, not assumed — so it would have read
      // as coverage of a path it never reached. A file created after
      // initialization is the case that discriminates, and it is also the real
      // one: it is what a form hits opening a document the workspace walk
      // never saw.
      //
      // Nothing about the wrong order errors, so the absence of the event is
      // the only observable. Note the spurious event even carries this
      // session's own `clientId` as `sourceClientId`, so echo filtering does
      // not save a widget from it.
      const coldRelative = 'orders/probe.process';
      writeFileSync(workspace!.resolve(coldRelative), 'process Probe for Order {\n   task Only reads Order.id\n}\n');
      const uri = uriOf(coldRelative);

      await session!.openDocument(uri);

      // Let the build the open triggered settle and publish. Asserting
      // immediately would pass for the wrong reason.
      await new Promise(resolve => setTimeout(resolve, 300));

      expect(updates.map(event => `${event.reason} by ${event.sourceClientId}`)).toEqual([]);
   });

   it('delivers a third-party update to the watching client', async () => {
      // The load-bearing assertion of the suite: it can only pass if
      // `openDocument` actually established the watch, and the watch is the
      // half of the open sequence that fails silently when ordered wrongly.
      const uri = uriOf(FULFILLMENT_PROCESS);
      await session!.openDocument(uri);

      const server = await session!.connected();
      await server.updateModelDocument({
         uri,
         clientId: THIRD_PARTY,
         model: `${diskText(FULFILLMENT_PROCESS)}\n`.replace('task Pay ', 'task Pay2 ')
      });

      await waitFor(() => updates.length >= 1, { message: `no onDocumentUpdated for ${uri}` });
      const event = updates[updates.length - 1];
      expect(event.document.uri).toBe(uri);
      expect(event.sourceClientId).toBe(THIRD_PARTY);
      expect(session!.isOwnEcho(event.sourceClientId)).toBe(false);
   });

   it('recognises its own write as an echo', async () => {
      const uri = uriOf(FULFILLMENT_PROCESS);
      await session!.openDocument(uri);

      const server = await session!.connected();
      await server.updateModelDocument({
         uri,
         clientId: session!.clientId,
         model: `${diskText(FULFILLMENT_PROCESS)}\n`.replace('task Ship ', 'task Ship2 ')
      });

      await waitFor(() => updates.length >= 1, { message: `no onDocumentUpdated for ${uri}` });
      const event = updates[updates.length - 1];
      expect(event.sourceClientId).toBe(session!.clientId);
      expect(session!.isOwnEcho(event.sourceClientId)).toBe(true);
   });

   it('builds a fresh connection after the host tears the transport down', async () => {
      await session!.connected();
      expect(port!.connections).toHaveLength(1);

      // An LS restart: the old ports are dead and nothing re-discovers them. A
      // build-once guard that hands back the original connection forever, and
      // exposes no dispose, wedges the client against a server that is gone —
      // which is why a port has to be able to rebuild, and what the framework's
      // own `reconnect` option turns on for its Theia channel.
      port!.fireDispose();

      const server = await session!.connected();
      expect(port!.connections).toHaveLength(2);

      // A rebuilt generation has to be a WORKING one, not merely a second
      // object: asserting the count alone would pass for a connection that
      // opened and answered nothing.
      const projects = await server.getProjects();
      expect(projects.map(project => project.id).sort()).toEqual(['commerce-core', 'orders']);
   });

   it('reports a failed readiness handshake through the port and retries after it', async () => {
      // A port whose first connection is dead: the session must surface that
      // through `reportError` rather than leaving a request pending forever,
      // and must not cache the rejection.
      const deadPort = new FakeDataPort(() => {
         // Attach no server, so nothing answers under any namespace.
      });
      const capturing = makeCapturingClient();
      const failing = new DataSession<OrderFlowTransferRoot>(deadPort, capturing.client, {
         methodNamespace: 'wrong-namespace/'
      });
      try {
         // Nothing binds the wrong namespace, so the request is rejected as an
         // unhandled method rather than hanging.
         await expect(failing.connected()).rejects.toThrow();
         // The CODE, not the English: the code is the contract an adopter's
         // catalogue keys on, while the default text is a fallback that may be
         // reworded without breaking anyone.
         expect(deadPort.reported.map(entry => entry.message.code)).toContain(DATA_SERVER_NOT_READY.code);

         // The retry half, which is what "and retries after it" claims: a
         // session that memoised the rejected promise would re-reject off the
         // cached value and build no second connection, so the port's
         // connection count is what distinguishes the two.
         await expect(failing.connected()).rejects.toThrow();
         expect(deadPort.connections).toHaveLength(2);
      } finally {
         failing.dispose();
         deadPort.dispose();
      }
   });

   it('refuses use after dispose', async () => {
      session!.dispose();
      await expect(session!.connected()).rejects.toThrow(/disposed/);
   });
});
