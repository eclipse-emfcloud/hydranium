/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { connect, createServer as createTcpServer, type Server as TcpServer, type Socket } from 'node:net';

/**
 * A TCP proxy that can half-close a connection, so an e2e suite can reproduce a
 * flaky network against a real browser session.
 *
 * Toggling the browser offline is not enough. On localhost the server sees the
 * close immediately and reaps the socket before the browser reconnects, so the
 * window where both sides disagree about the session — the one where reconnect
 * defects live — never opens. Reaching it needs the browser's socket to die
 * while the server still believes it is alive, and nothing inside the app or in
 * Playwright's offline emulation can produce that asymmetry: both close cleanly
 * at both ends.
 *
 * The proxy holds both halves of every connection and lets a test kill them
 * independently:
 *
 *   `break`    destroy the BROWSER-side sockets, keep the server-side ones open.
 *              The browser reconnects through a fresh pair while the server
 *              still holds the old one.
 *   `release`  destroy the orphaned server-side sockets `break` left. The
 *              server's disconnect handler fires at once, rather than whenever
 *              its next heartbeat write would have failed.
 */

/** Where the proxy listens, and the application it fronts. */
export interface FlakyNetworkProxyOptions {
   /** Port the browser connects to. */
   readonly listenPort: number;
   /** Port of the application being proxied. */
   readonly targetPort: number;
   /** Host of the application being proxied. Defaults to loopback. */
   readonly targetHost?: string;
   /** Port the HTTP control channel listens on. Defaults to `listenPort + 1000`. */
   readonly controlPort?: number;
}

/** The commands the control channel accepts, and the proxy's own vocabulary. */
export type FlakyNetworkCommand = 'break' | 'release' | 'status';

/** Drives a running proxy. Implemented both in-process and over HTTP. */
export interface FlakyNetworkControl {
   /** Kill the browser side of every live connection; leave the server side up. */
   break(): Promise<string>;
   /** Kill the server side of every connection `break` orphaned. */
   release(): Promise<string>;
   /** How many connections are live and how many are orphaned. */
   status(): Promise<string>;
}

export interface FlakyNetworkProxy extends FlakyNetworkControl {
   /** Base URL a browser should be pointed at, i.e. Playwright's `baseURL`. */
   readonly url: string;
   /** Control channel, for workers that cannot reach this object directly. */
   readonly controlUrl: string;
   close(): Promise<void>;
}

interface ConnectionPair {
   readonly id: number;
   readonly browserSocket: Socket;
   readonly targetSocket: Socket;
   orphaned: boolean;
}

/**
 * Starts the proxy in the calling process.
 *
 * Call it from a Playwright config, which runs in the main process before any
 * worker forks. Workers are separate processes and cannot reach the returned
 * object, which is what {@link controlUrl} and {@link flakyNetworkControlClient}
 * are for.
 */
export async function startFlakyNetworkProxy(options: FlakyNetworkProxyOptions): Promise<FlakyNetworkProxy> {
   const targetHost = options.targetHost ?? '127.0.0.1';
   const controlPort = options.controlPort ?? options.listenPort + 1000;
   const pairs = new Set<ConnectionPair>();
   let sequence = 0;
   let transcript: string[] = [];

   const log = (message: string): void => {
      transcript.push(message);
      console.log(`[flaky-network] ${message}`);
   };

   const proxyServer: TcpServer = createTcpServer(browserSocket => {
      const id = ++sequence;
      const targetSocket = connect(options.targetPort, targetHost);
      const pair: ConnectionPair = { id, browserSocket, targetSocket, orphaned: false };
      pairs.add(pair);

      // Forwarded by hand rather than with `pipe()`, so killing one side does not
      // tear the other down — which is the entire point of the proxy.
      browserSocket.on('data', chunk => {
         if (!targetSocket.destroyed) {
            targetSocket.write(chunk);
         }
      });
      targetSocket.on('data', chunk => {
         if (!pair.orphaned && !browserSocket.destroyed) {
            browserSocket.write(chunk);
         }
      });

      const teardown = (origin: 'browser' | 'target'): void => {
         if (pair.orphaned && origin === 'browser') {
            // Expected: `break` killed this side deliberately. The server side
            // stays up until `release`.
            return;
         }
         pairs.delete(pair);
         browserSocket.destroy();
         targetSocket.destroy();
      };

      browserSocket.on('close', () => teardown('browser'));
      targetSocket.on('close', () => teardown('target'));
      // A half-killed pair reliably raises ECONNRESET on the surviving side; an
      // unhandled 'error' would take the whole runner down with it.
      browserSocket.on('error', () => undefined);
      targetSocket.on('error', () => undefined);
   });

   const commands: Record<FlakyNetworkCommand, () => void> = {
      break: () => {
         const live = [...pairs].filter(pair => !pair.orphaned);
         if (live.length === 0) {
            log('nothing to break');
            return;
         }
         for (const pair of live) {
            pair.orphaned = true;
            pair.browserSocket.destroy();
         }
         log(`${live.length} connection(s) broken; the browser should reconnect shortly`);
      },
      release: () => {
         const orphans = [...pairs].filter(pair => pair.orphaned);
         if (orphans.length === 0) {
            log('no orphaned connections; run `break` first');
            return;
         }
         for (const pair of orphans) {
            pairs.delete(pair);
            pair.targetSocket.destroy();
         }
         log(`${orphans.length} orphaned connection(s) destroyed; their late disconnect fires now`);
      },
      status: () => {
         const live = [...pairs].filter(pair => !pair.orphaned).length;
         const orphaned = pairs.size - live;
         log(`${live} live, ${orphaned} orphaned`);
      }
   };

   const run = (name: string): string => {
      transcript = [];
      const command = commands[name as FlakyNetworkCommand];
      if (command) {
         command();
      } else {
         log(`unknown command '${name}'; use: ${Object.keys(commands).join(' | ')}`);
      }
      return transcript.join('\n');
   };

   const controlServer: HttpServer = createHttpServer((request, response) => {
      const output = run((request.url ?? '').replace(/^\//, '').split('?')[0]);
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end(`${output}\n`);
   });

   await Promise.all([listen(proxyServer, options.listenPort), listen(controlServer, controlPort)]);
   // Neither server keeps the process alive, so a runner that starts one from a
   // config does not need a teardown hook to exit — and a caller that wants a
   // deterministic shutdown still has `close()`.
   proxyServer.unref();
   controlServer.unref();

   return {
      url: `http://localhost:${options.listenPort}`,
      controlUrl: `http://localhost:${controlPort}`,
      break: async () => run('break'),
      release: async () => run('release'),
      status: async () => run('status'),
      close: async () => {
         for (const pair of pairs) {
            pair.browserSocket.destroy();
            pair.targetSocket.destroy();
         }
         pairs.clear();
         await Promise.all([close(proxyServer), close(controlServer)]);
      }
   };
}

/**
 * Drives a proxy running in another process, over its control channel.
 *
 * This is what a spec uses: Playwright workers are separate processes from the
 * config that started the proxy.
 */
export function flakyNetworkControlClient(controlUrl: string): FlakyNetworkControl {
   const send = async (command: FlakyNetworkCommand): Promise<string> => {
      const response = await fetch(`${controlUrl}/${command}`);
      if (!response.ok) {
         throw new Error(`flaky-network proxy rejected '${command}': ${response.status}`);
      }
      return (await response.text()).trim();
   };
   return {
      break: () => send('break'),
      release: () => send('release'),
      status: () => send('status')
   };
}

function listen(server: TcpServer | HttpServer, port: number): Promise<void> {
   return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, () => {
         server.off('error', reject);
         resolve();
      });
   });
}

function close(server: TcpServer | HttpServer): Promise<void> {
   return new Promise(resolve => server.close(() => resolve()));
}
