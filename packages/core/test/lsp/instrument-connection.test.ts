/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { LatencyCollector } from '@hydranium/protocol';
import { makeFakeClock } from '@hydranium/protocol/testing';
import { describe, expect, it } from 'vitest';
import { instrumentLspConnection } from '../../src/lsp/instrument-connection.js';

type Handler = (...args: unknown[]) => unknown;

describe('instrumentLspConnection', () => {
   it('times each registered request handler under its method name', async () => {
      const clock = makeFakeClock();
      const latency = new LatencyCollector(clock);
      const registered = new Map<string, Handler>();
      const connection = {
         onRequest(type: unknown, handler: Handler) {
            registered.set(typeof type === 'string' ? type : (type as { method: string }).method, handler);
            return { dispose(): void {} };
         }
      };

      const instrumented = instrumentLspConnection(connection, latency);
      instrumented.onRequest('textDocument/completion', async () => {
         clock.advance(12);
         return [];
      });
      await registered.get('textDocument/completion')?.();

      expect(latency.report().methods.find(methodLatency => methodLatency.method === 'textDocument/completion')?.totalMs).toBe(12);
   });

   it('registers a request type object handler under its .method', async () => {
      const clock = makeFakeClock();
      const latency = new LatencyCollector(clock);
      const registered = new Map<string, Handler>();
      const connection = {
         onRequest(type: unknown, handler: Handler) {
            registered.set((type as { method: string }).method, handler);
            return { dispose(): void {} };
         }
      };

      instrumentLspConnection(connection, latency).onRequest({ method: 'textDocument/hover' }, async () => {
         clock.advance(3);
         return undefined;
      });
      await registered.get('textDocument/hover')?.();

      expect(latency.report().methods.find(methodLatency => methodLatency.method === 'textDocument/hover')?.count).toBe(1);
   });

   it('passes the star handler through untouched (does not time unhandled methods)', () => {
      const latency = new LatencyCollector();
      let starHandler: Handler | undefined;
      const connection = {
         onRequest(...args: unknown[]) {
            if (typeof args[0] === 'function') {
               starHandler = args[0] as Handler;
            }
            return { dispose(): void {} };
         }
      };
      const star: Handler = () => 'star';
      instrumentLspConnection(connection, latency).onRequest(star);
      expect(starHandler).toBe(star);
   });

   it('forwards non-onRequest members unchanged', () => {
      const latency = new LatencyCollector();
      const connection = {
         onRequest: () => ({ dispose(): void {} }),
         listen: (): string => 'listening'
      };
      expect(instrumentLspConnection(connection, latency).listen()).toBe('listening');
   });

   it('returns the Disposable from the underlying onRequest so a caller can dispose the timed handler', () => {
      const latency = new LatencyCollector();
      const disposable = { dispose(): void {} };
      const connection = { onRequest: (_type: unknown, _handler: Handler): unknown => disposable };
      expect(instrumentLspConnection(connection, latency).onRequest('textDocument/completion', () => undefined)).toBe(disposable);
   });

   it('forwards extra registration args after the handler to the underlying onRequest', () => {
      const latency = new LatencyCollector();
      const seen: unknown[] = [];
      const connection = {
         onRequest(...args: unknown[]) {
            seen.push(...args.slice(2));
            return { dispose(): void {} };
         }
      };
      const extra = Symbol('extra-registration-arg');
      instrumentLspConnection(connection, latency).onRequest('m', () => undefined, extra);
      expect(seen).toContain(extra);
   });

   it('forwards invocation args to the timed handler and returns its result', async () => {
      const clock = makeFakeClock();
      const latency = new LatencyCollector(clock);
      const registered = new Map<string, Handler>();
      const connection = {
         onRequest(type: unknown, handler: Handler) {
            registered.set(type as string, handler);
            return { dispose(): void {} };
         }
      };
      instrumentLspConnection(connection, latency).onRequest('m', (params: unknown, token: unknown) => {
         clock.advance(2);
         return { params, token };
      });
      const token = Symbol('cancellation');
      const result = await registered.get('m')?.({ query: 1 }, token);
      expect(result).toEqual({ params: { query: 1 }, token });
      expect(latency.report().methods[0].totalMs).toBe(2);
   });

   it('returns the connection unchanged when no collector is supplied (zero-cost when the seam is off)', () => {
      const registered: unknown[] = [];
      const raw: Handler = () => 'raw';
      const connection = {
         onRequest(...args: unknown[]) {
            registered.push(args[1]);
            return { dispose(): void {} };
         },
         listen: (): string => 'listening'
      };

      const result = instrumentLspConnection(connection, undefined);

      // No Proxy wrapper: the same object is handed back and handlers register untimed.
      expect(result).toBe(connection);
      result.onRequest('textDocument/completion', raw);
      expect(registered[0]).toBe(raw);
   });

   it('records the duration and propagates the error when a timed handler rejects', async () => {
      const clock = makeFakeClock();
      const latency = new LatencyCollector(clock);
      const registered = new Map<string, Handler>();
      const connection = {
         onRequest(type: unknown, handler: Handler) {
            registered.set(type as string, handler);
            return { dispose(): void {} };
         }
      };
      instrumentLspConnection(connection, latency).onRequest('m', async () => {
         clock.advance(4);
         throw new Error('handler boom');
      });
      await expect(registered.get('m')?.()).rejects.toThrow('handler boom');
      expect(latency.report().methods.find(methodLatency => methodLatency.method === 'm')?.totalMs).toBe(4);
   });
});
