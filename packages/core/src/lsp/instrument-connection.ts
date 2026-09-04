/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import type { LatencyCollector } from '@hydranium/protocol';

type RequestHandler = (...args: unknown[]) => unknown;

/**
 * Wrap an LSP `Connection` so every request handler registered through
 * `onRequest` is timed into `latency` under its method name — the LSP analog of
 * the data-server RPC chokepoint. Langium's `startLanguageServer` registers
 * `onCompletion`/`onHover`/… one handler at a time, so there is no single
 * dispatch point; but every registration funnels through the ONE `onRequest`
 * on the shared `Connection`, so decorating it catches every method with no
 * Langium fork and no per-handler code.
 *
 * Opt in where the head creates the connection, before it hands it to the
 * services factory — wrapping it afterwards is too late, because Langium has
 * already registered its handlers against the raw connection.
 *
 * `onRequest` has several overloads: most register a handler for a specific
 * method (a string, or a typed request whose `.method` names it) and one is the
 * `StarRequestHandler` catch-all `onRequest(handler)`. The star form fires only
 * for methods with no registered handler, so timing it would be misleading — it
 * is passed through untouched. Every other member of the connection is
 * forwarded unchanged.
 *
 * When `latency` is `undefined` the seam is off: the connection is returned
 * unchanged (no Proxy, no per-request timing), so a head can pass the result of
 * an env-gated factory (`latencyFromEnv()`) straight through and pay nothing
 * when latency is not enabled.
 */
export function instrumentLspConnection<C extends object>(connection: C, latency: LatencyCollector | undefined): C {
   if (!latency) {
      return connection;
   }
   return new Proxy(connection, {
      get(target, property, receiver): unknown {
         const value: unknown = Reflect.get(target, property, receiver);
         if (property !== 'onRequest' || typeof value !== 'function') {
            return value;
         }
         const onRequest = value as (...args: unknown[]) => unknown;
         return (...args: unknown[]): unknown => {
            const [first, handler] = args;
            // Star form `onRequest(handler)` — pass through; it is not a timer.
            if (typeof first === 'function' || typeof handler !== 'function') {
               return onRequest.apply(target, args);
            }
            const method = typeof first === 'string' ? first : (first as { method?: unknown }).method;
            if (typeof method !== 'string') {
               return onRequest.apply(target, args);
            }
            const original = handler as RequestHandler;
            const timed: RequestHandler = (...handlerArgs) => latency.time(method, () => original(...handlerArgs));
            return onRequest.apply(target, [first, timed, ...args.slice(2)]);
         };
      }
   });
}
