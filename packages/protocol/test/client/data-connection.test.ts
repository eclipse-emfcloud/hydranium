/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * Several participants over one data connection.
 *
 * The assertions worth having read the clientId the SERVER received, not the
 * one the session reports: the server keys its holds and watches per
 * `(uri, clientId)`, so a stamp that never reaches the wire buys nothing.
 */

import { describe, expect, it } from 'vitest';
import type { MessageConnection } from 'vscode-jsonrpc';
import { DataConnection } from '../../src/client/data-connection';
import { DataEvents } from '../../src/client/data-events';
import { DATA_SERVER_WIRE_PREFIX } from '../../src/data';
import { bindRpcMethods } from '../../src/rpc/bind-rpc-methods';
import { tick, waitFor } from '../../src/testing';
import { makeFakeDataPort } from '../../src/testing/data-doubles';
import { makeDuplexConnectionPair } from '../../src/testing/node';
import type { TransferElement } from '../../src/transfer-element';

interface ProbeElement extends TransferElement {
   $type: 'TypeOne';
}

interface ServerCall {
   readonly method: 'open' | 'watch' | 'close' | 'update';
   readonly uri: string;
   readonly clientId: string;
}

const URI_A = 'file:///a.x';
const URI_B = 'file:///b.x';
const URI_C = 'file:///c.x';

function document(uri: string): unknown {
   return { uri, version: 1, root: { $type: 'TypeOne' }, diagnostics: [] };
}

/** Bind a server that records the `(method, uri, clientId)` of every call. */
function recordingServer(connection: MessageConnection): ServerCall[] {
   const calls: ServerCall[] = [];
   const record =
      (method: ServerCall['method']) =>
      async (args: { uri: string; clientId: string }): Promise<unknown> => {
         calls.push({ method, uri: args.uri, clientId: args.clientId });
         return document(args.uri);
      };
   const target = {
      waitForReady: async (): Promise<void> => undefined,
      openModelDocument: record('open'),
      watchModelDocument: record('watch'),
      closeModelDocument: record('close'),
      updateModelDocument: record('update')
   };
   bindRpcMethods(
      connection,
      target,
      ['waitForReady', 'openModelDocument', 'watchModelDocument', 'closeModelDocument', 'updateModelDocument'],
      {
         methodNamespace: DATA_SERVER_WIRE_PREFIX
      }
   );
   return calls;
}

function harness(): { connection: DataConnection<ProbeElement>; calls: ServerCall[]; dispose(): void } {
   const pair = makeDuplexConnectionPair();
   const calls = recordingServer(pair.left);
   const port = makeFakeDataPort({ connect: () => pair.right });
   const connection = new DataConnection<ProbeElement>(port, new DataEvents<ProbeElement>());
   return {
      connection,
      calls,
      dispose: () => {
         connection.dispose();
         pair.dispose();
      }
   };
}

const opens = (calls: readonly ServerCall[]): ServerCall[] => calls.filter(call => call.method === 'open');
const closes = (calls: readonly ServerCall[]): ServerCall[] => calls.filter(call => call.method === 'close');

describe('DataConnection lifecycle hooks', () => {
   it('reports connecting then ready around the two waits', async () => {
      const pair = makeDuplexConnectionPair();
      recordingServer(pair.left);
      const port = makeFakeDataPort({ connect: () => pair.right });
      const steps: string[] = [];
      const connection = new DataConnection<ProbeElement>(port, new DataEvents<ProbeElement>(), {
         onConnecting: () => steps.push('connecting'),
         onReady: () => steps.push('ready'),
         onFailed: () => steps.push('failed')
      });
      try {
         await connection.createSession('panel').openDocument(URI_A);
         expect(steps).toEqual(['connecting', 'ready']);
      } finally {
         connection.dispose();
         pair.dispose();
      }
   });

   it('reports a failure instead of readiness when the transport never opens', async () => {
      const steps: string[] = [];
      const port = makeFakeDataPort({ connect: () => Promise.reject(new Error('no transport')) });
      const connection = new DataConnection<ProbeElement>(port, new DataEvents<ProbeElement>(), {
         onConnecting: () => steps.push('connecting'),
         onReady: () => steps.push('ready'),
         onFailed: () => steps.push('failed')
      });
      try {
         await expect(connection.connected()).rejects.toThrow('no transport');
         expect(steps).toEqual(['connecting', 'failed']);
      } finally {
         connection.dispose();
      }
   });
});

describe('DataConnection sessions', () => {
   it('stamps each session its own clientId on the wire', async () => {
      const { connection, calls, dispose } = harness();
      try {
         const panel = connection.createSession('panel');
         const tree = connection.createSession('tree');

         await panel.openDocument(URI_A);
         await tree.openDocument(URI_A);

         // One connection, one document, two holders — which is the whole point
         // of the split. A session taking its identity from the transport would
         // send 'panel' twice and the server would see a single holder.
         expect(opens(calls).map(call => call.clientId)).toEqual(['panel', 'tree']);
      } finally {
         dispose();
      }
   });

   it('stamps the session clientId on a write the caller did not supply one for', async () => {
      const { connection, calls, dispose } = harness();
      try {
         const tree = connection.createSession('tree');
         await tree.updateDocument({ uri: URI_A, model: { $type: 'TypeOne' } });

         expect(calls.filter(call => call.method === 'update')).toEqual([{ method: 'update', uri: URI_A, clientId: 'tree' }]);
      } finally {
         dispose();
      }
   });

   it('recognises only its own echo', () => {
      const { connection, dispose } = harness();
      try {
         const panel = connection.createSession('panel');
         const tree = connection.createSession('tree');

         // Sharing one identity would make both answer the same way for both
         // ids, so the disagreement is the property.
         expect(panel.isOwnEcho('panel')).toBe(true);
         expect(panel.isOwnEcho('tree')).toBe(false);
         expect(tree.isOwnEcho('tree')).toBe(true);
      } finally {
         dispose();
      }
   });

   it('releases only the disposing session holds and leaves the connection usable', async () => {
      const { connection, calls, dispose } = harness();
      try {
         const panel = connection.createSession('panel');
         const tree = connection.createSession('tree');
         await panel.openDocument(URI_A);
         await tree.openDocument(URI_B);

         panel.dispose();
         await waitFor(() => closes(calls).length > 0);

         // A round trip AFTER the close landed, so a wrongly-issued close for
         // the other session has had a full exchange to arrive before the
         // count is read — and it proves the connection outlives its session.
         await tree.openDocument(URI_C);

         expect(closes(calls)).toEqual([{ method: 'close', uri: URI_A, clientId: 'panel' }]);
         expect(opens(calls).map(call => call.uri)).toEqual([URI_A, URI_B, URI_C]);
      } finally {
         dispose();
      }
   });

   it('detaches its sessions on dispose rather than closing over a dying wire', async () => {
      const { connection, calls, dispose } = harness();
      try {
         const panel = connection.createSession('panel');
         await panel.openDocument(URI_A);

         connection.dispose();
         await tick();

         // The server drains every hold on a connection it sees close, so a
         // close here would travel over the connection being disposed. The
         // session-dispose case above is what proves closes are sent when the
         // wire survives, so the two together discriminate.
         expect(closes(calls)).toEqual([]);
         await expect(panel.openDocument(URI_C)).rejects.toThrow('DataSession is disposed');
      } finally {
         dispose();
      }
   });
});
