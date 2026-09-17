/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * `RpcConnection`'s reconnect policy — the generation a port dispose drops and
 * the one the next request builds.
 *
 * Every generation gets its OWN duplex pair, answering `ping` with its own
 * label. A reused far end makes "the proxy was rebuilt" and "the proxy is still
 * the dead one" answer identically, so a test over a shared server would pass
 * for a connection that never reconnects.
 */

import { describe, expect, it } from 'vitest';
import type { MessageConnection } from 'vscode-jsonrpc';
import type { ReadyServer, RpcConnectionLifecycle } from '../../src/client/rpc-connection';
import { RpcConnection } from '../../src/client/rpc-connection';
import { bindRpcMethods } from '../../src/rpc/bind-rpc-methods';
import { tick, waitFor } from '../../src/testing';
import { makeFakeDataPort } from '../../src/testing/data-doubles';
import { type DuplexConnectionPair, makeDuplexConnectionPair } from '../../src/testing/node';

const WIRE_PREFIX = 'test/';

interface TestServer extends ReadyServer {
   ping(args: { value: string }): Promise<string>;
}

/** Inbound target, so a generation's client binding is observable. */
class RecordingClient {
   readonly notes: string[] = [];
   onNoted(args: { note: string }): void {
      this.notes.push(args.note);
   }
}

const CLIENT_METHODS = ['onNoted'] as const satisfies readonly (keyof RecordingClient & string)[];

interface ServerDouble {
   /** Push a notification at whichever client is still bound to this generation. */
   note(text: string): void;
}

/** A server answering `ping` with `label`, so the answer names the generation. */
function serveGeneration(connection: MessageConnection, label: string): ServerDouble {
   const target = {
      waitForReady: async (): Promise<void> => undefined,
      ping: async (): Promise<string> => label
   };
   bindRpcMethods(connection, target, ['waitForReady', 'ping'], { methodNamespace: WIRE_PREFIX });
   return {
      note(text: string): void {
         void connection.sendNotification(`${WIRE_PREFIX}onNoted`, { note: text }).catch(() => undefined);
      }
   };
}

interface Harness {
   readonly rpc: RpcConnection<TestServer, RecordingClient>;
   readonly port: ReturnType<typeof makeFakeDataPort>;
   readonly client: RecordingClient;
   /** One entry per generation the port has opened, in order. */
   readonly servers: readonly ServerDouble[];
   dispose(): void;
}

function harness(lifecycle: RpcConnectionLifecycle = {}): Harness {
   const pairs: DuplexConnectionPair[] = [];
   const servers: ServerDouble[] = [];
   const client = new RecordingClient();
   const port = makeFakeDataPort({
      connect: () => {
         const pair = makeDuplexConnectionPair();
         pairs.push(pair);
         servers.push(serveGeneration(pair.left, `generation-${pairs.length}`));
         return pair.right;
      }
   });
   const rpc = new RpcConnection<TestServer, RecordingClient>(port, client, {
      methodNamespace: WIRE_PREFIX,
      clientMethods: CLIENT_METHODS,
      lifecycle
   });
   return {
      rpc,
      port,
      client,
      servers,
      dispose: () => {
         rpc.dispose();
         pairs.forEach(pair => pair.dispose());
         port.dispose();
      }
   };
}

describe('RpcConnection reconnect', () => {
   it('builds a fresh generation after the port disposes', async () => {
      const test = harness();
      try {
         expect(await (await test.rpc.connected()).ping({ value: 'x' })).toBe('generation-1');

         test.port.fireDispose();

         // The far end names itself, because a retained generation answers a
         // request just as successfully as a rebuilt one.
         expect(await (await test.rpc.connected()).ping({ value: 'x' })).toBe('generation-2');
         expect(test.port.connections).toHaveLength(2);
      } finally {
         test.dispose();
      }
   });

   it('re-runs the readiness gate for the new generation', async () => {
      let readyCount = 0;
      const test = harness({ onReady: () => readyCount++ });
      try {
         await test.rpc.connected();
         expect(readyCount).toBe(1);

         test.port.fireDispose();
         await test.rpc.connected();

         // A restarted server has an unwarmed workspace, so a readiness promise
         // carried over from the dead generation would admit the first request
         // while it is still walking it.
         expect(readyCount).toBe(2);
      } finally {
         test.dispose();
      }
   });

   it('binds the client methods once per generation, not cumulatively', async () => {
      const test = harness();
      try {
         await test.rpc.connected();
         test.servers[0].note('first');
         await waitFor(() => test.client.notes.length === 1);

         test.port.fireDispose();
         await test.rpc.connected();
         expect(test.port.connections).toHaveLength(2);

         // Both ends speak: a dead generation still bound would record the stale
         // note, and a surviving inbound binding on a shared far end would record
         // the live one twice. For a real client either is a duplicated model
         // update rather than a crash.
         test.servers[0].note('stale');
         test.servers[1].note('second');
         await waitFor(() => test.client.notes.length > 1);
         await tick();

         expect(test.client.notes).toEqual(['first', 'second']);
      } finally {
         test.dispose();
      }
   });

   it('answers the server getter from the current generation', async () => {
      const test = harness();
      try {
         await test.rpc.connected();
         const proxy = test.rpc.server;
         expect(test.rpc.server).toBe(proxy);

         test.port.fireDispose();
         const afterReconnect = test.rpc.server;

         // Read per access: a caller holding `proxy` across the reconnect
         // addresses a disposed connection, where requests never settle.
         expect(afterReconnect).not.toBe(proxy);
         expect(await afterReconnect.ping({ value: 'x' })).toBe('generation-2');
      } finally {
         test.dispose();
      }
   });
});
