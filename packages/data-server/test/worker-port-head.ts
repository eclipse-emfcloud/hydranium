/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { beforeAll, describe, expect, it } from 'vitest';
import { createMessageConnection, RAL, type MessageConnection } from 'vscode-jsonrpc';
import { createMessagePortTransport, createRpcProxy, type TransferDiagnostic, type TransferredMessagePort } from '@hydranium/protocol';
import { DATA_SERVER_WIRE_PREFIX, type DataServerProtocol } from '@hydranium/protocol/data';
import { waitFor } from '@hydranium/protocol/testing';
import { makeMessagePortPair } from '@hydranium/protocol/testing/node';
import type { AstDiagnostic } from '@hydranium/core';
import { makeTestServices } from '@hydranium/core/testing';
import { DataServer } from '../src/data-server.js';
import { recordSessionEndings } from './session-endings.js';

interface FakeRoot {
   readonly $type: 'FakeRoot';
   readonly name: string;
}

/**
 * A connection over `port` through the transport both ends of a head's port
 * use. The package root's `createMessageConnection` runs on whichever runtime
 * the test file installed.
 */
function connect(port: TransferredMessagePort): MessageConnection {
   const transport = createMessagePortTransport(port);
   return createMessageConnection(transport.reader, transport.writer);
}

/** A data head on one port of a fresh pair, and a client proxy on the other. */
function makeWorkerHead() {
   const bundle = makeTestServices<FakeRoot, AstDiagnostic, FakeRoot>({ serialize: (_uri, root) => `name:${root.name}` });
   const endings = recordSessionEndings(bundle.textDocuments);
   const ports = makeMessagePortPair();
   const serverConnection = connect(ports.port2);
   new DataServer<FakeRoot, TransferDiagnostic>(serverConnection, bundle.services);
   serverConnection.listen();
   const clientConnection = connect(ports.port1);
   clientConnection.listen();
   const proxy = createRpcProxy<DataServerProtocol<FakeRoot>>(clientConnection, { methodNamespace: DATA_SERVER_WIRE_PREFIX });
   return {
      endings,
      proxy,
      clientConnection,
      dispose: () => {
         serverConnection.dispose();
         ports.dispose();
      }
   };
}

/**
 * The data head's teardown over a worker port, under the vscode-jsonrpc runtime
 * the calling test file installed: a client disposing its connection ends its
 * sessions, as a socket's close does, and what it sent first is handled first.
 *
 * Declared once and run under each runtime, because the two dispatch a
 * connection's queue differently: the browser's on microtasks, which drain
 * before the port's next message, and Node's on `setImmediate`, one message per
 * turn, which the close signal's own message would overtake if the transport
 * did not wait for it.
 */
export function describeWorkerPortHead(runtime: 'browser' | 'node'): void {
   describe(`DataServer over a worker port, under the ${runtime} runtime`, () => {
      beforeAll(async () => {
         // Runs before this await resumes only if the runtime queues it as a
         // microtask; a `setImmediate` would still be pending.
         let dispatched = false;
         RAL().timer.setImmediate(() => (dispatched = true));
         await Promise.resolve();
         expect(dispatched, `the ${runtime} runtime is the one installed`).toBe(runtime === 'browser');
      });

      it('ends the sessions of a client that disposes its connection, as lost', async () => {
         const head = makeWorkerHead();
         try {
            await head.proxy.createSession({ clientId: 'page' });
            head.clientConnection.dispose();
            await waitFor(() => head.endings.length > 0);
            expect(head.endings).toEqual([{ clientId: 'page', cause: 'lost' }]);
         } finally {
            head.dispose();
         }
      });

      it('still ends a session on purpose when its close was sent just before the dispose', async () => {
         const head = makeWorkerHead();
         try {
            await head.proxy.createSession({ clientId: 'page' });
            // Written straight onto the connection, so both are on the port
            // before the signal; the proxy would send them a microtask later,
            // after the dispose. The first request queues the close behind
            // another message, which is what a single deferred turn would miss.
            // Not awaited: the dispose follows in the same tick.
            head.clientConnection.sendRequest(`${DATA_SERVER_WIRE_PREFIX}createSession`, { clientId: 'other' }).catch(() => undefined);
            head.clientConnection.sendRequest(`${DATA_SERVER_WIRE_PREFIX}closeSession`, { clientId: 'page' }).catch(() => undefined);
            head.clientConnection.dispose();
            await waitFor(() => head.endings.some(ending => ending.clientId === 'page'));
            expect(head.endings.find(ending => ending.clientId === 'page')).toEqual({ clientId: 'page', cause: 'closed' });
         } finally {
            head.dispose();
         }
      });
   });
}
