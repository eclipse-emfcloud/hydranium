/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import * as net from 'node:net';
import {
   type InitializeParameters,
   type InitializeResult,
   JsonrpcGLSPClient,
   type Logger as GlspLogger,
   ServerModule,
   SocketServerLauncher
} from '@eclipse-glsp/server/node.js';
import { DUPLICATE_CLIENT_ID_ERROR_CODE, DuplicateClientIdError } from '@hydranium/protocol';
import { ContainerModule, injectable } from 'inversify';
import { waitFor } from '@hydranium/protocol/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as JsonrpcCommon from 'vscode-jsonrpc';
import type * as JsonrpcNode from 'vscode-jsonrpc/node';
import {
   createMessageConnection,
   ParameterStructures,
   SocketMessageReader,
   SocketMessageWriter,
   type MessageConnection,
   type ResponseMessage
} from 'vscode-jsonrpc/node';
import { HydraniumGlspServer } from '../src/index.js';
import { HydraniumGlspSocketServerLauncher, startGlspServer, type StartedGlspServer } from '../src/node/index.js';
import { makeCapturingGlspLogger, makeNoopGlspLogger } from '../src/testing/index.js';

/**
 * The framework, `@hydranium/protocol` included, runs on a second module
 * instance of `vscode-jsonrpc`, while `@eclipse-glsp/*` load theirs from Node's
 * module cache: the split an install with GLSP's nested copy has.
 */
const separateCopy = await vi.hoisted(async () => {
   const { createRequire } = await import('node:module');
   const { sep } = await import('node:path');
   const require = createRequire(import.meta.url);
   const isCopyModule = (id: string): boolean => id.includes(`${sep}node_modules${sep}vscode-jsonrpc${sep}`);
   const cached = Object.entries(require.cache).filter(([id]) => isCopyModule(id));
   for (const [id] of cached) {
      delete require.cache[id];
   }
   try {
      // Loaded inside the window, so its own `require` of the transport binds this instance.
      require('@hydranium/protocol');
      const node: typeof JsonrpcNode = require('vscode-jsonrpc/node');
      const common: typeof JsonrpcCommon = require('vscode-jsonrpc');
      return { node, common };
   } finally {
      for (const id of Object.keys(require.cache).filter(isCopyModule)) {
         delete require.cache[id];
      }
      for (const [id, module] of cached) {
         require.cache[id] = module;
      }
   }
});
vi.mock('vscode-jsonrpc', () => separateCopy.common);
vi.mock('vscode-jsonrpc/node', () => separateCopy.node);

/** A connection typed by GLSP's copy of `vscode-jsonrpc`, whose message types it sends. */
type GlspConnection = ReturnType<SocketServerLauncher['createConnection']>;

/** The launcher's connection for one socket, as GLSP's `run` builds it per accepted socket. */
class ConnectingLauncher extends HydraniumGlspSocketServerLauncher {
   constructor(logger: GlspLogger) {
      super();
      this.logger = logger;
   }

   connect(socket: net.Socket): GlspConnection {
      return this.createConnection(socket);
   }
}

describe('HydraniumGlspSocketServerLauncher', () => {
   const disposables: Array<() => void> = [];

   afterEach(() => {
      for (const dispose of disposables.splice(0).reverse()) {
         dispose();
      }
   });

   /** A connected socket pair: the head's end over the launcher's connection, the client's over a plain one. */
   async function connect(
      logger: GlspLogger = makeNoopGlspLogger()
   ): Promise<{ head: GlspConnection; client: MessageConnection; clientSocket: net.Socket }> {
      const server = net.createServer();
      disposables.push(() => server.close());
      const accepted = new Promise<net.Socket>(resolve => server.once('connection', resolve));
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      if (address === null || typeof address === 'string') {
         throw new Error(`unexpected server address ${String(address)}`);
      }
      const clientSocket = net.connect(address.port, '127.0.0.1');
      const headSocket = await accepted;
      disposables.push(
         () => clientSocket.destroy(),
         () => headSocket.destroy()
      );
      const head = new ConnectingLauncher(logger).connect(headSocket);
      const client = createMessageConnection(new SocketMessageReader(clientSocket), new SocketMessageWriter(clientSocket));
      disposables.push(
         () => head.dispose(),
         () => client.dispose()
      );
      return { head, client, clientSocket };
   }

   it('runs where GLSP builds its message types from another copy of vscode-jsonrpc', () => {
      expect(JsonrpcGLSPClient.ActionMessageNotification.parameterStructures).not.toBe(ParameterStructures.auto);
   });

   it("sends GLSP's typed messages over the launcher's connection", async () => {
      const { head, client } = await connect();
      const received = new Promise<unknown>(resolve => client.onNotification(JsonrpcGLSPClient.ActionMessageNotification.method, resolve));
      head.listen();
      client.listen();

      const message = { clientId: 'client-1', action: { kind: 'test' } };
      await head.sendNotification(JsonrpcGLSPClient.ActionMessageNotification, message);

      await expect(received).resolves.toEqual(message);
   });

   it('answers a framework error thrown in a request handler with its code and data', async () => {
      const { head, client } = await connect();
      head.onRequest('test/initialize', () => {
         throw new DuplicateClientIdError('client-1');
      });
      head.listen();
      client.listen();

      await expect(client.sendRequest('test/initialize')).rejects.toMatchObject({
         code: DUPLICATE_CLIENT_ID_ERROR_CODE,
         data: { clientId: 'client-1' }
      });
   });

   it("logs the connection's protocol faults through the launcher's logger", async () => {
      const { logger, lines } = makeCapturingGlspLogger();
      const { head, clientSocket } = await connect(logger);
      head.listen();

      const response: ResponseMessage = { jsonrpc: '2.0', id: null, result: null };
      await new SocketMessageWriter(clientSocket).write(response);

      const fault = 'Received response message without id. No further error information provided.';
      await waitFor(() => lines.some(line => line.message === fault));
      expect(lines).toContainEqual({ level: 'error', message: fault, params: [] });
   });
});

/** A server whose `initialize` throws a framework error, to observe the code a client receives. */
@injectable()
class RejectingServer extends HydraniumGlspServer {
   override initialize(_params: InitializeParameters): Promise<InitializeResult> {
      throw new DuplicateClientIdError('client-1');
   }
}

class RejectingServerModule extends ServerModule {
   protected override bindGLSPServer(): typeof RejectingServer {
      return RejectingServer;
   }
}

@injectable()
class AdopterLauncher extends HydraniumGlspSocketServerLauncher {}

describe('startGlspServer', () => {
   const disposables: Array<() => void> = [];

   afterEach(() => {
      for (const dispose of disposables.splice(0).reverse()) {
         dispose();
      }
   });

   /** Start a head and return the launcher it resolved, and a client connected to it. */
   async function startHead(appModules: ContainerModule[] = []): Promise<{ launcher: SocketServerLauncher; client: MessageConnection }> {
      const resolved: SocketServerLauncher[] = [];
      // Observed under both ids, so a head that bypasses GLSP's token is still torn down.
      const observe = new ContainerModule((_bind, _unbind, _isBound, _rebind, _unbindAsync, onActivation) => {
         for (const id of [SocketServerLauncher, HydraniumGlspSocketServerLauncher]) {
            onActivation<SocketServerLauncher>(id, (_context, launcher) => {
               resolved.push(launcher);
               return launcher;
            });
         }
      });
      const server: StartedGlspServer = startGlspServer({
         createLogger: makeNoopGlspLogger,
         serverModule: new RejectingServerModule(),
         appModules: [...appModules, observe]
      });
      const [launcher] = resolved;
      if (launcher === undefined) {
         throw new Error('startGlspServer resolved no launcher');
      }
      disposables.push(() => launcher.shutdown());
      await server.started;
      const socket = net.connect(server.port ?? 0, '127.0.0.1');
      const client = createMessageConnection(new SocketMessageReader(socket), new SocketMessageWriter(socket));
      disposables.push(
         () => client.dispose(),
         () => socket.destroy()
      );
      client.listen();
      return { launcher, client };
   }

   it('runs on HydraniumGlspSocketServerLauncher, so a framework error keeps its code and data', async () => {
      const { launcher, client } = await startHead();

      expect(launcher).toBeInstanceOf(HydraniumGlspSocketServerLauncher);
      await expect(
         client.sendRequest(JsonrpcGLSPClient.InitializeRequest.method, { applicationId: 'test-app', protocolVersion: '1.0.0' })
      ).rejects.toMatchObject({
         code: DUPLICATE_CLIENT_ID_ERROR_CODE,
         data: { clientId: 'client-1' }
      });
   });

   it("runs on the launcher an adopter's appModules rebind", async () => {
      const adopter = new ContainerModule((_bind, _unbind, _isBound, rebind) => {
         rebind(SocketServerLauncher).to(AdopterLauncher);
      });

      const { launcher } = await startHead([adopter]);

      expect(launcher).toBeInstanceOf(AdopterLauncher);
   });

   it("refuses a launcher an adopter's appModules bind a second time", () => {
      const adopter = new ContainerModule(bind => {
         bind(SocketServerLauncher).to(AdopterLauncher);
      });

      expect(() =>
         startGlspServer({ createLogger: makeNoopGlspLogger, serverModule: new RejectingServerModule(), appModules: [adopter] })
      ).toThrow('Ambiguous match found for serviceIdentifier');
   });
});
