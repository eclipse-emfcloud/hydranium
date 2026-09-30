/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

// The real base class pulls Theia's monaco-coupled chain. The stand-in carries
// only the members the contribution reads, with upstream's defaults.
vi.mock('@eclipse-glsp/theia-integration', async () => {
   const { Deferred } = await import('@theia/core/lib/common/promise-util');
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
vi.mock('@theia/workspace/lib/browser', () => ({
   WorkspaceService: class WorkspaceService {}
}));

import { type Channel } from '@theia/core';
import { ForwardingChannel } from '@theia/core/lib/common/message-rpc/channel';
import { Deferred } from '@theia/core/lib/common/promise-util';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_GLSP_CLIENT_STARTUP_TIMEOUT_MS, HydraniumGlspClientContribution } from '../../src/browser/client-contribution';

interface FakeClient {
   readonly name: string;
   start(): Promise<void>;
   initializeServer(): Promise<object>;
   stop(): void;
}

/** Each start takes its connection from `connections`, in order, so a test
 *  decides when, and whether, each one arrives. */
class TestContribution extends HydraniumGlspClientContribution {
   readonly connections: Array<Deferred<FakeConnection>> = [];
   readonly clients: FakeClient[] = [];
   readonly errors = vi.fn(async (_message: string, ..._actions: string[]): Promise<string | undefined> => undefined);
   readonly infos = vi.fn();
   readonly progress = { cancel: vi.fn() };
   readonly showProgress = vi.fn(async () => this.progress);
   /** Whether each client's `initializeServer` never answers. */
   initializeHangs = false;

   constructor(startupTimeoutMs?: number, connectingNoticeDelayMs = 1_000) {
      super({ languageContributionId: 'test', startupTimeoutMs });
      Object.assign(this, {
         connectingNoticeDelayMs,
         workspaceService: { tryGetRoots: () => [{}] },
         messageService: { error: this.errors, info: this.infos, showProgress: this.showProgress }
      });
   }

   get startupTimeout(): number {
      return this.glspClientStartupTimeout;
   }

   begin(): Promise<void> {
      return this.activateClient();
   }

   /** Queue the connection the next start receives. */
   nextConnection(): Deferred<FakeConnection> {
      const connection = new Deferred<FakeConnection>();
      this.connections.push(connection);
      return connection;
   }

   closeChannel(channel: Channel): Promise<void> {
      return this.disposeChannel({} as never, channel);
   }

   openChannel(): Promise<unknown> {
      return this.createChannelConnection();
   }

   protected override createConnection(): never {
      const next = this.connections.shift();
      if (!next) {
         throw new Error('no connection queued');
      }
      return next.promise as never;
   }

   protected override async createGLSPClient(): Promise<never> {
      const client: FakeClient = {
         name: `client ${this.clients.length + 1}`,
         start: async () => undefined,
         initializeServer: () => (this.initializeHangs ? new Promise<object>(() => undefined) : Promise.resolve({})),
         stop: () => undefined
      };
      this.clients.push(client);
      return client as never;
   }
}

interface FakeConnection {
   onDispose(): void;
   onClose(listener: () => void): void;
   close(): void;
}

function makeConnection(): FakeConnection {
   const listeners: Array<() => void> = [];
   return {
      onDispose: () => undefined,
      onClose: listener => listeners.push(listener),
      close: () => listeners.forEach(listener => listener())
   };
}

const connection = makeConnection();

describe('HydraniumGlspClientContribution', () => {
   it('bounds a start by 30 s unless the options say otherwise', () => {
      expect(new TestContribution().startupTimeout).toBe(DEFAULT_GLSP_CLIENT_STARTUP_TIMEOUT_MS);
      expect(DEFAULT_GLSP_CLIENT_STARTUP_TIMEOUT_MS).toBe(30_000);
      expect(new TestContribution(5).startupTimeout).toBe(5);
   });

   /**
    * A server that never answers leaves every diagram load waiting on the
    * client, with nothing reported.
    */
   it('fails a start that runs out of time and offers a Retry', async () => {
      const contribution = new TestContribution(10);
      contribution.nextConnection();
      void contribution.begin();

      await expect(contribution.glspClient).rejects.toThrow('The diagram server did not answer within 0 seconds.');
      await vi.waitFor(() => expect(contribution.errors).toHaveBeenCalledTimes(1));
      expect(contribution.errors).toHaveBeenCalledWith('The diagram server did not answer within 0 seconds.', 'Retry');
   });

   it('fails a start whose connection closes before the server answers', async () => {
      const contribution = new TestContribution();
      contribution.initializeHangs = true;
      const closing = makeConnection();
      contribution.nextConnection().resolve(closing);
      void contribution.begin();
      await vi.waitFor(() => expect(contribution.clients).toHaveLength(1));
      closing.close();

      await expect(contribution.glspClient).rejects.toThrow('Could not connect to the diagram server.');
      await vi.waitFor(() => expect(contribution.errors).toHaveBeenCalledWith('Could not connect to the diagram server.', 'Retry'));
   });

   it('shows progress while a start is slow, then one notification with the result', async () => {
      const contribution = new TestContribution(undefined, 1);
      const arriving = contribution.nextConnection();
      void contribution.begin();
      await vi.waitFor(() => expect(contribution.showProgress).toHaveBeenCalledTimes(1));
      expect(contribution.showProgress).toHaveBeenCalledWith({ text: 'Connecting to the diagram server…' });

      arriving.resolve(connection);
      await vi.waitFor(() => expect(contribution.infos).toHaveBeenCalledWith('Connected to the diagram server.'));
      expect(contribution.progress.cancel).toHaveBeenCalledTimes(1);
      expect(contribution.errors).not.toHaveBeenCalled();
   });

   it('replaces the progress with the failure when a slow start fails', async () => {
      const contribution = new TestContribution(20, 1);
      contribution.nextConnection();
      void contribution.begin();
      await expect(contribution.glspClient).rejects.toThrow();

      await vi.waitFor(() => expect(contribution.progress.cancel).toHaveBeenCalledTimes(1));
      expect(contribution.errors).toHaveBeenCalledTimes(1);
      expect(contribution.infos).not.toHaveBeenCalled();
   });

   it('resolves the client once it is started and initialized', async () => {
      const contribution = new TestContribution();
      contribution.nextConnection().resolve(connection);
      await contribution.begin();

      const client = await contribution.glspClient;
      expect(client).toBe(contribution.clients[0]);
      // Quick enough that no progress showed, so nothing is announced either.
      expect(contribution.showProgress).not.toHaveBeenCalled();
      expect(contribution.infos).not.toHaveBeenCalled();
      expect(contribution.errors).not.toHaveBeenCalled();
   });

   /** Every diagram load reads the client, so reading it is what lets a diagram
    *  retry, or a reopened tab, recover from a failed start. */
   it('starts a fresh client when the client is read after a failed start', async () => {
      const contribution = new TestContribution(10);
      contribution.nextConnection();
      void contribution.begin();
      await expect(contribution.glspClient).rejects.toThrow();

      contribution.nextConnection().resolve(connection);
      const client = await contribution.glspClient;
      expect(client).toBe(contribution.clients[0]);
   });

   it('restarts from the notification’s Retry', async () => {
      const contribution = new TestContribution(10);
      contribution.errors.mockResolvedValueOnce('Retry');
      contribution.nextConnection();
      const retried = contribution.nextConnection();
      void contribution.begin();
      await expect(contribution.glspClient).rejects.toThrow();

      await vi.waitFor(() => expect(contribution.connections).toHaveLength(0));
      retried.resolve(connection);
      const client = await contribution.glspClient;
      expect(client).toBe(contribution.clients[0]);
   });

   it('keeps a start that a restart overtook from settling its successor', async () => {
      const contribution = new TestContribution(10);
      const late = contribution.nextConnection();
      void contribution.begin();
      await expect(contribution.glspClient).rejects.toThrow();

      // Unbounded from here, so only the overtaken start could settle the successor.
      Object.assign(contribution, { glspClientStartupTimeout: 0 });
      contribution.nextConnection();
      const successor = contribution.glspClient;
      late.resolve(connection);
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
      await new TestContribution().closeChannel({ close } as unknown as Channel);
      expect(close).toHaveBeenCalledTimes(1);
   });

   /** A start disposed with it would otherwise still time out and report. */
   it('reports nothing for a start that a dispose ended', async () => {
      const contribution = new TestContribution(10, 5);
      contribution.nextConnection();
      void contribution.begin();
      await Promise.resolve();

      contribution.dispose();
      await new Promise(resolve => setTimeout(resolve, 30));

      expect(contribution.errors).not.toHaveBeenCalled();
      expect(contribution.showProgress).not.toHaveBeenCalled();
   });

   /**
    * Theia holds each open until its websocket is back, and every held open
    * past the first then throws "already open" without reaching its handler.
    */
   it('hands the first channel to arrive to the latest start, and closes one nobody waits for', async () => {
      const contribution = new TestContribution();
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
});
