/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * Driven through a REAL connection, over a stream pair, with the handler
 * registered the way Langium registers one.
 *
 * A suite that calls the seam directly proves only that the seam works when
 * something reaches it. What has to be shown here is that the handlers a head
 * actually installs go through it: `vscode-languageserver` builds its
 * `Connection` as an object whose named helpers close over the inner protocol
 * connection, so a decoration of the returned object reaches none of them, and a
 * direct-call suite cannot tell that apart from a working seam.
 */

import { LatencyCollector } from '@hydranium/protocol';
import { PassThrough } from 'node:stream';
import { createMessageConnection, StreamMessageReader, StreamMessageWriter } from 'vscode-jsonrpc/node';
import type { Connection } from 'vscode-languageserver';
import { createConnection, ProposedFeatures } from 'vscode-languageserver/node';
import { afterEach, describe, expect, it } from 'vitest';
import { lspLatencyOptions } from '../../src/lsp/lsp-latency.js';

const HOVER_MS = 25;

interface Harness {
   readonly latency: LatencyCollector;
   readonly client: ReturnType<typeof createMessageConnection>;
   readonly server: Connection;
   dispose(): void;
}

/** A server and a client joined by two streams, with `install` deciding the seam. */
function connect(install: (latency: LatencyCollector) => ReturnType<typeof lspLatencyOptions>): Harness {
   const latency = new LatencyCollector();
   const clientToServer = new PassThrough();
   const serverToClient = new PassThrough();

   const server = createConnection(
      ProposedFeatures.all,
      new StreamMessageReader(clientToServer),
      new StreamMessageWriter(serverToClient),
      install(latency)
   );
   server.onInitialize(() => ({ capabilities: { hoverProvider: true } }));
   // The NAMED helper, which is the whole point: Langium's `addCompletionHandler`
   // and its siblings register this way and never call `onRequest` themselves.
   server.onHover(async () => {
      await new Promise(resolve => setTimeout(resolve, HOVER_MS));
      return { contents: 'hovered' };
   });
   server.listen();

   const client = createMessageConnection(new StreamMessageReader(serverToClient), new StreamMessageWriter(clientToServer));
   client.listen();

   return {
      latency,
      client,
      server,
      dispose: () => {
         client.dispose();
         server.dispose();
      }
   };
}

async function hover(harness: Harness): Promise<void> {
   await harness.client.sendRequest('initialize', { processId: null, rootUri: null, capabilities: {} });
   await harness.client.sendRequest('textDocument/hover', {
      textDocument: { uri: 'file:///a.x' },
      position: { line: 0, character: 0 }
   });
}

let open: Harness | undefined;

afterEach(() => {
   open?.dispose();
   open = undefined;
});

describe('lspLatencyOptions', () => {
   it('times a request whose handler was registered through a named helper', async () => {
      open = connect(latency => lspLatencyOptions(latency));
      await hover(open);

      const hovered = open.latency.report().methods.find(method => method.method === 'textDocument/hover');
      expect(hovered?.count).toBe(1);
      // A floor rather than an exact figure: the handler sleeps, so anything at
      // or above that proves the timing spans the handler and not merely the
      // dispatch around it. An equality here would measure the test runner.
      expect(hovered?.maxMs).toBeGreaterThanOrEqual(HOVER_MS - 5);
   });

   it("times `initialize`, which is special-cased away from the connection's own onRequest", async () => {
      open = connect(latency => lspLatencyOptions(latency));
      await hover(open);

      expect(open.latency.report().methods.find(method => method.method === 'initialize')?.count).toBe(1);
   });

   it('installs nothing when no collector is supplied, so the seam costs nothing off', async () => {
      expect(lspLatencyOptions(undefined)).toBeUndefined();

      open = connect(() => undefined);
      await hover(open);

      expect(open.latency.report().methods).toEqual([]);
   });
});
