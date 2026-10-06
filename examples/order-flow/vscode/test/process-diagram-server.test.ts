/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

// GLSP's VS Code integration against the order-flow server's real GLSP head,
// on the copies of `vscode-jsonrpc` npm installed for each GLSP package.
const restoreLoad = vi.hoisted(() => {
   // GLSP's integration `require`s `vscode`, which only the extension host
   // provides; `vi.mock` does not reach a dependency's own `require`.
   const nodeModule = globalThis.process.getBuiltinModule('node:module') as typeof Module & {
      _load(request: string, ...rest: unknown[]): unknown;
   };
   const { Emitter } = nodeModule.createRequire(__filename)('vscode-jsonrpc') as typeof Jsonrpc;
   const load = nodeModule._load;
   nodeModule._load = function (request: string, ...rest: unknown[]): unknown {
      return request === 'vscode' ? { EventEmitter: Emitter } : load.call(this, request, ...rest);
   };
   return (): void => {
      nodeModule._load = load;
   };
});

import { SPAWNED_SERVER_HOOK_TIMEOUT_MS, startSpawnedServer, type SpawnedServer } from '@hydranium/core/testing/node';
import type { Module } from 'node:module';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type * as Jsonrpc from 'vscode-jsonrpc';
import { ORDER_FLOW_PORT_COMMANDS } from '../src/head-ports';
import { OrderFlowGlspVscodeServer } from '../src/process-diagram-server';

let head: SpawnedServer | undefined;
let glspServer: OrderFlowGlspVscodeServer | undefined;

describe('OrderFlowGlspVscodeServer', () => {
   beforeAll(async () => {
      head = await startSpawnedServer({ serverModule: path.resolve(__dirname, '../../server/lib/main.js') });
   }, SPAWNED_SERVER_HOOK_TIMEOUT_MS);

   afterAll(async () => {
      glspServer?.dispose();
      await head?.dispose();
      restoreLoad();
   }, SPAWNED_SERVER_HOOK_TIMEOUT_MS);

   it("initialises the order-flow GLSP head over the connection GLSP's VS Code integration creates", async () => {
      const spawned = head!;
      glspServer = new OrderFlowGlspVscodeServer({
         clientId: 'order-flow-vscode-test',
         clientName: 'Order Flow',
         findPort: () => spawned.port(ORDER_FLOW_PORT_COMMANDS.glsp)
      });
      await glspServer.start();

      await expect(glspServer.initializeResult).resolves.toHaveProperty('serverActions');
   }, 30_000);
});
