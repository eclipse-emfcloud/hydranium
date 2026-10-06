/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

// The real base class pulls Theia's monaco-coupled chain, and the real
// client-theia browser barrel touches `document`. The stand-ins carry only what
// the contribution reads, with upstream's defaults.
vi.mock('@eclipse-glsp/theia-integration', async () => {
   const { Deferred } = await import('@theia/core/lib/common/promise-util.js');
   const { DisposableCollection } = await import('@theia/core');
   return {
      BaseGLSPClientContribution: class BaseGLSPClientContribution {
         glspClientDeferred = new Deferred<unknown>();
         toDispose = new DisposableCollection();
         glspClientStartupTimeout = 15_000;
         get glspClient(): Promise<unknown> {
            return this.glspClientDeferred.promise;
         }
         async createInitializeParameters(): Promise<object> {
            return {};
         }
         async disposeChannel(): Promise<void> {}
         dispose(): void {
            this.toDispose.dispose();
         }
      }
   };
});
vi.mock('@hydranium/client-theia/lib/browser', () => ({
   ChannelLogger: class ChannelLogger {},
   ConnectionReporter: Symbol('ConnectionReporter')
}));
vi.mock('@theia/workspace/lib/browser', () => ({
   WorkspaceService: class WorkspaceService {}
}));

import { ClientState } from '@eclipse-glsp/client';
import { createChannelConnection } from '@eclipse-glsp/theia-integration/lib/common';
import { type Channel } from '@theia/core';
import { ForwardingChannel } from '@theia/core/lib/common/message-rpc/channel';
import { Uint8ArrayReadBuffer, Uint8ArrayWriteBuffer } from '@theia/core/lib/common/message-rpc/uint8-array-message-buffer';
import { Deferred } from '@theia/core/lib/common/promise-util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NotificationType, ParameterStructures, RAL, type MessageConnection } from 'vscode-jsonrpc';
import { DEFAULT_GLSP_CLIENT_STARTUP_TIMEOUT_MS, HydraniumGlspClientContribution } from '../../src/browser/client-contribution';

interface FakeConnection {
   onDispose(): void;
   onClose(listener: () => void): void;
   close(): void;
}

/** Whether `value` is a connection rather than a function providing one. */
function isMessageConnection(value: unknown): value is MessageConnection {
   return typeof value === 'object' && value !== null && 'sendNotification' in value;
}

function makeConnection(): FakeConnection {
   const listeners: Array<() => void> = [];
   return {
      onDispose: () => undefined,
      onClose: listener => listeners.push(listener),
      close: () => listeners.forEach(listener => listener())
   };
}

interface FakeClient {
   readonly name: string;
   start(): Promise<void>;
   initializeServer(): Promise<object>;
   stop(): void;
   onCurrentStateChanged(listener: (state: ClientState) => void): { dispose(): void };
   setState(state: ClientState): void;
}

/** What the reporter was told, one entry per attempt. */
interface ReportedAttempt {
   outcome?: 'connected' | 'failed' | 'cancelled';
   message?: string;
   retry?: () => void;
}

/** Each start takes its connection from `connections`, in order, so a test
 *  decides when, and whether, each one arrives. */
class TestContribution extends HydraniumGlspClientContribution {
   readonly connections: Array<Deferred<FakeConnection | MessageConnection>> = [];
   readonly clients: FakeClient[] = [];
   /** The connection each client was created over. */
   readonly clientConnections: unknown[] = [];
   readonly attempts: ReportedAttempt[] = [];
   readonly infos = vi.fn();
   /** Whether each client's `initializeServer` never answers. */
   initializeHangs = false;

   constructor(startupTimeoutMs?: number) {
      super({ languageContributionId: 'test', startupTimeoutMs });
      Object.assign(this, {
         restartDelaysMs: [1],
         workspaceService: { tryGetRoots: () => [{}] },
         logger: { info: this.infos },
         connectionReporter: {
            connecting: () => {
               const attempt: ReportedAttempt = {};
               this.attempts.push(attempt);
               return {
                  connected: () => (attempt.outcome = 'connected'),
                  cancelled: () => (attempt.outcome = 'cancelled'),
                  failed: (message: string, retry?: () => void) => Object.assign(attempt, { outcome: 'failed', message, retry })
               };
            }
         }
      });
   }

   get startupTimeout(): number {
      return this.glspClientStartupTimeout;
   }

   begin(): Promise<void> {
      return this.activateClient();
   }

   /** Queue the connection the next start receives. */
   nextConnection(): Deferred<FakeConnection | MessageConnection> {
      const connection = new Deferred<FakeConnection | MessageConnection>();
      this.connections.push(connection);
      return connection;
   }

   closeChannel(channel: Channel): Promise<void> {
      return this.disposeChannel({} as never, channel);
   }

   openChannel(): ReturnType<HydraniumGlspClientContribution['createChannelConnection']> {
      return this.createChannelConnection();
   }

   protected override createConnection(): never {
      const next = this.connections.shift();
      if (!next) {
         throw new Error('no connection queued');
      }
      return next.promise as never;
   }

   protected override async createGLSPClient(
      connectionProvider: Parameters<HydraniumGlspClientContribution['createGLSPClient']>[0]
   ): Promise<never> {
      this.clientConnections.push(connectionProvider);
      const listeners: Array<(state: ClientState) => void> = [];
      const client: FakeClient = {
         name: `client ${this.clients.length + 1}`,
         start: async () => undefined,
         initializeServer: () => (this.initializeHangs ? new Promise<object>(() => undefined) : Promise.resolve({})),
         stop: () => undefined,
         onCurrentStateChanged: listener => {
            listeners.push(listener);
            return { dispose: () => listeners.splice(listeners.indexOf(listener), 1) };
         },
         setState: state => [...listeners].forEach(listener => listener(state))
      };
      this.clients.push(client);
      return client as never;
   }
}

describe('HydraniumGlspClientContribution', () => {
   const contributions: TestContribution[] = [];
   const make = (startupTimeoutMs?: number): TestContribution => {
      const contribution = new TestContribution(startupTimeoutMs);
      contributions.push(contribution);
      return contribution;
   };
   afterEach(() => contributions.splice(0).forEach(contribution => contribution.dispose()));

   it('bounds a start by 30 s unless the options say otherwise', () => {
      expect(make().startupTimeout).toBe(DEFAULT_GLSP_CLIENT_STARTUP_TIMEOUT_MS);
      expect(DEFAULT_GLSP_CLIENT_STARTUP_TIMEOUT_MS).toBe(30_000);
      expect(make(5).startupTimeout).toBe(5);
   });

   it('reports a start that connects', async () => {
      const contribution = make();
      contribution.nextConnection().resolve(makeConnection());
      await contribution.begin();

      const client = await contribution.glspClient;
      expect(client).toBe(contribution.clients[0]);
      expect(contribution.attempts).toEqual([{ outcome: 'connected' }]);
   });

   /**
    * A server that never answers leaves every diagram load waiting on the
    * client, with nothing reported.
    */
   it('fails a start that runs out of time, with a Retry', async () => {
      const contribution = make(10);
      contribution.nextConnection();
      void contribution.begin();

      await expect(contribution.glspClient).rejects.toThrow('The diagram server did not answer within 0 seconds.');
      await vi.waitFor(() => expect(contribution.attempts[0].outcome).toBe('failed'));
      expect(contribution.attempts[0].message).toBe('The diagram server did not answer within 0 seconds.');
      expect(contribution.attempts[0].retry).toBeTypeOf('function');
   });

   it('fails a start whose connection closes before the server answers', async () => {
      const contribution = make();
      contribution.initializeHangs = true;
      const closing = makeConnection();
      contribution.nextConnection().resolve(closing);
      void contribution.begin();
      await vi.waitFor(() => expect(contribution.clients).toHaveLength(1));
      closing.close();

      await expect(contribution.glspClient).rejects.toThrow('Could not connect to the diagram server.');
      await vi.waitFor(() => expect(contribution.attempts[0].message).toBe('Could not connect to the diagram server.'));
   });

   /** The server can come up after the first attempt gave up; waiting for a
    *  user to act would leave every diagram failed until then. */
   it('starts again on its own after a failed start', async () => {
      const contribution = make(10);
      contribution.nextConnection();
      contribution.nextConnection().resolve(makeConnection());
      void contribution.begin();

      await vi.waitFor(() => expect(contribution.attempts.map(attempt => attempt.outcome)).toEqual(['failed', 'connected']));
      const client = await contribution.glspClient;
      expect(client).toBe(contribution.clients[0]);
   });

   /** Every diagram load reads the client, so reading it is what lets a
    *  diagram's retry, or a reopened tab, recover from a failed start. */
   it('starts a fresh client when the client is read after a failed start', async () => {
      const contribution = make(10);
      contribution.nextConnection();
      void contribution.begin();
      await expect(contribution.glspClient).rejects.toThrow();

      contribution.nextConnection().resolve(makeConnection());
      const client = await contribution.glspClient;
      expect(client).toBe(contribution.clients[0]);
   });

   /** A language-server restart takes the GLSP server with it; without a
    *  restart the diagrams have no server until the window reloads. */
   it('starts a fresh client when a started one loses its connection', async () => {
      const contribution = make();
      contribution.nextConnection().resolve(makeConnection());
      await contribution.begin();
      await contribution.glspClient;

      contribution.nextConnection().resolve(makeConnection());
      contribution.clients[0].setState(ClientState.ServerError);

      const client = await contribution.glspClient;
      expect(client).toBe(contribution.clients[1]);
      await vi.waitFor(() => expect(contribution.attempts.map(attempt => attempt.outcome)).toEqual(['connected', 'connected']));
   });

   /** A dispose stops the client too, and that stop is not a loss to recover from. */
   it('does not replace a client that a dispose stopped', async () => {
      const contribution = make();
      contribution.nextConnection().resolve(makeConnection());
      await contribution.begin();
      const client = await contribution.glspClient;
      const lost = vi.fn();
      contribution.onDidLoseClient(lost);

      contribution.dispose();
      contribution.clients[0].setState(ClientState.Stopped);

      expect(lost).not.toHaveBeenCalled();
      expect(await contribution.glspClient).toBe(client);
   });

   /** A listener reopening its diagrams then loads them on the replacement, not the lost client. */
   it('announces a lost client once the client it hands out is the replacement', async () => {
      const contribution = make();
      contribution.nextConnection().resolve(makeConnection());
      await contribution.begin();
      const started = vi.fn();
      contribution.onDidStartClient(started);
      await contribution.glspClient;
      let afterLoss: Promise<unknown> | undefined;
      contribution.onDidLoseClient(() => (afterLoss = contribution.glspClient));

      contribution.nextConnection().resolve(makeConnection());
      contribution.clients[0].setState(ClientState.ServerError);

      expect(await afterLoss).toBe(contribution.clients[1]);
      await vi.waitFor(() => expect(started).toHaveBeenLastCalledWith(contribution.clients[1]));
   });

   /** Upstream's client logs that it will not be restarted, and its id names the server, not the client. */
   it('logs each client it starts and loses, by number', async () => {
      const contribution = make();
      contribution.nextConnection().resolve(makeConnection());
      contribution.nextConnection().resolve(makeConnection());
      await contribution.begin();
      await contribution.glspClient;

      contribution.clients[0].setState(ClientState.ServerError);
      await vi.waitFor(() => expect(contribution.infos).toHaveBeenCalledTimes(3));

      expect(contribution.infos.mock.calls.map(call => call[0])).toEqual([
         '[test] Diagram client 1 started.',
         '[test] Diagram client 1 lost; starting a fresh one in 1 ms.',
         '[test] Diagram client 2 started.'
      ]);
   });

   /** A server that fails right after it starts would otherwise be restarted as fast as it can fail. */
   it('backs off while clients are lost soon after starting', async () => {
      const contribution = make();
      Object.assign(contribution, { restartDelaysMs: [1, 1_000] });
      contribution.nextConnection().resolve(makeConnection());
      contribution.nextConnection().resolve(makeConnection());
      contribution.nextConnection().resolve(makeConnection());
      await contribution.begin();
      await contribution.glspClient;

      contribution.clients[0].setState(ClientState.ServerError);
      await vi.waitFor(() => expect(contribution.clients).toHaveLength(2));
      await contribution.glspClient;
      contribution.clients[1].setState(ClientState.ServerError);
      await new Promise(resolve => setTimeout(resolve, 50));

      expect(contribution.clients).toHaveLength(2);
   });

   it('starts the delays over once a client stayed up', async () => {
      const contribution = make();
      Object.assign(contribution, { restartDelaysMs: [1, 1_000], restartEscalationResetMs: 10 });
      contribution.nextConnection().resolve(makeConnection());
      contribution.nextConnection().resolve(makeConnection());
      contribution.nextConnection().resolve(makeConnection());
      await contribution.begin();
      await contribution.glspClient;

      contribution.clients[0].setState(ClientState.ServerError);
      await vi.waitFor(() => expect(contribution.clients).toHaveLength(2));
      await contribution.glspClient;
      await new Promise(resolve => setTimeout(resolve, 20));
      contribution.clients[1].setState(ClientState.ServerError);

      await vi.waitFor(() => expect(contribution.clients).toHaveLength(3), { timeout: 200 });
   });

   it('keeps a start that a restart overtook from settling its successor', async () => {
      const contribution = make(10);
      const late = contribution.nextConnection();
      void contribution.begin();
      await expect(contribution.glspClient).rejects.toThrow();

      // Unbounded from here, so only the overtaken start could settle the successor.
      Object.assign(contribution, { glspClientStartupTimeout: 0 });
      contribution.nextConnection();
      const successor = contribution.glspClient;
      late.resolve(makeConnection());
      await vi.waitFor(() => expect(contribution.clients).toHaveLength(1));

      const outcome = await Promise.race([
         successor.then(() => 'settled'),
         new Promise(resolve => setTimeout(() => resolve('pending'), 5))
      ]);
      expect(outcome).toBe('pending');
   });

   /** Upstream disposes a channel only when it is a `Disposable`, which Theia's
    *  are not, and the next channel on the same path then cannot open. */
   it('closes the channel it tears down', async () => {
      const close = vi.fn();
      await make().closeChannel({ close } as unknown as Channel);
      expect(close).toHaveBeenCalledTimes(1);
   });

   /** Left running, a start the dispose ended keeps its progress up. */
   it('cancels the report of a start that a dispose ended', async () => {
      const contribution = make(0);
      contribution.nextConnection();
      void contribution.begin();
      await vi.waitFor(() => expect(contribution.attempts).toHaveLength(1));

      contribution.dispose();

      await vi.waitFor(() => expect(contribution.attempts).toEqual([{ outcome: 'cancelled' }]));
   });

   /**
    * Theia holds each open until its websocket is back, and every held open
    * past the first then throws "already open" without reaching its handler.
    */
   it('hands the first channel to arrive to the latest start, and closes one nobody waits for', async () => {
      const contribution = make();
      const opens: Array<{ handler: (path: string, channel: Channel) => void; reconnect: boolean }> = [];
      Object.assign(contribution, {
         connectionProvider: {
            listen: (_path: string, handler: (path: string, channel: Channel) => void, reconnect: boolean) =>
               opens.push({ handler, reconnect })
         }
      });
      const makeChannel = (close = vi.fn()): ForwardingChannel =>
         new ForwardingChannel('test', close, () => {
            throw new Error('write buffer not needed for this test');
         });

      const overtaken = contribution.openChannel();
      const latest = contribution.openChannel();
      opens[0].handler('path', makeChannel());

      await expect(latest).resolves.toBeDefined();
      await expect(overtaken).rejects.toThrow();
      const unwanted = vi.fn();
      opens[1].handler('path', makeChannel(unwanted));
      expect(unwanted).toHaveBeenCalledTimes(1);
      expect(opens.map(open => open.reconnect)).toEqual([false, false]);
   });

   /** GLSP's client sends typed messages, built by whichever copy of
    *  `vscode-jsonrpc` its protocol resolves, over the connection it is given. */
   it('creates the client over a connection that sends a message typed by another copy of vscode-jsonrpc', async () => {
      const contribution = make();
      const written: unknown[] = [];
      const channel = new ForwardingChannel('test', vi.fn(), () => {
         const buffer = new Uint8ArrayWriteBuffer();
         buffer.onCommit(bytes => written.push(JSON.parse(new TextDecoder().decode(new Uint8ArrayReadBuffer(bytes).readBytes()))));
         return buffer;
      });
      contribution.nextConnection().resolve(createChannelConnection(channel));
      await contribution.begin();

      const [connection] = contribution.clientConnections;
      if (!isMessageConnection(connection)) {
         throw new Error('the client was created without a connection');
      }
      // Another copy's `auto` is a different object, which is all the connection compares.
      const foreignAuto: ParameterStructures = Object.create(ParameterStructures.auto);
      await connection.sendNotification(new NotificationType<{ value: number }>('test/notify', foreignAuto), { value: 1 });

      expect(written).toEqual([{ jsonrpc: '2.0', method: 'test/notify', params: { value: 1 } }]);
   });

   /** GLSP's channel connection uses the top-level copy's root entry, which installs no runtime layer. */
   it("installs the runtime layer of the vscode-jsonrpc copy GLSP's channel connection receives on", () => {
      expect(() => RAL()).not.toThrow();
   });
});
