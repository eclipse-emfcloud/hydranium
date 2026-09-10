/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * The whole data head over a structured-clone-only hop.
 *
 * This suite exists to settle one claim by measurement rather than by argument:
 * that `createRpcProxy` runs *unchanged* inside a VS Code webview, where there
 * is no `net`, no reach into the extension host's connection, and nothing but
 * `postMessage`. Every design decision in the port rests on it —
 * if it were false, the alternative would be declaring one `vscode-messenger`
 * `RequestType` per data-head method and terminating JSON-RPC in the extension
 * host, which hand-maintains a per-method mapping and discards the
 * `as const satisfies keyof` allowlists that cannot drift.
 *
 * **The simulation is the real constraint, not an approximation of it.** Every
 * message crossing the pipe goes through `structuredClone` — the exact
 * algorithm a webview boundary applies. Anything non-clonable (a `Disposable`
 * instance, a `URI`, an `Emitter`, a function, a class with behaviour) makes
 * `structuredClone` throw `DataCloneError` rather than degrade quietly, so a
 * payload that only *looks* like plain data fails here loudly.
 *
 * What runs over that pipe is not a toy: a real `DataServer` over a real
 * workspace on one side, and the full `DataSession` +
 * `OrderFlowPropertiesModel` stack on the other, driven through
 * open → follow → typed write → conflict reconcile.
 */

import { initializeWorkspaceProgrammatically } from '@hydranium/core';
import { NodeFileSystem } from '@hydranium/core/lib/node';
import { type ScratchWorkspace, makeScratchWorkspace } from '@hydranium/core/lib/testing/node';
import { DataServer } from '@hydranium/data-server';
import { DataEvents, DataSession, TransferDocument, type DataPort, createPostMessageTransport } from '@hydranium/protocol';
import { waitFor } from '@hydranium/protocol/lib/testing';
import { createOrderFlowServices } from '@hydranium/example-order-flow-server/lib/language-server/order-flow-module';
import type {
   DomainModel,
   LayoutModel,
   ProcessModel
} from '@hydranium/example-order-flow-server/lib/language-server/generated-hydranium/transfer-model';
import * as path from 'node:path';
import { Emitter, type Event, type Message, type MessageConnection } from 'vscode-jsonrpc';
// `/node` because this suite runs in Node. A webview imports `/browser`; the
// package ROOT installs no runtime abstraction layer and throws on the first
// message, which is exactly why the transport module does not build the
// connection itself.
import { createMessageConnection } from 'vscode-jsonrpc/node';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OrderFlowPropertiesModel } from '../src/data/order-flow-properties-model';
import { ClonePipeEnd } from './testing/clone-pipe';

type OrderFlowTransferRoot = DomainModel | LayoutModel | ProcessModel;

const WORKSPACE_ROOT = path.resolve(__dirname, '../../workspace');
const FULFILLMENT_PROCESS = 'orders/fulfillment.process';
const THIRD_PARTY = 'some-other-editor';

/** A port whose transport is the simulated webview hop. */
class WebviewLikePort implements DataPort {
   readonly clientId = 'order-flow-webview';
   protected readonly disposeEmitter = new Emitter<void>();
   readonly onDispose: Event<void> = this.disposeEmitter.event;
   protected readonly toDispose: Array<{ dispose(): void }> = [];

   constructor(
      protected readonly crossed: Message[],
      protected readonly attachServer: (channel: MessageConnection) => void
   ) {}

   async connect(): Promise<MessageConnection> {
      const [extensionSide, webviewSide] = ClonePipeEnd.pair(this.crossed);
      this.toDispose.push(extensionSide, webviewSide);

      // Both ends go through the SAME transport module. In production the
      // extension host reaches the server over a socket instead, but crossing
      // the clone boundary in both directions is the stricter arrangement and
      // it is what proves the framing is symmetric.
      const serverTransport = createPostMessageTransport(extensionSide);
      const clientTransport = createPostMessageTransport(webviewSide);
      this.toDispose.push(serverTransport, clientTransport);

      const serverConnection = createMessageConnection(serverTransport.reader, serverTransport.writer);
      serverConnection.listen();
      this.attachServer(serverConnection);

      const clientConnection = createMessageConnection(clientTransport.reader, clientTransport.writer);
      clientConnection.listen();
      this.toDispose.push(clientConnection);
      return clientConnection;
   }

   reportError(): void {
      // Not this suite's subject.
   }

   dispose(): void {
      this.disposeEmitter.dispose();
      for (const disposable of this.toDispose.reverse()) {
         disposable.dispose();
      }
      this.toDispose.length = 0;
   }
}

let workspace: ScratchWorkspace | undefined;
let port: WebviewLikePort | undefined;
let events: DataEvents<OrderFlowTransferRoot> | undefined;
let session: DataSession<OrderFlowTransferRoot> | undefined;
let model: OrderFlowPropertiesModel<OrderFlowTransferRoot> | undefined;
let crossed: Message[] = [];

function uriOf(relativePath: string): string {
   if (!workspace) {
      throw new Error('scratch workspace not seeded');
   }
   return workspace.uri(relativePath);
}

async function currentRoot(uri: string): Promise<OrderFlowTransferRoot> {
   const server = await session!.connected();
   return TransferDocument.assertLoaded(await server.getModelDocument({ uri })).root;
}

describe('order-flow data head over a structured-clone hop', () => {
   beforeEach(async () => {
      workspace = makeScratchWorkspace({ seed: WORKSPACE_ROOT, prefix: 'order-flow-clone-' });
      const { shared } = createOrderFlowServices({ ...NodeFileSystem });
      await initializeWorkspaceProgrammatically(shared, workspace.root);

      crossed = [];
      port = new WebviewLikePort(crossed, channel => {
         void new DataServer<OrderFlowTransferRoot>(channel, shared);
      });
      events = new DataEvents<OrderFlowTransferRoot>();
      session = new DataSession<OrderFlowTransferRoot>(port, events);
      model = new OrderFlowPropertiesModel<OrderFlowTransferRoot>(session, events);
   });

   afterEach(() => {
      model?.dispose();
      model = undefined;
      session?.dispose();
      session = undefined;
      events?.dispose();
      events = undefined;
      port?.dispose();
      port = undefined;
      workspace?.dispose();
      workspace = undefined;
      crossed = [];
   });

   it('runs createRpcProxy unchanged across the hop', async () => {
      const server = await session!.connected();

      // Asserting the CONTENT, so this cannot pass against an empty registry:
      // the readiness gate, the request framing and the response framing all
      // have to survive the boundary for these two ids to come back.
      const projects = await server.getProjects();
      expect(projects.map(project => project.id).sort()).toEqual(['commerce-core', 'orders']);

      // And traffic really went through the clone pipe rather than around it.
      expect(crossed.length).toBeGreaterThan(0);
   });

   it('carries nothing that structured clone would reject', async () => {
      const uri = uriOf(FULFILLMENT_PROCESS);
      await model!.open(uri);
      await model!.setField('name', 'Fulfilment');

      // `post` already clones every message, so arriving here at all means no
      // payload was non-clonable. Re-cloning the captured traffic states the
      // property directly rather than leaving it implicit in the absence of a
      // throw, and covers the responses as well as the requests.
      expect(crossed.length).toBeGreaterThan(4);
      for (const message of crossed) {
         expect(() => structuredClone(message)).not.toThrow();
      }
   });

   it('opens, follows and writes a document across the hop', async () => {
      const uri = uriOf(FULFILLMENT_PROCESS);
      await model!.open(uri);

      expect(model!.fields).toEqual([
         { name: 'name', value: 'Fulfillment' },
         { name: 'subject', value: 'Order' }
      ]);

      expect(await model!.setField('name', 'Fulfilment')).toEqual({ status: 'applied' });

      const server = await session!.connected();
      const reread = await server.getModelDocument({ uri });
      expect((reread.root as ProcessModel).name).toBe('Fulfilment');
   });

   it('delivers a server-initiated notification back across the hop', async () => {
      // The direction that a request/response mapping would have got wrong:
      // the server pushes unprompted, so the reverse framing is exercised by
      // nothing else in this suite.
      const uri = uriOf(FULFILLMENT_PROCESS);
      await model!.open(uri);

      const foreign = (await currentRoot(uri)) as ProcessModel;
      const server = await session!.connected();
      await server.updateModelDocument({ uri, clientId: THIRD_PARTY, model: { ...foreign, name: 'RenamedByOther' } });

      await waitFor(() => model!.fields.find(field => field.name === 'name')?.value === 'RenamedByOther', {
         message: 'no server-initiated update crossed the clone boundary'
      });
   });

   it('reconciles a conflicting write across the hop', async () => {
      // The heaviest payload the form produces — a whole transfer root out, a
      // refetched root in, a merged root out again — so if anything in the
      // reconcile path did not survive cloning, it surfaces here.
      const uri = uriOf(FULFILLMENT_PROCESS);
      const pinned = new OrderFlowPropertiesModel<OrderFlowTransferRoot>(session!, new DataEvents<OrderFlowTransferRoot>());
      try {
         await pinned.open(uri);

         const foreign = (await currentRoot(uri)) as ProcessModel;
         const server = await session!.connected();
         await server.updateModelDocument({ uri, clientId: THIRD_PARTY, model: { ...foreign, subject: 'LineItem' } });

         expect(await pinned.setField('name', 'Fulfilment')).toEqual({ status: 'merged' });

         const reread = (await server.getModelDocument({ uri })).root as ProcessModel;
         expect(reread.name).toBe('Fulfilment');
         expect(reread.subject).toBe('LineItem');
      } finally {
         pinned.dispose();
      }
   });
});
