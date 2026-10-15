/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { waitFor } from '@hydranium/protocol/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { SocketDataPort } from '../src/node/socket-data-port';
import { startEchoServer, type EchoServer } from './echo-server';

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
   for (const cleanup of cleanups.splice(0).reverse()) {
      await cleanup();
   }
});

async function makeServer(): Promise<EchoServer> {
   const server = await startEchoServer();
   cleanups.push(() => server.close());
   return server;
}

function makePort(findPort: () => Promise<number>): SocketDataPort {
   const port = new SocketDataPort({ findPort });
   cleanups.push(() => port.dispose());
   return port;
}

describe('SocketDataPort', () => {
   it('hands back a listening connection to the port it finds', async () => {
      const server = await makeServer();
      const port = makePort(async () => server.port);

      const connection = await port.connect();

      await expect(connection.sendRequest('echo', 'one')).resolves.toBe('one');
   });

   it('fires onDispose when the server ends the socket', async () => {
      const server = await makeServer();
      const port = makePort(async () => server.port);
      let disposals = 0;
      port.onDispose(() => disposals++);
      await port.connect();

      server.dropConnections();

      await waitFor(() => disposals === 1);
   });

   it('finds the port again for the next generation', async () => {
      const first = await makeServer();
      const second = await makeServer();
      const ports = [first.port, second.port];
      const port = makePort(async () => ports.shift()!);
      await port.connect();
      first.dropConnections();

      const connection = await port.connect();

      await expect(connection.sendRequest('echo', 'two')).resolves.toBe('two');
      expect(second.accepted()).toBe(1);
   });

   it('closes the previous socket without firing onDispose', async () => {
      const server = await makeServer();
      const port = makePort(async () => server.port);
      let disposals = 0;
      port.onDispose(() => disposals++);
      await port.connect();

      const current = await port.connect();

      await waitFor(() => server.closed() === 1);
      await expect(current.sendRequest('echo', 'three')).resolves.toBe('three');
      expect(disposals).toBe(0);
   });

   it('closes the socket it opened when disposed while connecting', async () => {
      const server = await makeServer();
      let releasePort!: (port: number) => void;
      const port = makePort(() => new Promise<number>(resolve => (releasePort = resolve)));
      const connecting = port.connect();

      port.dispose();
      releasePort(server.port);

      await expect(connecting).rejects.toThrow(/disposed/);
      await waitFor(() => server.accepted() === 1 && server.closed() === 1);
   });

   it('keeps one socket open when two connects overlap', async () => {
      const server = await makeServer();
      let releaseFirst!: (port: number) => void;
      const finds = [new Promise<number>(resolve => (releaseFirst = resolve)), Promise.resolve(server.port)];
      const port = makePort(() => finds.shift()!);
      const first = port.connect();
      await port.connect();

      releaseFirst(server.port);
      await first;

      await waitFor(() => server.accepted() === 2 && server.closed() === 1);
      port.dispose();
      await waitFor(() => server.closed() === 2);
   });

   it('refuses to connect once disposed', async () => {
      const server = await makeServer();
      const port = makePort(async () => server.port);
      await port.connect();

      port.dispose();

      await waitFor(() => server.closed() === 1);
      await expect(port.connect()).rejects.toThrow(/disposed/);
   });

   it('reports an unreachable port as a rejection and stays reusable', async () => {
      const server = await makeServer();
      const gone = await startEchoServer();
      await gone.close();
      const ports = [gone.port, server.port];
      const port = makePort(async () => ports.shift()!);

      await expect(port.connect()).rejects.toThrow(/ECONNREFUSED/);
      const connection = await port.connect();

      await expect(connection.sendRequest('echo', 'four')).resolves.toBe('four');
   });
});
