/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { ORDER_FLOW_DATA_SERVER_PORT_COMMAND, ORDER_FLOW_GLSP_PORT_COMMAND } from '@hydranium/example-order-flow-server/lib/head-ports.js';
import { describe, expect, it } from 'vitest';
import { ORDER_FLOW_HOST_PORT_COMMANDS } from '../src/common/order-flow-diagram-language';

/**
 * The Theia backend discovers each socket head by executing a HOST command that
 * the VS Code extension registers — `order-flow.port.<head>` — one per LSP
 * request id the server answers with a port.
 *
 * Nothing detects a drift at runtime: `AbstractSocketForwardingConnectionHandler` polls
 * with `findPortAttempts = -1`, so a wrong id retries forever and the diagram or
 * the properties panel simply never connects, with no error anywhere. The ids
 * live in a VS Code extension package that a Theia extension must not depend on,
 * so they are restated in `common/` and pinned here.
 */
describe('ORDER_FLOW_HOST_PORT_COMMANDS', () => {
   it('names one host command per head the server publishes', () => {
      expect(Object.keys(ORDER_FLOW_HOST_PORT_COMMANDS).sort()).toEqual(['dataServer', 'glsp']);
   });

   it.each([
      ['dataServer', ORDER_FLOW_DATA_SERVER_PORT_COMMAND],
      ['glsp', ORDER_FLOW_GLSP_PORT_COMMAND]
   ])('derives the %s host id the way the extension registers it', head => {
      // The extension declares its host ids as `order-flow.port.<head>` and
      // registers one command per head, mapping each to the LSP request id that
      // answers with that head's port. Same naming rule, restated.
      expect(ORDER_FLOW_HOST_PORT_COMMANDS[head as keyof typeof ORDER_FLOW_HOST_PORT_COMMANDS]).toBe(`order-flow.port.${head}`);
   });

   it('does not use the LSP request ids, which name a different namespace', () => {
      // The distinction that actually bites: both id families exist, they differ
      // only in spelling, and picking the wrong one fails silently.
      const hostIds: string[] = Object.values(ORDER_FLOW_HOST_PORT_COMMANDS);
      expect(hostIds).not.toContain(ORDER_FLOW_DATA_SERVER_PORT_COMMAND);
      expect(hostIds).not.toContain(ORDER_FLOW_GLSP_PORT_COMMAND);
   });
});
