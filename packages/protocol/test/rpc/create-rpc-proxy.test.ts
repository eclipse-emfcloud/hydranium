/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, expect, it, vi } from 'vitest';
import { ErrorCodes } from 'vscode-jsonrpc';
import { DATA_CLIENT_PROTOCOL_METHODS, DATA_SERVER_PROTOCOL_METHODS } from '../../src/data/data-protocol-methods';
import { LatencyCollector } from '../../src/latency-collector';
import { bindRpcMethods } from '../../src/rpc/bind-rpc-methods';
import { createRpcProxy, defaultIsNotification } from '../../src/rpc/create-rpc-proxy';
import { tick, waitFor } from '../../src/testing';
import { makeDuplexConnectionPair } from '../../src/testing/node';

interface DemoApi {
   doStuff(args: { value: number }): Promise<{ doubled: number }>;
   getProjects(): Promise<readonly string[]>;
   onProgress(event: { pct: number }): void;
}

describe('createRpcProxy', () => {
   it('round-trips a request method through the wire', async () => {
      const pair = makeDuplexConnectionPair();
      try {
         const target: Pick<DemoApi, 'doStuff'> = {
            doStuff: async args => ({ doubled: args.value * 2 })
         };
         bindRpcMethods(pair.left, target, ['doStuff'], { methodNamespace: 'demo/' });
         const proxy = createRpcProxy<DemoApi>(pair.right, { methodNamespace: 'demo/' });

         const result = await proxy.doStuff({ value: 21 });
         expect(result).toEqual({ doubled: 42 });
      } finally {
         pair.dispose();
      }
   });

   it('records request latency into a LatencyCollector under the wire name', async () => {
      const pair = makeDuplexConnectionPair();
      try {
         const latency = new LatencyCollector();
         const target: Pick<DemoApi, 'doStuff'> = {
            doStuff: async args => ({ doubled: args.value * 2 })
         };
         bindRpcMethods(pair.left, target, ['doStuff'], { methodNamespace: 'demo/', latency });
         const proxy = createRpcProxy<DemoApi>(pair.right, { methodNamespace: 'demo/' });

         await proxy.doStuff({ value: 1 });

         const doStuff = latency.report().methods.find(methodLatency => methodLatency.method === 'demo/doStuff');
         expect(doStuff?.count).toBe(1);
      } finally {
         pair.dispose();
      }
   });

   it('dispatches on*-prefixed methods as notifications, not requests', async () => {
      const pair = makeDuplexConnectionPair();
      try {
         const received: { pct: number }[] = [];
         const target = {
            onProgress(event: { pct: number }): void {
               received.push(event);
            }
         };
         bindRpcMethods(pair.left, target, ['onProgress'], { methodNamespace: 'demo/' });
         const proxy = createRpcProxy<DemoApi>(pair.right, { methodNamespace: 'demo/' });

         // Notification methods on the proxy return void — calling without await is correct.
         proxy.onProgress({ pct: 50 });
         await waitFor(() => received.length === 1); // the notification crossed the wire

         expect(received).toEqual([{ pct: 50 }]);
      } finally {
         pair.dispose();
      }
   });

   it('queues calls made before a Promise<MessageConnection> resolves', async () => {
      const pair = makeDuplexConnectionPair();
      try {
         const target: Pick<DemoApi, 'getProjects'> = {
            getProjects: async () => ['p1', 'p2']
         };
         bindRpcMethods(pair.left, target, ['getProjects'], { methodNamespace: 'demo/' });

         let resolveConn: (connection: typeof pair.right) => void = () => undefined;
         const connectionPromise = new Promise<typeof pair.right>(resolve => {
            resolveConn = resolve;
         });
         const proxy = createRpcProxy<DemoApi>(connectionPromise, { methodNamespace: 'demo/' });

         // Issue the call BEFORE the connection promise resolves — the proxy
         // must hold the request and dispatch it once the connection is ready.
         const pending = proxy.getProjects();
         await tick(); // let the proxy queue the request before the connection resolves
         resolveConn(pair.right);

         const result = await pending;
         expect(result).toEqual(['p1', 'p2']);
      } finally {
         pair.dispose();
      }
   });

   it('returns undefined for `then` so the proxy is not auto-awaited', () => {
      const pair = makeDuplexConnectionPair();
      try {
         const proxy = createRpcProxy<DemoApi>(pair.right);
         // Thenable probe — TypeScript erases the property access but at runtime
         // the proxy's get trap fires. A defined `then` would make the proxy
         // mistakenly resolved during `await`.
         expect((proxy as unknown as { then: unknown }).then).toBeUndefined();
      } finally {
         pair.dispose();
      }
   });

   it('respects a custom isNotification predicate', async () => {
      const pair = makeDuplexConnectionPair();
      try {
         const received: unknown[] = [];
         const target = {
            emitTick(payload: { n: number }): void {
               received.push(payload);
            }
         };
         const isNotification = (method: string): boolean => method.startsWith('emit');
         bindRpcMethods(pair.left, target, ['emitTick'], { methodNamespace: 'demo/', isNotification });
         const proxy = createRpcProxy<{ emitTick(payload: { n: number }): void }>(pair.right, {
            methodNamespace: 'demo/',
            isNotification
         });

         proxy.emitTick({ n: 7 });
         await waitFor(() => received.length === 1); // the notification crossed the wire

         expect(received).toEqual([{ n: 7 }]);
      } finally {
         pair.dispose();
      }
   });

   it('fires onDidOpenConnection once after the connection resolves', async () => {
      const pair = makeDuplexConnectionPair();
      try {
         let resolve: (connection: typeof pair.right) => void = () => undefined;
         const deferredConnection = new Promise<typeof pair.right>(r => {
            resolve = r;
         });
         const proxy = createRpcProxy<DemoApi>(deferredConnection, { methodNamespace: 'demo/' });

         const opened: void[] = [];
         proxy.onDidOpenConnection(() => opened.push(undefined));

         expect(opened).toHaveLength(0); // not yet resolved
         resolve(pair.right);
         await waitFor(() => opened.length === 1);
         expect(opened).toHaveLength(1);
      } finally {
         pair.dispose();
      }
   });

   it('fires onDidCloseConnection when the underlying transport closes', async () => {
      // Build a single-side connection inline so we can destroy the underlying
      // stream WITHOUT going through MessageConnection.dispose() — vscode-jsonrpc
      // suppresses close events after explicit dispose; close events are only for
      // transport-level drops.
      const { PassThrough } = await import('node:stream');
      const { StreamMessageReader, StreamMessageWriter, createMessageConnection } = await import('vscode-jsonrpc/node');
      const writer = new PassThrough();
      const reader = new PassThrough();
      const connection = createMessageConnection(new StreamMessageReader(reader), new StreamMessageWriter(writer));
      connection.listen();

      try {
         const proxy = createRpcProxy<DemoApi>(connection, { methodNamespace: 'demo/' });
         const closed: void[] = [];
         proxy.onDidCloseConnection(() => closed.push(undefined));

         await tick(); // let the proxy subscribe to connection.onClose
         reader.destroy(); // transport drop → connection.onClose fires
         await waitFor(() => closed.length === 1);
         expect(closed).toHaveLength(1);
      } finally {
         connection.dispose();
         writer.destroy();
      }
   });

   it('throws synchronously when a request method is called with multiple args', () => {
      const pair = makeDuplexConnectionPair();
      try {
         // Loosely-typed proxy bypasses TS's single-arg constraint.
         // eslint-disable-next-line @typescript-eslint/no-explicit-any
         const proxy = createRpcProxy<any>(pair.right, { methodNamespace: 'demo/' });
         expect(() => proxy.doStuff({ a: 1 }, { b: 2 })).toThrow(/called with 2 arguments/);
      } finally {
         pair.dispose();
      }
   });

   it('throws synchronously when a notification is called with multiple args', () => {
      const pair = makeDuplexConnectionPair();
      try {
         // eslint-disable-next-line @typescript-eslint/no-explicit-any
         const proxy = createRpcProxy<any>(pair.right, { methodNamespace: 'demo/' });
         expect(() => proxy.onProgress({ a: 1 }, { b: 2 })).toThrow(/called with 2 arguments/);
      } finally {
         pair.dispose();
      }
   });

   it('attaches the calling stack frame to a rejected request error', async () => {
      const pair = makeDuplexConnectionPair();
      try {
         const target = {
            doStuff: async (): Promise<never> => {
               throw new Error('server-side boom');
            }
         };
         bindRpcMethods(pair.left, target, ['doStuff'], { methodNamespace: 'demo/' });
         const proxy = createRpcProxy<{ doStuff(): Promise<unknown> }>(pair.right, { methodNamespace: 'demo/' });

         // Wrap the call in a uniquely-named function so we can verify the
         // captured client-side stack reaches the caller.
         async function callsiteUnderTest(): Promise<unknown> {
            return proxy.doStuff();
         }

         try {
            await callsiteUnderTest();
            throw new Error('expected proxy.doStuff() to reject');
         } catch (err) {
            expect(err).toBeInstanceOf(Error);
            const stack = (err as Error).stack ?? '';
            expect(stack).toMatch(/Caused by request from/);
            expect(stack).toMatch(/callsiteUnderTest/);
            expect(stack).toMatch(/RPC request 'demo\/doStuff' failed/);
         }
      } finally {
         pair.dispose();
      }
   });
});

describe('createRpcProxy with localTarget binding', () => {
   interface ServerApi {
      add(args: { a: number; b: number }): Promise<number>;
   }
   interface ClientApi {
      ping(args: { n: number }): Promise<number>;
      onTick(event: { t: number }): void;
   }
   const CLIENT_METHODS = ['ping', 'onTick'] as const satisfies ReadonlyArray<keyof ClientApi & string>;

   it('binds the local target inbound while proxying the remote outbound (one call, both directions)', async () => {
      const pair = makeDuplexConnectionPair();
      try {
         // Far side (pair.left): handles ServerApi requests.
         const server: ServerApi = { add: async ({ a, b }) => a + b };
         bindRpcMethods(pair.left, server, ['add'], { methodNamespace: 'demo/' });

         // Near side (pair.right): proxy the server AND bind a local client in one call.
         const ticks: number[] = [];
         const localClient: ClientApi = {
            ping: async ({ n }) => n * 10,
            onTick: event => {
               ticks.push(event.t);
            }
         };
         const remote = createRpcProxy<ServerApi, ClientApi>(pair.right, {
            methodNamespace: 'demo/',
            localTarget: localClient,
            localMethods: CLIENT_METHODS
         });

         // Outbound: the returned proxy reaches the far-side server.
         expect(await remote.add({ a: 2, b: 3 })).toBe(5);

         // Inbound: the far side reaches the bound local client (request + notification).
         const farToNear = createRpcProxy<ClientApi>(pair.left, { methodNamespace: 'demo/' });
         expect(await farToNear.ping({ n: 4 })).toBe(40);
         farToNear.onTick({ t: 7 });
         await waitFor(() => ticks.length === 1);
         expect(ticks).toEqual([7]);
      } finally {
         pair.dispose();
      }
   });

   it('binds nothing inbound when localTarget is omitted (pure remote proxy)', async () => {
      const pair = makeDuplexConnectionPair();
      try {
         // No localTarget — the pure-outbound proxy.
         createRpcProxy<ServerApi>(pair.right, { methodNamespace: 'demo/' });

         // Nothing is bound on pair.right, so a request to a client method rejects
         // with method-not-found — proves no implicit auto-binding happened. The
         // code matters: a bare `rejects` is equally satisfied by a torn socket or
         // a wrong-namespace typo, neither of which says anything about binding.
         const farToNear = createRpcProxy<ClientApi>(pair.left, { methodNamespace: 'demo/' });
         await expect(farToNear.ping({ n: 1 })).rejects.toMatchObject({ code: ErrorCodes.MethodNotFound });
      } finally {
         pair.dispose();
      }
   });

   it('registers an additional connection.onClose teardown for the inbound binding', async () => {
      const pair = makeDuplexConnectionPair();
      try {
         const onCloseSpy = vi.spyOn(pair.right, 'onClose');

         // Baseline: a pure proxy registers exactly the lifecycle onClose.
         createRpcProxy<ServerApi>(pair.right, { methodNamespace: 'demo/' });
         await tick();
         const withoutLocal = onCloseSpy.mock.calls.length;

         // With a localTarget: lifecycle onClose + the binding teardown onClose.
         createRpcProxy<ServerApi, ClientApi>(pair.right, {
            methodNamespace: 'demo/',
            localTarget: { ping: async () => 0, onTick: () => undefined },
            localMethods: CLIENT_METHODS
         });
         await tick();
         const withLocal = onCloseSpy.mock.calls.length;

         expect(withLocal - withoutLocal).toBeGreaterThan(1);
      } finally {
         pair.dispose();
      }
   });
});

describe('defaultIsNotification', () => {
   it('matches on-plus-uppercase names and rejects everything else', () => {
      expect(defaultIsNotification('onProgress')).toBe(true);
      expect(defaultIsNotification('onDocumentUpdated')).toBe(true);
      expect(defaultIsNotification('getProjects')).toBe(false);
      expect(defaultIsNotification('saveModelDocument')).toBe(false);
   });

   it('leaves request-shaped names that merely start with "on" as requests', () => {
      // The uppercase requirement is the whole point: these would otherwise be
      // fire-and-forget notifications with their Promise result dropped.
      expect(defaultIsNotification('onboardUser')).toBe(false);
      expect(defaultIsNotification('onlineCheck')).toBe(false);
      expect(defaultIsNotification('once')).toBe(false);
      expect(defaultIsNotification('on')).toBe(false);
   });

   it('still matches the framework contracts it has to route', () => {
      // Every declared client-protocol notification must keep routing as one.
      for (const methodName of DATA_CLIENT_PROTOCOL_METHODS) {
         expect(defaultIsNotification(methodName)).toBe(true);
      }
      // ...and no declared server-protocol request may be caught by it.
      for (const methodName of DATA_SERVER_PROTOCOL_METHODS) {
         expect(defaultIsNotification(methodName)).toBe(false);
      }
   });
});

describe('bindRpcMethods', () => {
   it('routes request handlers to the matching wire method', async () => {
      const pair = makeDuplexConnectionPair();
      try {
         const target: Pick<DemoApi, 'doStuff'> = {
            doStuff: async args => ({ doubled: args.value + 1 })
         };
         const disposable = bindRpcMethods(pair.left, target, ['doStuff'], { methodNamespace: 'demo/' });
         const proxy = createRpcProxy<DemoApi>(pair.right, { methodNamespace: 'demo/' });

         expect((await proxy.doStuff({ value: 1 })).doubled).toBe(2);

         // After dispose, the handler is gone — subsequent requests reject because
         // the connection has no handler for the wire method any more.
         disposable.dispose();
         await expect(proxy.doStuff({ value: 1 })).rejects.toBeDefined();
      } finally {
         pair.dispose();
      }
   });

   it('propagates rejected promises from a request handler back to the caller', async () => {
      const pair = makeDuplexConnectionPair();
      try {
         const target = {
            doStuff: async (): Promise<never> => {
               throw new Error('boom');
            }
         };
         bindRpcMethods(pair.left, target, ['doStuff'], { methodNamespace: 'demo/' });
         const proxy = createRpcProxy<{ doStuff(): Promise<unknown> }>(pair.right, { methodNamespace: 'demo/' });

         await expect(proxy.doStuff()).rejects.toThrow('boom');
      } finally {
         pair.dispose();
      }
   });

   it('throws by default when a method name does not exist on the target (catches typos)', () => {
      const pair = makeDuplexConnectionPair();
      try {
         const target = {} as { doStuff?: (args: unknown) => Promise<unknown> };
         expect(() =>
            bindRpcMethods(pair.left, target, ['doStuff'] as (keyof typeof target & string)[], {
               methodNamespace: 'demo/'
            })
         ).toThrow(/method 'doStuff' is not a function on the target/);
      } finally {
         pair.dispose();
      }
   });

   it('silently skips missing methods when { requireAll: false } is passed (transitional opt-in)', async () => {
      const pair = makeDuplexConnectionPair();
      try {
         // Armed before the bind: these are absolute counts over the whole
         // fixture, not a delta, so nothing else can have registered first.
         const onRequestSpy = vi.spyOn(pair.left, 'onRequest');
         const onNotificationSpy = vi.spyOn(pair.left, 'onNotification');
         const target = {} as { doStuff?: (args: unknown) => Promise<unknown> };
         const disposable = bindRpcMethods(pair.left, target, ['doStuff'] as (keyof typeof target & string)[], {
            methodNamespace: 'demo/',
            requireAll: false
         });

         // Skipped, not bound to `undefined`: the connection sees no registration
         // at all. Asserting only that a Disposable came back cannot tell the two
         // apart, because the return type is not optional.
         expect(onRequestSpy).not.toHaveBeenCalled();
         expect(onNotificationSpy).not.toHaveBeenCalled();
         // ...and the wire agrees — a handler bound to `undefined` would answer
         // (or throw), not report method-not-found.
         const proxy = createRpcProxy<DemoApi>(pair.right, { methodNamespace: 'demo/' });
         await expect(proxy.doStuff({ value: 1 })).rejects.toMatchObject({ code: ErrorCodes.MethodNotFound });

         disposable.dispose();
      } finally {
         pair.dispose();
      }
   });

   it('accepts a Promise<MessageConnection> and attaches handlers when it resolves', async () => {
      const pair = makeDuplexConnectionPair();
      try {
         const target = {
            doStuff: async (args: { value: number }): Promise<{ doubled: number }> => ({ doubled: args.value * 2 })
         };
         let resolveConn: (connection: typeof pair.left) => void = () => undefined;
         const connectionPromise = new Promise<typeof pair.left>(resolve => {
            resolveConn = resolve;
         });
         const disposable = bindRpcMethods(connectionPromise, target, ['doStuff'], { methodNamespace: 'demo/' });

         // Resolve the binder's connection before any request goes out so the
         // handler is attached when the request lands. This mirrors the real
         // adopter pattern: proxy AND binder share the same deferred promise
         // and attach together on resolve, then user code calls methods.
         resolveConn(pair.left);
         await tick(); // let the binder attach its handlers before the request goes out

         const proxy = createRpcProxy<{ doStuff(args: { value: number }): Promise<{ doubled: number }> }>(pair.right, {
            methodNamespace: 'demo/'
         });
         expect(await proxy.doStuff({ value: 21 })).toEqual({ doubled: 42 });
         disposable.dispose();
      } finally {
         pair.dispose();
      }
   });

   it('cancels deferred registrations when disposed before the connection resolves', async () => {
      const pair = makeDuplexConnectionPair();
      try {
         const target = {
            doStuff: async (): Promise<string> => 'handler-ran'
         };
         let resolveConn: (connection: typeof pair.left) => void = () => undefined;
         const connectionPromise = new Promise<typeof pair.left>(resolve => {
            resolveConn = resolve;
         });
         const disposable = bindRpcMethods(connectionPromise, target, ['doStuff'], { methodNamespace: 'demo/' });

         // Dispose BEFORE the connection resolves — registration must not attach.
         disposable.dispose();
         resolveConn(pair.left);
         await tick(); // let the (cancelled) deferred registration run — it must not attach

         // Client end: send a request; no handler is attached on the left side,
         // so vscode-jsonrpc returns a method-not-found rejection.
         const proxy = createRpcProxy<{ doStuff(): Promise<string> }>(pair.right, { methodNamespace: 'demo/' });
         await expect(proxy.doStuff()).rejects.toBeDefined();
      } finally {
         pair.dispose();
      }
   });

   it('does not crash on synchronous throws from a notification handler', async () => {
      const pair = makeDuplexConnectionPair();
      const consoleErrors: unknown[][] = [];
      const originalError = console.error;
      console.error = (...args: unknown[]) => {
         consoleErrors.push(args);
      };
      try {
         const target = {
            onBoom(): void {
               throw new Error('notif-boom');
            }
         };
         bindRpcMethods(pair.left, target, ['onBoom'], { methodNamespace: 'demo/' });
         const proxy = createRpcProxy<{ onBoom(): void }>(pair.right, { methodNamespace: 'demo/' });
         proxy.onBoom();
         await waitFor(() => consoleErrors.length > 0);
         expect(consoleErrors.length).toBeGreaterThan(0);
      } finally {
         console.error = originalError;
         pair.dispose();
      }
   });
});
