/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * `startStdioServer` — driven over an in-memory stream pair rather than a
 * spawned process, so the **ordering** guarantee can be observed directly.
 *
 * That ordering is the whole reason the launcher exists. A stdio head has no
 * LSP `initialize` to bring its workspace up, so it must do that itself, and it
 * must finish before the reader is attached: nothing drains the input stream
 * until `connection.listen()`, so a request arriving during startup waits in
 * the buffer. Get it backwards and the failure is not an error but an answer
 * computed against an empty project registry — which is precisely the kind of
 * thing a spawned-subprocess test cannot see and an in-memory one can.
 */

import { createMessageConnection, StreamMessageReader, StreamMessageWriter } from 'vscode-jsonrpc/node';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import type { ServerSharedServicesMinimal } from '../../src/langium/shared-services.js';
import { makeNoopSharedServices } from '../../src/testing/make-noop-shared-services.js';
import { startStdioServer, type StartedStdioServer } from '../../src/node/stdio-launcher.js';

/** A request the test server answers, standing in for any real protocol method. */
const PING = 'test/ping';

/**
 * Shared-services stub exposing only what the launcher touches: the workspace
 * manager's `initialize` / `initialized` pair, which is what
 * `initializeWorkspaceProgrammatically` drives. Using a stub rather than a real
 * services tree is deliberate — it lets a test control exactly when
 * initialization completes, which is the property under test.
 */
function makeStubShared(initialized: () => Promise<void>): ServerSharedServicesMinimal {
   return makeNoopSharedServices({
      workspace: { WorkspaceManager: { initialize: () => undefined, initialized } }
   });
}

interface Harness {
   readonly server: StartedStdioServer;
   /** Send `test/ping` from the client end and resolve with the reply. */
   ping(): Promise<string>;
   dispose(): void;
}

/**
 * Wire a client and a launcher back to back over two `PassThrough` streams.
 * `onRequest` reports what the server saw at the moment the request ran.
 */
function makeHarness(options: { initialized: () => Promise<void>; workspace?: string; onRequest?: () => string }): Harness {
   const toServer = new PassThrough();
   const toClient = new PassThrough();

   const server = startStdioServer(
      {
         shared: makeStubShared(options.initialized),
         workspace: options.workspace,
         input: toServer,
         output: toClient
      },
      connection => {
         connection.onRequest(PING, () => options.onRequest?.() ?? 'pong');
         return { dispose: () => undefined };
      }
   );

   const client = createMessageConnection(new StreamMessageReader(toClient), new StreamMessageWriter(toServer));
   client.listen();

   return {
      server,
      ping: () => client.sendRequest<string>(PING),
      dispose: () => {
         client.dispose();
         server.close();
      }
   };
}

let harness: Harness | undefined;

afterEach(() => {
   harness?.dispose();
   harness = undefined;
});

describe('startStdioServer', () => {
   it('initializes the workspace before it starts reading requests', async () => {
      let initDone = false;
      harness = makeHarness({
         workspace: '/some/workspace',
         initialized: async () => {
            // A TIMER, not a microtask yield. The first version of this test
            // awaited `Promise.resolve()` twice and passed with the ordering
            // deliberately reversed — a stream write plus parse costs at least a
            // macrotask, so init won either way and the test asserted nothing.
            // Holding init open across a real timer is what makes a
            // listen-first launcher actually lose the race.
            await new Promise(resolve => setTimeout(resolve, 50));
            initDone = true;
         },
         onRequest: () => (initDone ? 'after-init' : 'RACED-init')
      });

      // Sent immediately — before `started` resolves, so it is in flight while
      // initialization is still running. It must wait in the pipe, not race.
      const reply = harness.ping();
      await harness.server.started;

      expect(await reply).toBe('after-init');
   });

   it('resolves started only once the head can answer', async () => {
      let released = (): void => undefined;
      const gate = new Promise<void>(resolve => {
         released = resolve;
      });
      let startedResolved = false;

      harness = makeHarness({ workspace: '/some/workspace', initialized: () => gate });
      void harness.server.started.then(() => {
         startedResolved = true;
      });

      await Promise.resolve();
      expect(startedResolved).toBe(false);

      released();
      await harness.server.started;
      expect(startedResolved).toBe(true);
      expect(await harness.ping()).toBe('pong');
   });

   it('skips initialization entirely when no workspace is given', async () => {
      let initCalls = 0;
      harness = makeHarness({
         initialized: async () => {
            initCalls += 1;
         }
      });

      await harness.server.started;

      // The caller said it had already initialized; the launcher only wires the
      // transport in that case.
      expect(initCalls).toBe(0);
      expect(await harness.ping()).toBe('pong');
   });

   it('rejects started and closes rather than serving an uninitialized workspace', async () => {
      harness = makeHarness({
         workspace: '/some/workspace',
         initialized: () => Promise.reject(new Error('discovery blew up'))
      });

      await expect(harness.server.started).rejects.toThrow(/discovery blew up/);
      // A half-live head is worse than a dead one: it would answer against an
      // empty registry, so a failed startup must tear the connection down.
      await expect(harness.server.stopped).resolves.toBeUndefined();
   });
});
