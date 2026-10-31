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
 * base. That is not a mock: it is the state a real panel is in between its
 * last refresh and its next push, and it is the only way to make the stale-write
 * deterministic — driving it through the live subscription would race the
 * server's notification against the test's next request, so the conflict would
 * appear or not depending on delivery order. A separate test uses the wired
 * events object and asserts that following actually works.
 */

import { initializeWorkspaceProgrammatically, type ServerSharedServices } from '@hydranium/core';
import { HydraniumDocumentUpdateHandler } from '@hydranium/core/lsp';
import { NodeFileSystem } from '@hydranium/core/node';
import {
   type LspHarness,
   makeLspHarness,
   makeLspServerConnection,
   type ScratchWorkspace,
   makeScratchWorkspace
} from '@hydranium/core/testing/node';
import { DataServer } from '@hydranium/data-server';
import {
   type Clock,
   DataConnection,
   DataEvents,
   Deferred,
   isConflictError,
   type DataSession,
   TransferDocument,
   type DataPort,
   type TransferDocumentUpdatedEvent
} from '@hydranium/protocol';
import { makeFakeClock, tick, waitFor } from '@hydranium/protocol/testing';
import { type DuplexConnectionPair, makeDuplexConnectionPair } from '@hydranium/protocol/testing/node';
import { createOrderFlowServices } from '@hydranium/example-order-flow-server/lib/language-server/order-flow-module';
import type { DomainModel, LayoutModel, ProcessModel } from '@hydranium/example-order-flow-protocol';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { Emitter, type Event, type MessageConnection } from 'vscode-jsonrpc';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OrderFlowPropertiesModel, type PropertyField, type SetFieldOutcome } from '../src/data/order-flow-properties-model';
import { PropertiesDocuments } from '../src/properties/properties-documents';
import { thirdPartyWrite as writeAsThirdParty } from './testing/third-party-write.js';

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
/** The server's own services, for driving a deletion the protocol cannot request. */
let sharedServices: ReturnType<typeof createOrderFlowServices>['shared'] | undefined;
let port: FakeDataPort | undefined;
let events: DataEvents<OrderFlowTransferRoot> | undefined;
let connection: DataConnection<OrderFlowTransferRoot> | undefined;
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
function followingModel(uri: string): OrderFlowPropertiesModel<OrderFlowTransferRoot> {
   const model = new OrderFlowPropertiesModel<OrderFlowTransferRoot>(session!, events!, uri);
   models.push(model);
   return model;
}

/**
 * A model whose base is pinned, because its events object is not the one
 * bound to the connection. See the suite doc for why this is the honest way to
 * make a stale write deterministic.
 */
function pinnedModel(uri: string): OrderFlowPropertiesModel<OrderFlowTransferRoot> {
   const model = new OrderFlowPropertiesModel<OrderFlowTransferRoot>(session!, new DataEvents<OrderFlowTransferRoot>(), uri);
   models.push(model);
   return model;
}

/** `target`, with `afterRead` awaited after each `getModelDocument` of its server answers. */
function refetchIntercepting<TSession extends DataSession<OrderFlowTransferRoot>>(
   target: TSession,
   afterRead: () => Promise<void>
): TSession {
   return new Proxy(target, {
      get(sessionTarget, property, receiver): unknown {
         if (property === 'connected') {
            return async (): Promise<unknown> => {
               const server = await sessionTarget.connected();
               return new Proxy(server, {
                  get(serverTarget, serverProperty, serverReceiver): unknown {
                     if (serverProperty === 'getModelDocument') {
                        return async (args: Parameters<typeof serverTarget.getModelDocument>[0]): Promise<unknown> => {
                           const document = await serverTarget.getModelDocument(args);
                           await afterRead();
                           return document;
                        };
                     }
                     const value = Reflect.get(serverTarget, serverProperty, serverReceiver);
                     return typeof value === 'function' ? value.bind(serverTarget) : value;
                  }
               });
            };
         }
         const value = Reflect.get(sessionTarget, property, receiver);
         return typeof value === 'function' ? value.bind(sessionTarget) : value;
      }
   });
}

/** Write `root` as a third party, ungated, so it always lands. */
async function thirdPartyWrite(uri: string, root: OrderFlowTransferRoot): Promise<void> {
   const server = await session!.connected();
   await writeAsThirdParty(server, THIRD_PARTY, uri, root);
}

/** Write `text` as a third party, ungated: a change the transfer model cannot express. */
async function thirdPartyText(uri: string, text: string): Promise<void> {
   const server = await session!.connected();
   await writeAsThirdParty(server, THIRD_PARTY, uri, text);
}

describe('order-flow properties model', () => {
   beforeEach(async () => {
      workspace = makeScratchWorkspace({ seed: WORKSPACE_ROOT, prefix: 'order-flow-props-' });
      const { shared } = createOrderFlowServices({ ...NodeFileSystem });
      sharedServices = shared;
      await initializeWorkspaceProgrammatically(shared, workspace.root);

      port = new FakeDataPort(channel => {
         void new DataServer<OrderFlowTransferRoot>(channel, shared);
      });
      events = new DataEvents<OrderFlowTransferRoot>();
      connection = new DataConnection<OrderFlowTransferRoot>(port, events);
      const dataSession = connection.createSession('order-flow-model-test');
      session = dataSession;
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
      sharedServices = undefined;
      workspace?.dispose();
      workspace = undefined;
   });

   it('presents the root string properties as editable fields', async () => {
      const model = followingModel(uriOf(FULFILLMENT_PROCESS));
      await model.open();

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
      const model = pinnedModel(uriOf('orders/audit-leak.domain'));
      await model.open();

      expect(model.fields).toEqual([]);
      expect(model.diagnostics.map(diagnostic => diagnostic.message).join('\n')).toContain('AuditStamp');
   });

   it("reports diagnostics for the client's OWN edit", async () => {
      // The counterpart to the test above: a document the client broke itself
      // must report the breakage, not read as clean. Without it the panel is
      // trustworthy about validity only for documents nobody has touched, which
      // is the half that matters least.
      //
      // **It does not pin WHICH delivery supplies them, and that was measured
      // rather than assumed.** With `handleDocumentUpdated` made a no-op the
      // test still passes, because the write's own response already carries
      // them — so this covers the user-visible property and not the
      // subscription. The `waitFor` is therefore a tolerance, not the subject:
      // it also passes if a later push is what fills them in.
      const model = followingModel(uriOf(FULFILLMENT_PROCESS));
      await model.open();
      expect(model.diagnostics).toEqual([]);

      await model.setField('subject', 'NoSuchEntity');

      await waitFor(() => model.diagnostics.length > 0, { message: "diagnostics never arrived for the client's own edit" });
      expect(model.diagnostics.map(diagnostic => diagnostic.message).join('\n')).toContain('NoSuchEntity');
   });

   it('writes a field back as a typed transfer root', async () => {
      const uri = uriOf(FULFILLMENT_PROCESS);
      const model = followingModel(uri);
      await model.open();

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
      expect((reread.model!.root as ProcessModel).name).toBe('Fulfilment');
      expect(model.fields.find(field => field.name === 'name')?.value).toBe('Fulfilment');
   });

   it('reports a conflict for a field edit made while the write before it is out, when the server trimmed that write', async () => {
      const uri = uriOf(FULFILLMENT_PROCESS);
      const model = followingModel(uri);
      await model.open();
      // Made as the first write goes out, so its answer cannot be in yet.
      let second: Promise<SetFieldOutcome> | undefined;
      const update = session!.updateDocument.bind(session!);
      vi.spyOn(session!, 'updateDocument').mockImplementationOnce(params => {
         const sent = update(params);
         second = model.setField('name', 'Fulfilment2');
         return sent;
      });
      const first = model.setField('name', 'Fulfilment ');
      await waitFor(() => second !== undefined);
      // The answer does not say whether it holds another write too, so the
      // edit is reconciled against it, and the trimmed value collides.
      expect([await first, await second]).toEqual([{ status: 'applied' }, { status: 'conflict' }]);
      const reread = await (await session!.connected()).getModelDocument({ uri });
      expect((reread.model!.root as ProcessModel).name).toBe('Fulfilment');
   });

   it('reports an unchanged write without sending it', async () => {
      const model = followingModel(uriOf(FULFILLMENT_PROCESS));
      await model.open();
      const before = model.version;

      expect(await model.setField('name', 'Fulfillment')).toEqual({ status: 'unchanged' });
      expect(model.version).toBe(before);
   });

   it('rejects a field the root does not offer', async () => {
      const model = followingModel(uriOf(FULFILLMENT_PROCESS));
      await model.open();

      await expect(model.setField('nodes', 'nope')).rejects.toThrow(/not an editable field/);
   });

   it('opens dirty on a document another client holds unsaved', async () => {
      const uri = uriOf(FULFILLMENT_PROCESS);
      const other = sharedServices!.model.ModelService.createSession('other');
      await other.open(uri);
      await other.update({ uri, model: `${sharedServices!.workspace.TextDocuments.get(uri)!.getText()}\n`, baseVersion: 'any' });
      // Pinned, so only what the open read can make it dirty.
      const model = pinnedModel(uri);

      await model.open();

      expect(model.dirty).toBe(true);
   });

   it("follows the document's dirty state through its own write and then another client's save", async () => {
      const uri = uriOf(FULFILLMENT_PROCESS);
      const model = followingModel(uri);
      await model.open();
      const flips: boolean[] = [];
      model.onDidChangeDirty(() => flips.push(model.dirty));
      expect(model.dirty).toBe(false);

      await model.setField('name', 'Fulfilment');
      expect(model.dirty).toBe(true);
      const other = sharedServices!.model.ModelService.createSession('other');
      await other.open(uri);
      await other.save({ uri, model: sharedServices!.workspace.TextDocuments.get(uri)!.getText(), baseVersion: 'any' });

      await waitFor(() => !model.dirty, { message: 'the save by another client never reached the model' });
      expect(flips).toEqual([true, false]);
   });

   it("shows its edit in every change it fires, the write's answer included", async () => {
      // A change that showed the old value would reset the field the user is
      // typing in. The edit fires one change and the write's answer another.
      const uri = uriOf(FULFILLMENT_PROCESS);
      const model = followingModel(uri);
      await model.open();

      const shown: (string | undefined)[] = [];
      model.onDidChange(() => {
         shown.push(model.fields.find(field => field.name === 'name')?.value);
      });

      expect(await model.setField('name', 'Fulfilment')).toEqual({ status: 'applied' });

      // Let every push the write provoked arrive.
      await new Promise(resolve => setTimeout(resolve, 300));

      expect(shown).toEqual(['Fulfilment', 'Fulfilment']);
   });

   it('follows a third-party write without one of its own', async () => {
      const uri = uriOf(FULFILLMENT_PROCESS);
      const model = followingModel(uri);
      await model.open();

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

   it("takes a third party's comment-only edit's version without re-rendering", async () => {
      const uri = uriOf(FULFILLMENT_PROCESS);
      const model = followingModel(uri);
      await model.open();
      const opened = model.version;

      let changes = 0;
      model.onDidChange(() => {
         changes++;
      });

      const text = sharedServices!.workspace.TextDocuments.get(uri)!.getText();
      await thirdPartyText(uri, `${text}\n// a comment\n`);

      await waitFor(() => model.version !== opened, { message: 'the model never took the new version' });
      expect({ changes, dirty: model.dirty }).toEqual({ changes: 0, dirty: true });
   });

   it('re-renders an unchanged-model update over a model it missed the change to', async () => {
      const relay = new DataEvents<OrderFlowTransferRoot>();
      const uri = uriOf(FULFILLMENT_PROCESS);
      const model = new OrderFlowPropertiesModel<OrderFlowTransferRoot>(session!, relay, uri);
      models.push(model);
      await model.open();
      let changes = 0;
      model.onDidChange(() => {
         changes++;
      });
      const updates: TransferDocumentUpdatedEvent<OrderFlowTransferRoot>[] = [];
      events!.onDidUpdateDocument(event => updates.push(event));
      // The comment-only edit's update: the model of the update before it, at a newer version.
      const commentOnly = (): TransferDocumentUpdatedEvent<OrderFlowTransferRoot> | undefined =>
         updates.find((event, index) => {
            const previous = updates[index - 1]?.document.model;
            const current = event.document.model;
            return previous !== undefined && current?.hash === previous.hash && current.version > previous.version;
         });

      // The rename never reaches the model, as one sent while it was offline.
      const foreign = (await currentRoot(uri)) as ProcessModel;
      await thirdPartyWrite(uri, { ...foreign, name: 'RenamedByOther' });
      const text = sharedServices!.workspace.TextDocuments.get(uri)!.getText();
      await thirdPartyText(uri, `${text}\n// a comment\n`);
      await waitFor(() => commentOnly() !== undefined, { message: 'the comment-only edit sent no unchanged-model update' });
      relay.onDocumentUpdated(commentOnly()!);

      expect(model.fields.find(field => field.name === 'name')?.value).toBe('RenamedByOther');
      expect(changes).toBe(1);
      relay.dispose();
   });

   it('clears its fields when the open document is deleted', async () => {
      const uri = uriOf(FULFILLMENT_PROCESS);
      const model = followingModel(uri);
      await model.open();
      expect(model.fields.length).toBeGreaterThan(0);

      // Driven through the builder, not the protocol: a deletion originates at
      // the filesystem, and there is no request a client could send to cause
      // one. This is the client half of what the server suite pins. The URI
      // object comes from the workspace rather than a `URI.parse` here, because
      // this package deliberately does not depend on Langium.
      const documents = sharedServices!.workspace.LangiumDocuments;
      const open = documents.all.find((document: { uri: { toString(): string } }) => document.uri.toString() === uri);
      await sharedServices!.workspace.DocumentBuilder.update([], [open!.uri]);

      await waitFor(() => model.fields.length === 0, {
         message: 'the model kept its fields after the document was deleted'
      });
      expect(model.snapshot).toBeUndefined();
   });

   it('merges a write that raced a foreign edit to a different field', async () => {
      const uri = uriOf(FULFILLMENT_PROCESS);
      const model = pinnedModel(uri);
      await model.open();

      // Foreign writer touches `subject`; the pinned model still holds the
      // pre-write version, so its own write to `name` trips the gate.
      const foreign = (await currentRoot(uri)) as ProcessModel;
      await thirdPartyWrite(uri, { ...foreign, subject: 'LineItem' });

      expect(await model.setField('name', 'Fulfilment')).toEqual({ status: 'merged' });

      // Both intents have to survive — that is what distinguishes a merge from
      // a clobber, and asserting only the status would pass for either.
      const server = await session!.connected();
      const reread = (await server.getModelDocument({ uri })).model?.root as ProcessModel;
      expect(reread.name).toBe('Fulfilment');
      expect(reread.subject).toBe('LineItem');
   });

   it('merges again when a foreign edit lands between the refetch and the merged write', async () => {
      const uri = uriOf(FULFILLMENT_PROCESS);
      let landBetween: (() => Promise<void>) | undefined;
      const model = new OrderFlowPropertiesModel<OrderFlowTransferRoot>(
         refetchIntercepting(session!, async () => {
            const write = landBetween;
            landBetween = undefined;
            await write?.();
         }),
         new DataEvents<OrderFlowTransferRoot>(),
         uri
      );
      models.push(model);
      await model.open();

      const foreign = (await currentRoot(uri)) as ProcessModel;
      await thirdPartyWrite(uri, { ...foreign, subject: 'LineItem' });
      landBetween = () => thirdPartyWrite(uri, { ...foreign, subject: 'Customer' });

      expect(await model.setField('name', 'Fulfilment')).toEqual({ status: 'merged' });

      const server = await session!.connected();
      const reread = (await server.getModelDocument({ uri })).model?.root as ProcessModel;
      expect(reread.name).toBe('Fulfilment');
      expect(reread.subject).toBe('Customer');
   });

   it('counts a field edit in flight while it rereads after a conflict, which the session does not', async () => {
      const uri = uriOf(FULFILLMENT_PROCESS);
      const hold = new Deferred<void>();
      let holding = false;
      const rereading = new Deferred<void>();
      const model = new OrderFlowPropertiesModel<OrderFlowTransferRoot>(
         refetchIntercepting(session!, async () => {
            if (holding) {
               rereading.resolve();
               await hold.promise;
            }
         }),
         new DataEvents<OrderFlowTransferRoot>(),
         uri
      );
      models.push(model);
      await model.open();
      const foreign = (await currentRoot(uri)) as ProcessModel;
      await thirdPartyWrite(uri, { ...foreign, subject: 'LineItem' });
      holding = true;

      const written = model.setField('name', 'Fulfilment');
      await rereading.promise;
      expect(session!.hasWritesInFlight).toBe(false);
      expect(model.hasWritesInFlight).toBe(true);

      hold.resolve();
      expect(await written).toEqual({ status: 'merged' });
      expect(model.hasWritesInFlight).toBe(false);
   });

   it('reports a field edit unanswered once its bound passes, and not a moment before', async () => {
      const uri = uriOf(FULFILLMENT_PROCESS);
      const clock = makeFakeClock();
      const hold = new Deferred<void>();
      let holding = false;
      const rereading = new Deferred<void>();
      class ClockedModel extends OrderFlowPropertiesModel<OrderFlowTransferRoot> {
         protected override readonly clock: Clock = clock;
      }
      const model = new ClockedModel(
         refetchIntercepting(session!, async () => {
            if (holding) {
               rereading.resolve();
               await hold.promise;
            }
         }),
         new DataEvents<OrderFlowTransferRoot>(),
         uri
      );
      models.push(model);
      await model.open();
      const foreign = (await currentRoot(uri)) as ProcessModel;
      await thirdPartyWrite(uri, { ...foreign, subject: 'LineItem' });
      holding = true;

      const written = model.setField('name', 'Fulfilment');
      await rereading.promise;
      let settled: boolean | undefined;
      void model.whenWritesSettled().then(result => (settled = result));
      clock.advance(29_999);
      await tick(5);
      expect(settled).toBeUndefined();
      clock.advance(1);
      await waitFor(() => settled !== undefined, { message: 'the wait never gave up' });
      expect(settled).toBe(false);

      hold.resolve();
      await written;
      await expect(model.whenWritesSettled()).resolves.toBe(true);
   });

   it('drops a write that raced a foreign edit to the same field', async () => {
      const uri = uriOf(FULFILLMENT_PROCESS);
      const model = pinnedModel(uri);
      await model.open();

      const foreign = (await currentRoot(uri)) as ProcessModel;
      await thirdPartyWrite(uri, { ...foreign, name: 'WonByTheOtherWriter' });

      expect(await model.setField('name', 'Fulfilment')).toEqual({ status: 'conflict' });

      // The foreign value stands on disk AND the panel now shows it, rather
      // than leaving a stale field the user would write again.
      const server = await session!.connected();
      const reread = (await server.getModelDocument({ uri })).model?.root as ProcessModel;
      expect(reread.name).toBe('WonByTheOtherWriter');
      expect(model.fields.find(field => field.name === 'name')?.value).toBe('WonByTheOtherWriter');
   });

   it('settles a write a foreign writer already made, and takes the version it made it at', async () => {
      const uri = uriOf(FULFILLMENT_PROCESS);
      const model = pinnedModel(uri);
      await model.open();

      const foreign = (await currentRoot(uri)) as ProcessModel;
      await thirdPartyWrite(uri, { ...foreign, name: 'Fulfilment', subject: 'LineItem' });

      expect(await model.setField('name', 'Fulfilment')).toEqual({ status: 'unchanged' });
      expect(model.fields.find(field => field.name === 'subject')?.value).toBe('LineItem');
      // Based on the server's version now, the next write lands first time.
      expect(await model.setField('name', 'Fulfillment')).toEqual({ status: 'applied' });
   });

   it('writes edits made in the same turn as one write', async () => {
      const uri = uriOf(FULFILLMENT_PROCESS);
      const model = followingModel(uri);
      await model.open();

      const outcomes = await Promise.all([model.setField('name', 'Fulfilment'), model.setField('subject', 'LineItem')]);

      expect(outcomes).toEqual([{ status: 'applied' }, { status: 'applied' }]);
      expect(port!.sent.filter(request => request.method.endsWith('updateModelDocument'))).toHaveLength(1);
      const reread = (await currentRoot(uri)) as ProcessModel;
      expect([reread.name, reread.subject]).toEqual(['Fulfilment', 'LineItem']);
   });

   it('shows an edit and counts it as dirty before it is written', async () => {
      const model = followingModel(uriOf(FULFILLMENT_PROCESS));
      await model.open();
      const flips: boolean[] = [];
      model.onDidChangeDirty(() => flips.push(model.dirty));

      const written = model.setField('name', 'Fulfilment');

      expect(model.fields.find(field => field.name === 'name')?.value).toBe('Fulfilment');
      expect(model.dirty).toBe(true);
      expect(port!.sent.some(request => request.method.endsWith('updateModelDocument'))).toBe(false);
      expect(await written).toEqual({ status: 'applied' });
      // Still dirty: the server now holds unsaved text.
      expect(flips).toEqual([true]);
   });

   it('keeps an edit made during a write when that write answers and echoes', async () => {
      const uri = uriOf(FULFILLMENT_PROCESS);
      const model = followingModel(uri);
      await model.open();

      const first = model.setField('name', 'Fulfilment');
      await waitFor(() => port!.sent.some(request => request.method.endsWith('updateModelDocument')));
      const second = model.setField('subject', 'LineItem');

      expect(await first).toEqual({ status: 'applied' });
      expect(model.fields.find(field => field.name === 'subject')?.value).toBe('LineItem');
      expect(await second).toEqual({ status: 'applied' });
      expect(((await currentRoot(uri)) as ProcessModel).subject).toBe('LineItem');
   });

   it('saves its edit to the file', async () => {
      const uri = uriOf(FULFILLMENT_PROCESS);
      const model = followingModel(uri);
      await model.open();

      const written = model.setField('name', 'Fulfilment');
      const saved = await model.save();

      expect(await written).toEqual({ status: 'applied' });
      expect(saved?.persisted.version).toBeDefined();
      expect(model.dirty).toBe(false);
      expect(readFileSync(path.join(workspace!.root, FULFILLMENT_PROCESS), 'utf8')).toContain('process Fulfilment ');
   });

   it("saves another client's unsaved text when it has no edit of its own", async () => {
      const uri = uriOf(FULFILLMENT_PROCESS);
      const other = sharedServices!.model.ModelService.createSession('other');
      await other.open(uri);
      const text = `${sharedServices!.workspace.TextDocuments.get(uri)!.getText()}\n`;
      await other.update({ uri, model: text, baseVersion: 'any' });
      const model = followingModel(uri);
      await model.open();
      expect(model.dirty).toBe(true);

      expect(await model.save()).toBeDefined();

      expect(model.dirty).toBe(false);
      expect(readFileSync(path.join(workspace!.root, FULFILLMENT_PROCESS), 'utf8')).toBe(text);
   });

   it('saves an edit the server already held from another writer', async () => {
      const uri = uriOf(FULFILLMENT_PROCESS);
      const model = pinnedModel(uri);
      await model.open();
      const foreign = (await currentRoot(uri)) as ProcessModel;
      await thirdPartyWrite(uri, { ...foreign, name: 'Fulfilment' });

      expect(await model.setField('name', 'Fulfilment')).toEqual({ status: 'unchanged' });
      expect(await model.save()).toBeDefined();

      expect(readFileSync(path.join(workspace!.root, FULFILLMENT_PROCESS), 'utf8')).toContain('process Fulfilment ');
   });

   it('refuses to save text that moved past what it shows', async () => {
      const uri = uriOf(FULFILLMENT_PROCESS);
      const model = pinnedModel(uri);
      await model.open();
      await model.setField('name', 'Fulfilment');
      const foreign = (await currentRoot(uri)) as ProcessModel;
      await thirdPartyWrite(uri, { ...foreign, subject: 'LineItem' });

      const refusal = await model.save().catch((error: unknown) => error);

      expect(isConflictError(refusal)).toBe(true);
      expect(readFileSync(path.join(workspace!.root, FULFILLMENT_PROCESS), 'utf8')).not.toContain('LineItem');
   });

   it('writes an edit made just before it is disposed', async () => {
      const uri = uriOf(FULFILLMENT_PROCESS);
      const model = followingModel(uri);
      await model.open();

      const written = model.setField('name', 'Fulfilment');
      model.dispose();

      expect(await written).toEqual({ status: 'applied' });
      expect(((await currentRoot(uri)) as ProcessModel).name).toBe('Fulfilment');
   });

   it('closes the document and clears its fields', async () => {
      const model = followingModel(uriOf(FULFILLMENT_PROCESS));
      await model.open();
      expect(model.fields).not.toEqual([]);

      await model.close();

      expect(model.snapshot).toBeUndefined();
      expect(model.fields).toEqual([]);
   });

   it('refuses use after dispose', async () => {
      const model = followingModel(uriOf(FULFILLMENT_PROCESS));
      model.dispose();

      await expect(model.open()).rejects.toThrow(/disposed/);
   });

   describe('shown through PropertiesDocuments', () => {
      const RETURNS_PROCESS = 'orders/returns.process';
      const shown: PropertiesDocuments<OrderFlowTransferRoot>[] = [];

      function showing(
         setLoading: (loading: boolean) => void = () => undefined,
         reportError: (error: unknown) => void = () => undefined,
         form: { setFields?(fields: readonly PropertyField[]): void; setDirty?(dirty: boolean): void } = {},
         retryFailedOpen = false
      ): PropertiesDocuments<OrderFlowTransferRoot> {
         const documents = new (class extends PropertiesDocuments<OrderFlowTransferRoot> {
            protected override readonly retryFailedOpen = retryFailedOpen;
         })(
            session!,
            events!,
            {
               switchDocument: () => undefined,
               setLoading,
               report: () => undefined,
               setFields: fields => form.setFields?.(fields),
               setDiagnostics: () => undefined,
               setDirty: dirty => form.setDirty?.(dirty)
            },
            { reportError, renderMessage: message => message.text }
         );
         shown.push(documents);
         return documents;
      }

      afterEach(async () => {
         await Promise.all(shown.splice(0).map(documents => documents.dispose()));
      });

      it('loads a document shown again while it loads only once', async () => {
         const loads: boolean[] = [];
         const documents = showing(loading => loads.push(loading));
         const uri = uriOf(FULFILLMENT_PROCESS);

         documents.show(uri);
         documents.show(uri);
         await waitFor(() => loads.includes(false));

         expect(loads).toEqual([true, false]);
      });

      it('forgets a document shown before once its close has settled', async () => {
         const documents = new (class extends PropertiesDocuments<OrderFlowTransferRoot> {
            get retiredCount(): number {
               return this.retired.size;
            }
         })(
            session!,
            events!,
            {
               switchDocument: () => undefined,
               setLoading: () => undefined,
               report: () => undefined,
               setFields: () => undefined,
               setDiagnostics: () => undefined,
               setDirty: () => undefined
            },
            { reportError: () => undefined, renderMessage: message => message.text }
         );
         shown.push(documents);
         documents.show(uriOf(FULFILLMENT_PROCESS));
         await waitFor(() => documents.current?.snapshot !== undefined);

         documents.show(uriOf(RETURNS_PROCESS));

         await waitFor(() => documents.retiredCount === 0, { message: 'the document shown before stayed retired' });
      });

      it('keeps the open of a document shown again while its close is under way', async () => {
         const documents = showing();
         const uri = uriOf(FULFILLMENT_PROCESS);
         documents.show(uri);
         await waitFor(() => documents.current?.snapshot !== undefined);

         documents.show(uriOf(RETURNS_PROCESS));
         documents.show(uri);
         await waitFor(() => documents.current?.uri === uri && documents.current.snapshot !== undefined);

         expect(await documents.setField('name', 'ShownAgain')).toEqual({ status: 'applied' });
      });

      it('counts the write of a document shown before until it answers', async () => {
         const documents = showing();
         const uri = uriOf(FULFILLMENT_PROCESS);
         documents.show(uri);
         await waitFor(() => documents.current?.snapshot !== undefined);
         const written = documents.setField('name', 'BeforeSwitch');

         documents.show(uriOf(RETURNS_PROCESS));

         expect(documents.documentsWithWritesInFlight).toEqual([uri]);
         expect(await documents.whenWritesSettled()).toBe(true);
         expect(await written).toEqual({ status: 'applied' });
         expect(documents.documentsWithWritesInFlight).toEqual([]);
      });

      it('ends only once the edit of the document shown has answered', async () => {
         // A host ends the session after this, and a write sent as it ends is never sent.
         const documents = showing();
         const uri = uriOf(FULFILLMENT_PROCESS);
         documents.show(uri);
         await waitFor(() => documents.current?.snapshot !== undefined);
         let answered = false;
         const written = documents.setField('name', 'BeforeDispose').finally(() => {
            answered = true;
         });

         await documents.dispose();

         expect(answered).toBe(true);
         expect(await written).toEqual({ status: 'applied' });
      });

      it('loads nothing again when a document whose open failed is shown again', async () => {
         const loads: boolean[] = [];
         const documents = showing(loading => loads.push(loading));
         const uri = uriOf('orders/missing.process');
         documents.show(uri);
         await waitFor(() => loads.length === 2);

         // A load reports itself within the call, so none has started.
         documents.show(uri);

         expect(loads).toEqual([true, false]);
      });

      it('loads a document whose open failed again when it is shown again, if told to', async () => {
         const loads: boolean[] = [];
         const documents = showing(loading => loads.push(loading), undefined, undefined, true);
         const uri = uriOf('orders/missing.process');
         documents.show(uri);
         await waitFor(() => loads.length === 2);

         documents.show(uri);

         expect(loads).toEqual([true, false, true]);
      });

      it('loads a document again when it is shown after it was deleted', async () => {
         const loads: boolean[] = [];
         const documents = showing(loading => loads.push(loading));
         const uri = uriOf(FULFILLMENT_PROCESS);
         documents.show(uri);
         // Loaded, not only read, since a show during the load loads nothing again.
         await waitFor(() => loads.length === 2);
         const langiumDocuments = sharedServices!.workspace.LangiumDocuments;
         const open = langiumDocuments.all.find((document: { uri: { toString(): string } }) => document.uri.toString() === uri);
         await sharedServices!.workspace.DocumentBuilder.update([], [open!.uri]);
         await waitFor(() => documents.current?.snapshot === undefined);

         documents.show(uri);

         await waitFor(() => documents.current?.snapshot !== undefined, { message: 'the document never loaded again' });
      });

      it('reports nothing of an open that fails after the next document is shown', async () => {
         const errors: unknown[] = [];
         const documents = showing(undefined, error => errors.push(error));
         documents.show(uriOf(RETURNS_PROCESS));
         const opened = new Deferred<void>();
         const failed = opened.promise.then(() => Promise.reject(new Error('open failed')));
         const open = vi.spyOn(documents.current!, 'open').mockReturnValue(failed);
         await waitFor(() => open.mock.calls.length === 1);

         documents.show(uriOf(FULFILLMENT_PROCESS));
         opened.resolve();
         await failed.catch(() => undefined);
         await waitFor(() => documents.current?.snapshot !== undefined);

         expect(errors).toEqual([]);
      });

      it('opens nothing of a document shown again whose close it waits on when another is shown', async () => {
         const documents = showing();
         const uri = uriOf(FULFILLMENT_PROCESS);
         documents.show(uri);
         await waitFor(() => documents.current?.snapshot !== undefined);
         documents.show(uriOf(RETURNS_PROCESS));
         documents.show(uri);
         const shownAgain = documents.current;
         const opened = vi.spyOn(shownAgain!, 'open');

         documents.show(uriOf(RETURNS_PROCESS));
         await waitFor(() => documents.current?.snapshot !== undefined);

         expect(opened).not.toHaveBeenCalled();
      });

      it('draws no fields when it shows no document', async () => {
         const drawn: (readonly PropertyField[])[] = [];
         const documents = showing(undefined, undefined, { setFields: fields => drawn.push(fields) });
         documents.show(uriOf(FULFILLMENT_PROCESS));
         await waitFor(() => documents.current?.snapshot !== undefined);
         drawn.length = 0;

         documents.show(undefined);

         expect(drawn).toEqual([]);
      });

      it('draws and marks nothing of a change a document shown before announces', async () => {
         const drawn: (readonly PropertyField[])[] = [];
         const dirty: boolean[] = [];
         const documents = showing(undefined, undefined, {
            setFields: fields => drawn.push(fields),
            setDirty: flag => dirty.push(flag)
         });
         documents.show(uriOf(FULFILLMENT_PROCESS));
         await waitFor(() => documents.current?.snapshot !== undefined);
         const before = documents.current!;
         documents.show(uriOf(RETURNS_PROCESS));
         drawn.length = 0;
         dirty.length = 0;

         // Still closing, it can announce a change, as when its write answers.
         before['changeEmitter'].fire(undefined);
         before['dirtyEmitter'].fire(undefined);

         expect(drawn).toEqual([]);
         expect(dirty).toEqual([]);
      });

      it('shows nothing of the open of a document shown before that answers after the switch', async () => {
         const loads: boolean[] = [];
         const documents = showing(loading => loads.push(loading));
         documents.show(uriOf(FULFILLMENT_PROCESS));
         const before = new Deferred<void>();
         const opened = vi.spyOn(documents.current!, 'open').mockReturnValue(before.promise);
         await waitFor(() => opened.mock.calls.length === 1);
         documents.show(uriOf(RETURNS_PROCESS));
         const next = new Deferred<void>();
         const opening = vi.spyOn(documents.current!, 'open').mockReturnValue(next.promise);
         await waitFor(() => opening.mock.calls.length === 1);

         before.resolve();
         await tick(0);

         expect(loads).toEqual([true, true]);
         next.resolve();
         await waitFor(() => loads.length === 3);
      });

      it('reports nothing of the failed close of a document shown before', async () => {
         const errors: unknown[] = [];
         const documents = showing(undefined, error => errors.push(error));
         documents.show(uriOf(FULFILLMENT_PROCESS));
         await waitFor(() => documents.current?.snapshot !== undefined);
         const closing = new Deferred<void>();
         vi.spyOn(documents.current!, 'close').mockReturnValue(closing.promise);
         documents.show(uriOf(RETURNS_PROCESS));
         await waitFor(() => documents.current?.snapshot !== undefined);

         closing.reject(new Error('the session ended'));
         await documents.dispose();

         expect(errors).toEqual([]);
      });

      it('shows nothing once it is disposed', async () => {
         const documents = showing();
         documents.show(uriOf(FULFILLMENT_PROCESS));
         await waitFor(() => documents.current?.snapshot !== undefined);
         await documents.dispose();

         documents.show(uriOf(RETURNS_PROCESS));

         expect(documents.current).toBeUndefined();
      });
   });
});

/** The server's current root for `uri`, as a foreign writer would read it. */
async function currentRoot(uri: string): Promise<OrderFlowTransferRoot> {
   const server = await session!.connected();
   return TransferDocument.assertLoaded(await server.getModelDocument({ uri })).model.root;
}

describe('order-flow properties model beside a debouncing editor', () => {
   let lsp: LspHarness | undefined;

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
      lsp?.dispose();
      lsp = undefined;
      sharedServices = undefined;
      workspace?.dispose();
      workspace = undefined;
   });

   it('merges a field write over an editor change the debounce still holds, once it is built', async () => {
      workspace = makeScratchWorkspace({ seed: WORKSPACE_ROOT, prefix: 'order-flow-props-debounce-' });
      const wire = makeLspServerConnection();
      const { shared } = createOrderFlowServices(
         { ...NodeFileSystem, connection: wire.serverConnection },
         {
            extraSharedModules: [
               {
                  lsp: {
                     DocumentUpdateHandler: (services: ServerSharedServices) =>
                        new HydraniumDocumentUpdateHandler(services, { debounceMs: 60_000 })
                  }
               }
            ]
         }
      );
      sharedServices = shared;
      lsp = makeLspHarness({ connection: wire, services: shared });
      await lsp.initialize({ workspaceFolders: [{ uri: workspace.uri(), name: 'order-flow' }] });
      port = new FakeDataPort(channel => {
         void new DataServer<OrderFlowTransferRoot>(channel, shared);
      });
      events = new DataEvents<OrderFlowTransferRoot>();
      connection = new DataConnection<OrderFlowTransferRoot>(port, events);
      session = connection.createSession('order-flow-model-test');
      const uri = uriOf(FULFILLMENT_PROCESS);
      const store = shared.workspace.TextDocuments;
      const clean = readFileSync(path.join(workspace.root, FULFILLMENT_PROCESS), 'utf8');
      const edited = clean.replace('   transition Pay', '   task Audit reads Order.id\n   transition Pay');
      lsp.openDocument(uri, clean, 'order-flow-process', 1);
      await waitFor(() => store.get(uri)?.getText() === clean);
      const model = pinnedModel(uri);
      await model.open();
      lsp.changeDocument(uri, edited, 2);
      await waitFor(() => store.get(uri)?.getText() === edited);

      const writing = model.setField('name', 'Fulfilment');
      const refetches = (): number => port!.sent.filter(request => request.method.endsWith('getModelDocument')).length;
      const beforeRefetch = refetches();
      await waitFor(() => refetches() > beforeRefetch, { message: 'the conflicting write never refetched' });
      shared.lsp.DocumentUpdateHandler.flushPending();

      expect(await writing).toEqual({ status: 'merged' });
      const text = store.get(uri)!.getText();
      expect({ audit: text.includes('task Audit'), renamed: text.includes('process Fulfilment') }).toEqual({ audit: true, renamed: true });
   });
});
