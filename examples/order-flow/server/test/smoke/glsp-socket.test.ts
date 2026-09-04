/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * Launch-surface smoke test for the GLSP head that `lib/main.js` starts
 * alongside the stdio LSP head and the data socket.
 *
 * The other GLSP action coverage — `test/glsp/*.integration.test.ts` and the
 * framework's own suites — runs IN-PROCESS: `makeGlspHarness` binds
 * `GLSPClientProxy` to a capturing stub, so actions never cross a socket. GLSP's
 * JSON-RPC handshake, `ActionMessage` framing and per-connection session
 * container over the real transport a host uses are therefore reachable only from
 * here.
 *
 * What this asserts, in the order a host integration does it:
 * - `order-flow/glsp/port` answers over the LSP connection, so the port-publish
 *   handshake fired.
 * - A TCP connect to that port succeeds, so the socket is listening.
 * - stdout stayed clean enough for the LSP handshake to complete. GLSP's logs
 *   route through `GlspClientLogger`, i.e. the LSP connection; a stray stdout
 *   write would have corrupted the JSON-RPC framing and failed `beforeAll`.
 * - `initialize` + `initializeClientSession` complete over the socket, then a
 *   `RequestModelAction` naming a real workspace file settles as a
 *   `RequestBoundsAction` carrying `fulfillment.process`'s five flow nodes AND
 *   the bounds `fulfillment.layout` persists for `Pay`. That last part is the
 *   load-bearing one: it proves the accepted socket reached a real session
 *   container, that the multi-document storage loaded BOTH the `.process`
 *   primary and its `.layout` secondary, that the GModel factory overlaid one
 *   onto the other, and that the whole graph crossed back over the wire.
 *
 * `.process` keeps `needsClientLayout: true` — persisted bounds are an overlay,
 * not an authority — so `RequestBoundsAction` is the correct response kind here
 * rather than a `SetModelAction`.
 */

import { type ScratchWorkspace, makeScratchWorkspace } from '@hydranium/core/testing/node';
import { type ActionMessage, BaseJsonrpcGLSPClient, GLSPClient, RequestBoundsAction, RequestModelAction } from '@eclipse-glsp/protocol';
import { type GNode, SOURCE_URI_ARG } from '@eclipse-glsp/server';
import * as net from 'node:net';
import { StreamMessageReader, StreamMessageWriter, createMessageConnection, type MessageConnection } from 'vscode-jsonrpc/node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PROCESS_GATEWAY_NODE_TYPE, PROCESS_TASK_NODE_TYPE } from '../../src/glsp/order-flow-process-diagram-types.js';
import { ORDER_FLOW_GLSP_PORT_COMMAND } from '../../src/head-ports.js';
import { WORKSPACE_FILES, WORKSPACE_ROOT } from '../order-flow-harness.js';
import { SPAWN_TIMEOUT_MS, type SpawnedOrderFlowServer, startSpawnedOrderFlowServer } from './spawned-order-flow-server.js';

/**
 * The LSP request the host queries to discover the GLSP socket port. Imported
 * rather than restated so this suite asserts the command the shipped entry
 * actually publishes — a host that retypes the literal gets no error when it
 * drifts, because the port poll retries indefinitely.
 */
const PORT_COMMAND = ORDER_FLOW_GLSP_PORT_COMMAND;

/** The diagram type `OrderFlowProcessDiagramModule` declares. */
const DIAGRAM_TYPE = 'order-flow-process';

/** `fulfillment.process`: tasks Pay / Pick / Ship / Cancel plus gateway PaymentOk. */
const FULFILLMENT_NODE_COUNT = 5;

/** `node Pay at 40, 100 size 160, 60` — the layout entry read back off the wire. */
const PAY_BOUNDS = { position: { x: 40, y: 100 }, size: { width: 160, height: 60 } } as const;

let server: SpawnedOrderFlowServer | undefined;
let workspace: ScratchWorkspace | undefined;
let socket: net.Socket | undefined;
let rpc: MessageConnection | undefined;
let glspClient: BaseJsonrpcGLSPClient | undefined;
let publishedPort: number | undefined;

describe('order-flow GLSP socket smoke', () => {
   beforeAll(async () => {
      workspace = makeScratchWorkspace({ seed: WORKSPACE_ROOT, prefix: 'order-flow-smoke-glsp-' });
      server = await startSpawnedOrderFlowServer({ workspaceRoot: workspace.root });
      publishedPort = await server.port(PORT_COMMAND);
   }, SPAWN_TIMEOUT_MS);

   afterAll(async () => {
      try {
         await glspClient?.stop();
      } catch {
         // Best effort — the server may already have torn the session down.
      }
      glspClient = undefined;
      rpc?.dispose();
      rpc = undefined;
      socket?.destroy();
      socket = undefined;
      await server?.dispose();
      server = undefined;
      workspace?.dispose();
      workspace = undefined;
   }, SPAWN_TIMEOUT_MS);

   it('publishes the GLSP port via the LSP request handshake', () => {
      expect(publishedPort).toEqual(expect.any(Number));
      expect(publishedPort!).toBeGreaterThan(0);
      expect(publishedPort!).toBeLessThan(65536);
   });

   it('binds a TCP socket on the published port', async () => {
      socket = await new Promise<net.Socket>((resolve, reject) => {
         const pending = net.createConnection({ host: '127.0.0.1', port: publishedPort! });
         const timer = setTimeout(() => {
            pending.destroy();
            reject(new Error(`TCP connect to GLSP port ${publishedPort} timed out`));
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
      expect(socket.destroyed).toBe(false);
   });

   it("captures GLSP's own startup output on the LSP channel, not on stdout", () => {
      // stdout IS the LSP transport under `--stdio`, so a GLSP-side stdout write
      // would have corrupted the framing and failed the `initialize` in
      // `beforeAll`. Asserted POSITIVELY rather than as an absence: GLSP's
      // launcher writes its startup line with a raw `console` call, and
      // `createConnection` replaces the global console with one that forwards to
      // `window/logMessage` — which is the mechanism that keeps a third-party
      // `console.log` from corrupting the stream, and the reason a stray write
      // is survivable at all.
      const lines = server!.logMessages.map(message => message.message);

      // The line names the port it bound, which also cross-checks the value the
      // LSP port command answered with against what the socket layer did.
      expect(lines.some(line => line.includes('GLSP') && line.includes(String(publishedPort)))).toBe(true);
      // Framing corruption would surface as a parse failure, so keep the negative
      // too. NOT an "stderr is empty" assertion: measured, a child with a client
      // attached writes nothing there at all, because `LspLogger` falls back to
      // stderr only for a dead channel.
      expect(server!.stderr()).not.toMatch(/\bSyntaxError\b/);
   });

   it('routes GLSP framework logs through GlspClientLogger onto that same channel', () => {
      // The console redirect above would also carry a GLSP line that never
      // reached the framework logger, so it cannot show the wiring
      // `startGlspServer`'s `createLogger` option exists for. This does: a line
      // in `LspLogger`'s own `[level - time] [Component] …` shape whose text is
      // GLSP's. The discriminating control is dropping the GLSP log level to
      // `none`, which removes exactly this line and leaves the
      // console-redirected one.
      const routed = server!.logMessages
         .map(message => message.message)
         .filter(line => /^\[\w+\s+-\s[\d:.]+\]\s\[\w+\]\s.*GLSP/.test(line));

      expect(routed.length).toBeGreaterThan(0);
   });

   it('round-trips RequestModelAction to RequestBoundsAction over the socket', async () => {
      rpc = createMessageConnection(new StreamMessageReader(socket!), new StreamMessageWriter(socket!));
      rpc.onError(() => undefined);
      rpc.onClose(() => undefined);
      // Deliberately NOT calling `rpc.listen()`: `BaseJsonrpcGLSPClient.start`
      // calls it, and a second call throws — which `start` catches and turns
      // into a silent `StartFailed`, surfacing only as "not ready yet" on the
      // next request.
      glspClient = new BaseJsonrpcGLSPClient({ id: 'order-flow-smoke-client', connectionProvider: rpc });
      await glspClient.start();
      await glspClient.initializeServer({
         applicationId: 'order-flow-smoke',
         protocolVersion: GLSPClient.protocolVersion
      });

      const clientSessionId = 'smoke-session';
      const received: ActionMessage[] = [];
      const nextBounds = new Promise<RequestBoundsAction>((resolve, reject) => {
         const timer = setTimeout(
            () => reject(new Error(`No ${RequestBoundsAction.KIND} within 15s; saw: ${received.map(msg => msg.action.kind).join(', ')}`)),
            15_000
         );
         glspClient!.onActionMessage(message => {
            received.push(message);
            if (RequestBoundsAction.is(message.action)) {
               clearTimeout(timer);
               resolve(message.action);
            }
         }, clientSessionId);
      });

      // `clientActionKinds` is what the server routes BACK to us — without
      // RequestBounds listed, a client-laid-out diagram's response is dropped
      // server-side and this test would time out rather than fail loudly.
      await glspClient.initializeClientSession({
         clientSessionId,
         diagramType: DIAGRAM_TYPE,
         clientActionKinds: [RequestBoundsAction.KIND]
      });
      glspClient.sendActionMessage({
         clientId: clientSessionId,
         action: RequestModelAction.create({
            options: { [SOURCE_URI_ARG]: workspace!.resolve(WORKSPACE_FILES.fulfillmentProcess) }
         })
      });

      const requestBounds = await nextBounds;
      const flowNodes = (requestBounds.newRoot.children ?? []).filter(
         (child): child is GNode => child.type === PROCESS_TASK_NODE_TYPE || child.type === PROCESS_GATEWAY_NODE_TYPE
      );
      // Asserting the COUNT, not just that a response arrived, is what proves
      // storage loaded the document and the GModel factory projected it rather
      // than an empty graph coming back.
      expect(flowNodes).toHaveLength(FULFILLMENT_NODE_COUNT);

      // And the layout overlay: `Pay` carries the bounds the `.layout`
      // secondary persists, while `Cancel` — deliberately absent from that file
      // — must not. Without the secondary loaded, both would carry the builder
      // default and this pair would collapse.
      const pay = flowNodes.find(node => node.id === 'Pay');
      const cancel = flowNodes.find(node => node.id === 'Cancel');
      expect(pay?.position).toEqual(PAY_BOUNDS.position);
      expect(pay?.size).toEqual(PAY_BOUNDS.size);
      expect(cancel?.position).not.toEqual(PAY_BOUNDS.position);
   }, 30_000);
});
