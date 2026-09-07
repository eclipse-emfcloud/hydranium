/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * Launch-surface smoke test for the data head that `lib/main.js` starts
 * alongside the stdio LSP head and the GLSP socket.
 *
 * This is the only tier that covers everything between "the process booted" and
 * "a client can call a protocol method". The framework's own tests of
 * `startSocketServer` + `publishPortOnLspConnection` run in-process over a duplex
 * stream pair rather than a real socket, and the example's other data-head suites
 * go through `makeDataServerHarness`, so port publication, socket bind, JSON-RPC
 * framing over TCP, the `data-server/` wire prefix and per-connection
 * `DataServer` construction are reachable only from here.
 *
 * What this asserts, in the order a host integration does it:
 * - `order-flow/data-server/port` answers over the LSP connection with a usable
 *   port, so the publish handshake fired.
 * - A TCP connection to that port is accepted, so the socket is listening and
 *   not merely announced.
 * - A typed `waitForReady` + `getProjects` round-trips over that socket. This is
 *   the load-bearing pair: a reply proves the accepted connection was wired to a
 *   real `DataServer`, that the `data-server/` prefix on the wire matches what
 *   the server bound, and that request/response framing survives the socket.
 * - `getModelDocument` for a `.process` file answers with a `ProcessModel` root.
 *   One `DataServer` serves all three grammars, so the URI alone selects the
 *   serializer — and a single-grammar smoke cannot tell a correct per-URI router
 *   from one that always answers with the only language it has.
 *
 * The proxy is typed with the **transfer** roots, not the AST ones. Both satisfy
 * `TransferElement` structurally, so naming the AST types compiles fine while
 * telling the client that a `Reference<T>` is a resolvable object rather than the
 * bare name the wire actually carries.
 */

import { type ScratchWorkspace, makeScratchWorkspace } from '@hydranium/core/testing/node';
import { createRpcProxy } from '@hydranium/protocol';
import {
   DATA_CLIENT_PROTOCOL_METHODS,
   DATA_SERVER_WIRE_PREFIX,
   type DataClientProtocol,
   type DataServerProtocol
} from '@hydranium/protocol/data';
import * as net from 'node:net';
import { StreamMessageReader, StreamMessageWriter, createMessageConnection, type MessageConnection } from 'vscode-jsonrpc/node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ORDER_FLOW_DATA_SERVER_PORT_COMMAND } from '../../src/head-ports.js';
import type { DomainModel, LayoutModel, ProcessModel } from '../../src/language-server/generated-transfer/transfer-model.js';
import { WORKSPACE_FILES, WORKSPACE_ROOT } from '../order-flow-harness.js';
import { SPAWN_TIMEOUT_MS, type SpawnedOrderFlowServer, startSpawnedOrderFlowServer } from './spawned-order-flow-server.js';

/**
 * The LSP request the host queries to discover the data-server socket port.
 * Imported rather than restated so this suite asserts the command the shipped
 * entry actually publishes — a host that retypes the literal gets no error when
 * it drifts, because the port poll retries indefinitely.
 */
const PORT_COMMAND = ORDER_FLOW_DATA_SERVER_PORT_COMMAND;

/** The transfer roots this server serves — one data head over three grammars. */
type OrderFlowTransferRoot = DomainModel | LayoutModel | ProcessModel;

let server: SpawnedOrderFlowServer | undefined;
let workspace: ScratchWorkspace | undefined;
let socket: net.Socket | undefined;
let rpc: MessageConnection | undefined;
let publishedPort: number | undefined;

/** Connect to `port` and fail with a named error rather than hanging. */
async function connectSocket(port: number): Promise<net.Socket> {
   return new Promise<net.Socket>((resolve, reject) => {
      const pending = net.createConnection({ host: '127.0.0.1', port });
      const timer = setTimeout(() => {
         pending.destroy();
         reject(new Error(`TCP connect to data-server port ${port} timed out`));
      }, 2_000);
      pending.once('connect', () => {
         clearTimeout(timer);
         resolve(pending);
      });
      pending.once('error', error => {
         clearTimeout(timer);
         reject(error);
      });
   });
}

/**
 * The typed proxy over the socket opened above.
 *
 * Reuses that socket rather than dialling again: `startSocketServer` builds one
 * `DataServer` per accepted connection, so reconnecting would exercise a second
 * server instance rather than the one just proven to be accepted.
 */
function dataServerProxy(): DataServerProtocol<OrderFlowTransferRoot> {
   if (!socket) {
      throw new Error('socket not connected');
   }
   if (!rpc) {
      rpc = createMessageConnection(new StreamMessageReader(socket), new StreamMessageWriter(socket));
      rpc.onError(() => undefined);
      rpc.onClose(() => undefined);
      // Once only: `listen` throws on a connection that is already listening.
      rpc.listen();
   }
   return createRpcProxy<DataServerProtocol<OrderFlowTransferRoot>, DataClientProtocol<OrderFlowTransferRoot>>(rpc, {
      methodNamespace: DATA_SERVER_WIRE_PREFIX,
      localMethods: DATA_CLIENT_PROTOCOL_METHODS
   });
}

/** `file:` URI of a workspace-relative path inside the scratch copy. */
function uriOf(relativePath: string): string {
   if (!workspace) {
      throw new Error('scratch workspace not seeded');
   }
   return workspace.uri(relativePath);
}

describe('order-flow data-server socket smoke', () => {
   beforeAll(async () => {
      workspace = makeScratchWorkspace({ seed: WORKSPACE_ROOT, prefix: 'order-flow-smoke-data-' });
      server = await startSpawnedOrderFlowServer({ workspaceRoot: workspace.root });
      publishedPort = await server.port(PORT_COMMAND);
   }, SPAWN_TIMEOUT_MS);

   afterAll(async () => {
      rpc?.dispose();
      rpc = undefined;
      socket?.destroy();
      socket = undefined;
      await server?.dispose();
      server = undefined;
      workspace?.dispose();
      workspace = undefined;
   }, SPAWN_TIMEOUT_MS);

   it('publishes the data-server port via the LSP request handshake', () => {
      expect(publishedPort).toEqual(expect.any(Number));
      expect(publishedPort!).toBeGreaterThan(0);
      expect(publishedPort!).toBeLessThan(65536);
   });

   it('accepts a TCP connection on the published port', async () => {
      socket = await connectSocket(publishedPort!);
      expect(socket.destroyed).toBe(false);
   });

   it('answers typed waitForReady and getProjects requests over the socket', async () => {
      const proxy = dataServerProxy();

      // `waitForReady` first, for the reason the protocol doc gives: a socket
      // client can connect before the workspace walk finished, and an early
      // `getProjects` would then be answered — correctly — from an empty
      // registry, which reads as a broken project tier rather than as a race.
      await proxy.waitForReady();
      const projects = await proxy.getProjects();

      // Two descriptors in the sample workspace, `orders` and `commerce-core`.
      // Asserting the CONTENT and not just that an array arrived is what proves
      // the accepted connection reached a real `DataServer` over a built
      // workspace, rather than a `DataServer` over an empty one.
      expect(projects.map(project => project.id).sort()).toEqual(['commerce-core', 'orders']);
   });

   it('routes a second grammar to its own serializer over the same socket', async () => {
      const proxy = dataServerProxy();

      const document = await proxy.getModelDocument({ uri: uriOf(WORKSPACE_FILES.fulfillmentProcess), includeDiagnostics: true });

      expect(document.uri).toBe(uriOf(WORKSPACE_FILES.fulfillmentProcess));
      expect(document.root?.$type).toBe('ProcessModel');
      // The clean file: whatever else it carries, not the workspace's one
      // intended error, which lives in a `.domain` file.
      const messages = (document.diagnostics ?? []).map(diagnostic => diagnostic.message).join('\n');
      expect(messages).not.toContain('AuditStamp');
   });
});
