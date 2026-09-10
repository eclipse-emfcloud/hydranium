/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * Cross-head WRITE against the spawned binary: edit through the data socket,
 * observe the LSP publish in the SAME spawned `lib/main.js`.
 *
 * Every other suite beside this one drives exactly ONE head:
 * `data-server-socket` and `glsp-socket` round-trip read-only requests over
 * their own socket, `lsp-stdio` opens documents on the LSP wire. And the
 * cross-head crossings themselves are proven in-process by
 * `test/coherence.integration.test.ts`, which attaches three harnesses to one
 * `services.shared` it constructed itself. So the SEMANTICS of a crossing and
 * the TRANSPORTS are each covered elsewhere; what only this suite shows is that
 * the shipped entry really composes ONE services tree. That is measured, not
 * assumed: hand the `DataServer` a SECOND services tree, separately initialized
 * over the same workspace root, and all three of those suites stay green — port
 * published, socket accepted, `getProjects` answering both projects — while this
 * one times out with nothing published for the `.process` URI.
 *
 * What this asserts, and why each half of it matters:
 *
 * - The write goes in through the **data head's real socket** — typed
 *   `updateModelDocument` over TCP, JSON-RPC framed, `data-server/` prefixed.
 * - The observation comes out through the **LSP head's real stdio wire** — a
 *   `publishDiagnostics` push for a document the data head never named.
 * - The affected document is in **another grammar**: the edit removes
 *   `Order.status` from `orders/orders.domain`, and the errors land on
 *   `orders/fulfillment.process`, whose `writes Order.status = …` effects can no
 *   longer resolve. A per-grammar document store, a per-head `DocumentBuilder`
 *   or a second services tree behind the socket would each leave this silent.
 *
 * Three properties of the scenario shape the code, all of them measured:
 *
 * - **The cascade is asynchronous.** `updateModelDocument` resolves BEFORE the
 *   dependent documents are re-diagnosed, so the write response says nothing
 *   about the crossing and is deliberately not asserted on. The publish is
 *   awaited instead.
 * - **A publish fans out**, so the diagnostics index is recorded BEFORE the
 *   write and the tail is read from there, which is what the framework
 *   harness's `nextDiagnostics` `fromIndex` exists to provide.
 * - **The workspace init links and indexes but does NOT validate**, so nothing
 *   has been published for any document when the edit goes in. That is asserted
 *   rather than assumed, because it is what makes "a publish arrived for the
 *   `.process` URI since the edit" mean "the edit caused it".
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
import { Diagnostic } from 'vscode-languageserver-protocol';
import { StreamMessageReader, StreamMessageWriter, createMessageConnection, type MessageConnection } from 'vscode-jsonrpc/node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ORDER_FLOW_DATA_SERVER_PORT_COMMAND } from '../../src/head-ports.js';
import type { DomainModel, LayoutModel, ProcessModel } from '../../src/language-server/generated-hydranium/transfer-model.js';
import { WORKSPACE_FILES, WORKSPACE_ROOT } from '../order-flow-harness.js';
import { SPAWN_TIMEOUT_MS, type SpawnedOrderFlowServer, startSpawnedOrderFlowServer } from './spawned-order-flow-server.js';

/**
 * The LSP request the host queries to discover the data-server socket port.
 * Imported rather than restated so this suite asserts the command the shipped
 * entry actually publishes.
 */
const PORT_COMMAND = ORDER_FLOW_DATA_SERVER_PORT_COMMAND;

/** The transfer roots this server serves — one data head over three grammars. */
type OrderFlowTransferRoot = DomainModel | LayoutModel | ProcessModel;

/**
 * How long to allow for the cross-grammar cascade to reach the wire. The
 * dependent documents' publishes arrive about a second after the write resolves,
 * and a subprocess boundary sits between the two.
 *
 * **Deliberately far above that, and the cost of a false timeout is what
 * justifies the size.** Unsaturated this file completes in ~1.5 s; on a CPU-bound
 * box — a full uncached build with a dozen test workers competing with this
 * spawned server — it can take tens of seconds. **A timeout here is expensive out
 * of all proportion to its cause**, because this suite's own doc reserves that
 * exact signature ("times out with nothing published for the `.process` URI") for
 * a real architectural defect: the data head and the LSP head not sharing one
 * services tree. So a saturated box otherwise reads as a regression in the very
 * thing the suite was built to detect.
 *
 * The same argument {@link SPAWN_TIMEOUT_MS} makes, for the same reason: a
 * starved subprocess is slow, not hung, and this suite's subject is COMPOSITION
 * rather than latency. Nothing here regresses silently — a cascade that never
 * happens still fails, just later.
 */
const CASCADE_TIMEOUT_MS = 45_000;

/**
 * Test-level budget — the spawn is in `beforeAll`, but the cascade is not free.
 *
 * Must stay above two full {@link CASCADE_TIMEOUT_MS} waits, since the test makes
 * two: if vitest's budget bites first, the failure arrives as a generic test
 * timeout instead of the message naming the URI and what HAD been published,
 * which is the whole diagnostic value of `nextDiagnostics` rejecting itself.
 */
const CASCADE_TEST_TIMEOUT_MS = 120_000;

/**
 * `orders.domain` with `Order.status` REMOVED. Still valid on its own — the
 * `OrderStatus` enum is merely unused — so every diagnostic it provokes lands on
 * the `.process` documents in the other grammar rather than on the edited
 * document.
 */
const DOMAIN_TEXT_WITHOUT_STATUS = `project orders requires commerce-core

entity Order {
   id: ID
   total: Money
   shipTo: Address
   lines: LineItem[]
}

enum OrderStatus { NEW, PAID, SHIPPED, CANCELLED }

entity LineItem {
   sku: ID
   quantity: Number
   price: Money
}
`;

let server: SpawnedOrderFlowServer | undefined;
let workspace: ScratchWorkspace | undefined;
let socket: net.Socket | undefined;
let rpc: MessageConnection | undefined;

/** The spawned server, or a throw naming the missing setup rather than an `undefined` deref. */
function spawned(): SpawnedOrderFlowServer {
   if (!server) {
      throw new Error('spawned server not started');
   }
   return server;
}

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

/** The typed data-head proxy over the socket opened in `beforeAll`. */
function dataServerProxy(): DataServerProtocol<OrderFlowTransferRoot> {
   if (!rpc) {
      throw new Error('data-server RPC connection not established');
   }
   return createRpcProxy<DataServerProtocol<OrderFlowTransferRoot>, DataClientProtocol<OrderFlowTransferRoot>>(rpc, {
      methodNamespace: DATA_SERVER_WIRE_PREFIX,
      localMethods: DATA_CLIENT_PROTOCOL_METHODS
   });
}

/**
 * Await a cascade publish, dumping the server's own log to stderr if it never comes.
 *
 * `window/logMessage` is where the framework's log actually goes, since stdout IS
 * the LSP transport, so this dump is the only server-side evidence a failure of
 * this suite has: without it a red is inference from the publish set alone.
 *
 * `process.stderr.write` rather than `console.*`: vitest attributes console output
 * to the running test and drops anything emitted from an async continuation that
 * settles after the body, which is exactly when this runs.
 */
async function awaitCascade(uri: string, fromIndex: number): Promise<Diagnostic[]> {
   try {
      return await spawned().nextDiagnostics(uri, { fromIndex, timeoutMs: CASCADE_TIMEOUT_MS });
   } catch (error: unknown) {
      const lines = spawned().logMessages.map(message => `[${message.type}] ${message.message}`);
      process.stderr.write(
         `\n=== server log at cascade failure for ${uri} (${lines.length} lines) ===\n${lines.join('\n')}\n=== end server log ===\n`
      );
      throw error;
   }
}

/** `file:` URI of a workspace-relative path inside the scratch copy — what both wires carry. */
function uriOf(relativePath: string): string {
   if (!workspace) {
      throw new Error('scratch workspace not seeded');
   }
   return workspace.uri(relativePath);
}

describe('order-flow cross-head write smoke (data socket in, LSP wire out)', () => {
   beforeAll(async () => {
      // A throwaway copy, not the committed workspace: the initial build runs the
      // integrity rules, whose default silent mode persists repairs with
      // `writeFile`, so a child booted over the fixture could rewrite it.
      workspace = makeScratchWorkspace({ seed: WORKSPACE_ROOT, prefix: 'order-flow-smoke-cross-' });
      server = await startSpawnedOrderFlowServer({ workspaceRoot: workspace.root });
      socket = await connectSocket(await server.port(PORT_COMMAND));
      rpc = createMessageConnection(new StreamMessageReader(socket), new StreamMessageWriter(socket));
      rpc.onError(() => undefined);
      rpc.onClose(() => undefined);
      rpc.listen();
      // The workspace walk may still be running when the socket is accepted, and
      // an edit landing before it finishes would rebuild against a partial index.
      await dataServerProxy().waitForReady();
   }, SPAWN_TIMEOUT_MS);

   afterAll(async () => {
      rpc?.dispose();
      rpc = undefined;
      socket?.destroy();
      socket = undefined;
      const stderr = server?.stderr() ?? '';
      await server?.dispose();
      server = undefined;
      workspace?.dispose();
      workspace = undefined;
      if (stderr.trim().length > 0) {
         process.stderr.write(`order-flow server stderr:\n${stderr}\n`);
      }
   }, SPAWN_TIMEOUT_MS);

   it(
      'crosses a data-socket .domain write to an LSP publish for a .process document',
      async () => {
         const proxy = dataServerProxy();
         const domainUri = uriOf(WORKSPACE_FILES.ordersDomain);
         const processUri = uriOf(WORKSPACE_FILES.fulfillmentProcess);

         // Nothing has been published yet, for any document — not even for
         // `audit-leak.domain`, the workspace's one deliberate error. So the
         // publish awaited below cannot be a leftover from the boot.
         expect(spawned().diagnostics).toHaveLength(0);

         // Recorded BEFORE the write, because a write fans out several publishes.
         const beforeWrite = spawned().diagnostics.length;
         await proxy.updateModelDocument({
            uri: domainUri,
            clientId: 'cross-head-l4',
            model: DOMAIN_TEXT_WITHOUT_STATUS
         });

         // Deliberately NOT asserted on the write response: the cascade is
         // asynchronous, so the response has already resolved while the dependent
         // documents are still being re-diagnosed.
         const published = await awaitCascade(processUri, beforeWrite);

         const messages = published.map(diagnostic => Diagnostic.getMessageString(diagnostic));
         // The field reference is the direct consequence; asserting it by message
         // is what shows the publish carries the linking error rather than merely
         // arriving. `.process` is a document the data head never named and whose
         // grammar it never touched in this test.
         expect(messages).toContain("Could not resolve reference to Field named 'status'.");

         // The edited document itself publishes CLEAN — the enum is only unused.
         // So the errors above are a consequence in the other grammar rather than
         // a spill-over from the document that was written.
         expect(await awaitCascade(domainUri, beforeWrite)).toEqual([]);
      },
      CASCADE_TEST_TIMEOUT_MS
   );
});
