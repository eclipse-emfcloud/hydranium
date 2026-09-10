/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * The document-scoped properties model, against a real data server.
 *
 * This suite drives the data head the way a form does: read a root, mutate a
 * field, write the whole root back under a `baseVersion`, and reconcile when
 * that gate fires. Two paths are reachable only from a client of this shape.
 *
 * - **The typed transfer write.** A form holds a root and not text, so it takes
 *   `updateModelDocument`'s `model: T` branch rather than the string one — and
 *   the two leave an identical document behind, which is why the typed-write
 *   test reads the wire instead of the result.
 * - **`reconcileByPatchReplay` from a form.** The framework's other reconcile
 *   caller is the GLSP recording command; a form's save is the second one, so
 *   the merge and the same-field collision are exercised here rather than only
 *   through GLSP.
 *
 * **Why two wirings of the same objects.** The conflict tests construct the
 * model over a `DataEvents` that nothing fires into, which pins its
 * baseline. That is not a mock: it is the state a real panel is in between its
 * last refresh and its next push, and it is the only way to make the stale-write
 * deterministic — driving it through the live subscription would race the
 * server's notification against the test's next request, so the conflict would
 * appear or not depending on delivery order. A separate test uses the wired
 * events object and asserts that following actually works.
 */

import { initializeWorkspaceProgrammatically } from '@hydranium/core';
import { NodeFileSystem } from '@hydranium/core/lib/node';
import { type ScratchWorkspace, makeScratchWorkspace } from '@hydranium/core/lib/testing/node';
import { DataServer } from '@hydranium/data-server';
import { DataEvents, DataSession, TransferDocument, type DataPort } from '@hydranium/protocol';
import { waitFor } from '@hydranium/protocol/lib/testing';
import { type DuplexConnectionPair, makeDuplexConnectionPair } from '@hydranium/protocol/lib/testing/node';
import { createOrderFlowServices } from '@hydranium/example-order-flow-server/lib/language-server/order-flow-module';
import type {
   DomainModel,
   LayoutModel,
   ProcessModel
} from '@hydranium/example-order-flow-server/lib/language-server/generated-hydranium/transfer-model';
import * as path from 'node:path';
import { Emitter, type Event, type MessageConnection } from 'vscode-jsonrpc';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OrderFlowPropertiesModel } from '../src/data/order-flow-properties-model';

type OrderFlowTransferRoot = DomainModel | LayoutModel | ProcessModel;

const WORKSPACE_ROOT = path.resolve(__dirname, '../../workspace');
const FULFILLMENT_PROCESS = 'orders/fulfillment.process';
const THIRD_PARTY = 'some-other-editor';

/** One outbound request, as it went onto the wire. */
interface SentRequest {
   readonly method: string;
   readonly params: unknown;
}

/**
 * The client connection with its outbound requests recorded.
 *
 * Needed because the shape of the `model` payload is invisible from the
 * outside: a string and a transfer root both round-trip and both leave the same
 * document behind, so an assertion on the re-read document cannot tell them
 * apart. Reading the wire is what lets the typed-write test pin the branch it
 * claims to cover instead of merely executing it.
 */
function recordingConnection(connection: MessageConnection, sent: SentRequest[]): MessageConnection {
   return new Proxy(connection, {
      get(target, property, receiver): unknown {
         if (property === 'sendRequest') {
            return (method: string, params: unknown): Promise<unknown> => {
               sent.push({ method, params });
               return connection.sendRequest(method, params);
            };
         }
         const value = Reflect.get(target, property, receiver);
         return typeof value === 'function' ? value.bind(target) : value;
      }
   });
}

/** Minimal port over the framework's in-process duplex pair. */
class FakeDataPort implements DataPort {
   readonly clientId = 'order-flow-properties';
   readonly connections: DuplexConnectionPair[] = [];
   /** Every outbound request across every generation, in send order. */
   readonly sent: SentRequest[] = [];
   protected readonly disposeEmitter = new Emitter<void>();
   readonly onDispose: Event<void> = this.disposeEmitter.event;

   constructor(protected readonly attachServer: (channel: MessageConnection) => void) {}

   async connect(): Promise<MessageConnection> {
      const pair = makeDuplexConnectionPair();
      this.connections.push(pair);
      this.attachServer(pair.left);
      return recordingConnection(pair.right, this.sent);
   }

   reportError(): void {
      // Failure reporting is the port test's subject, not this one's.
   }

   dispose(): void {
      this.disposeEmitter.dispose();
      for (const pair of this.connections) {
         pair.dispose();
      }
   }
}

let workspace: ScratchWorkspace | undefined;
let port: FakeDataPort | undefined;
let events: DataEvents<OrderFlowTransferRoot> | undefined;
let session: DataSession<OrderFlowTransferRoot> | undefined;
const models: OrderFlowPropertiesModel<OrderFlowTransferRoot>[] = [];

function uriOf(relativePath: string): string {
   if (!workspace) {
      throw new Error('scratch workspace not seeded');
   }
   return workspace.uri(relativePath);
}

/**
 * A model following the live connection — the normal wiring.
 */
function followingModel(): OrderFlowPropertiesModel<OrderFlowTransferRoot> {
   const model = new OrderFlowPropertiesModel<OrderFlowTransferRoot>(session!, events!);
   models.push(model);
   return model;
}

/**
 * A model whose baseline is pinned, because its events object is not the one
 * bound to the connection. See the suite doc for why this is the honest way to
 * make a stale write deterministic.
 */
function pinnedModel(): OrderFlowPropertiesModel<OrderFlowTransferRoot> {
   const model = new OrderFlowPropertiesModel<OrderFlowTransferRoot>(session!, new DataEvents<OrderFlowTransferRoot>());
   models.push(model);
   return model;
}

/** Write `root` as a third party, ungated, so it always lands. */
async function thirdPartyWrite(uri: string, root: OrderFlowTransferRoot): Promise<void> {
   const server = await session!.connected();
   await server.updateModelDocument({ uri, clientId: THIRD_PARTY, model: root });
}

describe('order-flow properties model', () => {
   beforeEach(async () => {
      workspace = makeScratchWorkspace({ seed: WORKSPACE_ROOT, prefix: 'order-flow-props-' });
      const { shared } = createOrderFlowServices({ ...NodeFileSystem });
      await initializeWorkspaceProgrammatically(shared, workspace.root);

      port = new FakeDataPort(channel => {
         void new DataServer<OrderFlowTransferRoot>(channel, shared);
      });
      events = new DataEvents<OrderFlowTransferRoot>();
      session = new DataSession<OrderFlowTransferRoot>(port, events);
   });

   afterEach(() => {
      for (const model of models) {
         model.dispose();
      }
      models.length = 0;
      session?.dispose();
      session = undefined;
      events?.dispose();
      events = undefined;
      port?.dispose();
      port = undefined;
      workspace?.dispose();
      workspace = undefined;
   });

   it('presents the root string properties as editable fields', async () => {
      const model = followingModel();
      await model.open(uriOf(FULFILLMENT_PROCESS));

      // Derived from the root, so this asserts what the transfer shape actually
      // offers: `name` plus `subject`, whose transfer form is the reference
      // TEXT. `nodes` and `transitions` are arrays and are correctly absent.
      expect(model.fields).toEqual([
         { name: 'name', value: 'Fulfillment' },
         { name: 'subject', value: 'Order' }
      ]);
      expect(model.version).toEqual(expect.any(Number));
   });

   it('reports diagnostics for a document that is only opened, never edited', async () => {
      // A **pinned** model, and that is the whole test rather than a detail: its
      // events object is not the one bound to the connection, so no server push
      // can deliver diagnostics. The only way they can appear is if `open`
      // itself fetched them. A following model would pass the moment any phase
      // event happened to arrive, which is exactly the false green this suite's
      // header warns about.
      //
      // `audit-leak.domain` carries a deliberate unresolved reference in the
      // checked-in fixture, so nothing has to be mutated to produce a
      // diagnostic — and `DomainModel` has no string-valued own property, which
      // pins that diagnostics are independent of whether there are any fields.
      const model = pinnedModel();
      await model.open(uriOf('orders/audit-leak.domain'));

      expect(model.fields).toEqual([]);
      expect(model.diagnostics.map(diagnostic => diagnostic.message).join('\n')).toContain('AuditStamp');
   });

   it('writes a field back as a typed transfer root', async () => {
      const model = followingModel();
      const uri = uriOf(FULFILLMENT_PROCESS);
      await model.open(uri);

      const outcome = await model.setField('name', 'Fulfilment');
      expect(outcome).toEqual({ status: 'applied' });

      // Read the WIRE, because this is the assertion the suite exists for. A
      // string payload would leave an identical document behind, so only the
      // sent params distinguish the typed branch from the textual one.
      const update = port!.sent.find(request => request.method.endsWith('updateModelDocument'));
      const sentModel = (update?.params as { model?: unknown } | undefined)?.model;
      expect(typeof sentModel).toBe('object');
      expect(sentModel).toMatchObject({ $type: 'ProcessModel', name: 'Fulfilment' });

      // And the server really reparsed it, which only a fresh read can show.
      const server = await session!.connected();
      const reread = await server.getModelDocument({ uri });
      expect((reread.root as ProcessModel).name).toBe('Fulfilment');
      expect(model.fields.find(field => field.name === 'name')?.value).toBe('Fulfilment');
   });

   it('reports an unchanged write without sending it', async () => {
      const model = followingModel();
      await model.open(uriOf(FULFILLMENT_PROCESS));
      const before = model.version;

      expect(await model.setField('name', 'Fulfillment')).toEqual({ status: 'unchanged' });
      expect(model.version).toBe(before);
   });

   it('rejects a field the root does not offer', async () => {
      const model = followingModel();
      await model.open(uriOf(FULFILLMENT_PROCESS));

      await expect(model.setField('nodes', 'nope')).rejects.toThrow(/not an editable field/);
   });

   it('does not fire a second change for its own echo', async () => {
      // What echo filtering actually buys a properties view. The echo's CONTENT
      // equals the write response the model already adopted, so no assertion on
      // the fields can catch it — the observable is the extra change event, and
      // an extra change is a re-render, which is the "the field resets while I
      // am typing" bug.
      const model = followingModel();
      const uri = uriOf(FULFILLMENT_PROCESS);
      await model.open(uri);

      let changes = 0;
      model.onDidChange(() => {
         changes++;
      });

      expect(await model.setField('name', 'Fulfilment')).toEqual({ status: 'applied' });

      // Let every push the write provoked arrive. Asserting immediately would
      // pass whether or not the echo is filtered.
      await new Promise(resolve => setTimeout(resolve, 300));

      // An ABSOLUTE count, not a delta measured after the write. The phase
      // event fires while the update response is still in flight, so a delta
      // captured after `setField` returns has already absorbed the echo and
      // compares post-echo against post-echo — which passes with the filter
      // deliberately removed. Measured, not assumed.
      expect(changes).toBe(1);
      expect(model.fields.find(field => field.name === 'name')?.value).toBe('Fulfilment');
   });

   it('follows a third-party write without one of its own', async () => {
      const model = followingModel();
      const uri = uriOf(FULFILLMENT_PROCESS);
      await model.open(uri);

      let changes = 0;
      model.onDidChange(() => {
         changes++;
      });

      const foreign = (await currentRoot(uri)) as ProcessModel;
      await thirdPartyWrite(uri, { ...foreign, name: 'RenamedByOther' });

      await waitFor(() => model.fields.find(field => field.name === 'name')?.value === 'RenamedByOther', {
         message: 'the model never picked up the third-party rename'
      });
      expect(changes).toBeGreaterThan(0);
   });

   it('merges a write that raced a foreign edit to a different field', async () => {
      const uri = uriOf(FULFILLMENT_PROCESS);
      const model = pinnedModel();
      await model.open(uri);

      // Foreign writer touches `subject`; the pinned model still holds the
      // pre-write version, so its own write to `name` trips the gate.
      const foreign = (await currentRoot(uri)) as ProcessModel;
      await thirdPartyWrite(uri, { ...foreign, subject: 'LineItem' });

      expect(await model.setField('name', 'Fulfilment')).toEqual({ status: 'merged' });

      // Both intents have to survive — that is what distinguishes a merge from
      // a clobber, and asserting only the status would pass for either.
      const server = await session!.connected();
      const reread = (await server.getModelDocument({ uri })).root as ProcessModel;
      expect(reread.name).toBe('Fulfilment');
      expect(reread.subject).toBe('LineItem');
   });

   it('drops a write that raced a foreign edit to the same field', async () => {
      const uri = uriOf(FULFILLMENT_PROCESS);
      const model = pinnedModel();
      await model.open(uri);

      const foreign = (await currentRoot(uri)) as ProcessModel;
      await thirdPartyWrite(uri, { ...foreign, name: 'WonByTheOtherWriter' });

      expect(await model.setField('name', 'Fulfilment')).toEqual({ status: 'conflict' });

      // The foreign value stands on disk AND the panel now shows it, rather
      // than leaving a stale field the user would write again.
      const server = await session!.connected();
      const reread = (await server.getModelDocument({ uri })).root as ProcessModel;
      expect(reread.name).toBe('WonByTheOtherWriter');
      expect(model.fields.find(field => field.name === 'name')?.value).toBe('WonByTheOtherWriter');
   });

   it('closes the document and clears its fields', async () => {
      const model = followingModel();
      await model.open(uriOf(FULFILLMENT_PROCESS));
      expect(model.fields).not.toEqual([]);

      await model.close();

      expect(model.uri).toBeUndefined();
      expect(model.fields).toEqual([]);
   });

   it('refuses use after dispose', async () => {
      const model = followingModel();
      model.dispose();

      await expect(model.open(uriOf(FULFILLMENT_PROCESS))).rejects.toThrow(/disposed/);
   });
});

/** The server's current root for `uri`, as a foreign writer would read it. */
async function currentRoot(uri: string): Promise<OrderFlowTransferRoot> {
   const server = await session!.connected();
   return TransferDocument.assertLoaded(await server.getModelDocument({ uri })).root;
}
