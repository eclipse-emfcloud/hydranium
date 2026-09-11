/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { type Clock, DefaultTracer, type Logger, NoopLogger, SystemClock, type Tracer } from '@hydranium/protocol';
import type { ServerSharedServicesMinimal } from '../langium/shared-services.js';
import { DefaultServerLocale, type ServerLocale } from '../locale/server-locale.js';
import { DefaultMessageRenderer, type MessageRenderer } from '../messages/renderer.js';

/**
 * Overrides for {@link makeNoopSharedServices}. The three observability slots
 * are typed (they are the boilerplate this helper exists to default);
 * `workspace` and any other slot are loosely typed so a test can drop in a
 * structurally-narrower stub (a `Pick` of `LangiumDocuments`, an inline
 * `{ wsRelativePath }` `WorkspaceManager`, …) without a per-slot cast — the
 * single boundary cast lives inside {@link makeNoopSharedServices}.
 */
export interface NoopSharedServicesOverrides {
   /** Bound on the top-level `Clock` slot. Default: {@link SystemClock}. */
   Clock?: Clock;
   /**
    * Bound on the top-level `Logger` slot AND wrapped by the default `Tracer`
    * (pass a `makeCapturingLogger().logger` to see tracer-emitted lines too).
    * Default: {@link NoopLogger}.
    */
   Logger?: Logger;
   /** Bound on the top-level `Tracer` slot. Default: a `DefaultTracer` over `Logger` + `Clock`. */
   Tracer?: Tracer;
   /** Factory for the `ServerLocale` slot. Default: a real one, reporting no locale. */
   ServerLocale?: (services: ServerSharedServicesMinimal) => ServerLocale;
   /**
    * Factory for the `MessageRenderer` slot. Default: the real
    * {@link DefaultMessageRenderer}, whose no-catalogue behaviour is a
    * pass-through — so the default is the framework's own behaviour, not a stub.
    *
    * A factory rather than an instance, because a renderer reads the tree it is
    * bound into. Both slots are resolved lazily, so an override is honoured
    * however late the caller reads them.
    */
   MessageRenderer?: (services: ServerSharedServicesMinimal) => MessageRenderer;
   /** Per-slot `workspace` overrides. Slots left out resolve to `undefined`. */
   workspace?: Record<string, unknown>;
   /** Any other minimal slot (`ServiceRegistry`, `AstReflection`, `additionalDocuments`, …). */
   [slot: string]: unknown;
}

/**
 * Build a {@link ServerSharedServicesMinimal} tree backed by no-op defaults for
 * the observability slots every framework component reads (`Clock` / `Logger` /
 * `Tracer`) plus an empty `additionalDocuments`, leaving every other slot for
 * the caller to fill through `overrides`.
 *
 * The single unavoidable cast — an assembled literal can't structurally satisfy
 * the full `ServerSharedServicesMinimal` (it omits the many Langium slots a unit
 * test doesn't touch: `ServiceRegistry`, `AstNodeLocator`, `IndexManager`, …) —
 * is encapsulated here so call sites stay cast-free and intention-revealing.
 * It is the shared-services sibling of `makeFakeAstNode` / `makeFakeReflection`:
 * a test that reads an unset slot gets `undefined` and should override it.
 *
 * `overrides` is loosely typed on purpose (see {@link NoopSharedServicesOverrides})
 * so structurally-narrower stubs slot in without a per-slot cast. For a fully
 * wired tree with real Langium-layer stubs (LangiumDocuments / DocumentBuilder /
 * ModelService / …) use `makeTestServices` instead — this helper is the light
 * option for services that read only a handful of slots.
 *
 * The return type defaults to {@link ServerSharedServicesMinimal}; a consumer
 * whose constructor declares the fuller `ServerSharedServices` requests it via
 * the type parameter (`makeNoopSharedServices<ServerSharedServices>(...)`) so
 * the value is assignable without a call-site cast — the extra LSP-bound slots
 * are still undefined and should be overridden if the code under test reads them.
 */
export function makeNoopSharedServices<T extends ServerSharedServicesMinimal = ServerSharedServicesMinimal>(
   overrides: NoopSharedServicesOverrides = {}
): T {
   const {
      Clock: clock,
      Logger: logger,
      Tracer: tracer,
      ServerLocale: serverLocale,
      MessageRenderer: messageRenderer,
      workspace,
      additionalDocuments,
      ...restTop
   } = overrides;
   const resolvedClock = clock ?? new SystemClock();
   const resolvedLogger = logger ?? new NoopLogger();
   const resolvedTracer = tracer ?? new DefaultTracer(resolvedLogger, resolvedClock);
   // Assembled in two steps, because both defaults read the tree they belong to.
   const services = {
      Clock: resolvedClock,
      Logger: resolvedLogger,
      Tracer: resolvedTracer,
      additionalDocuments: additionalDocuments ?? {},
      ...restTop,
      workspace: { ...(workspace ?? {}) }
   } as unknown as T;
   // Lazy, like Langium's own per-slot construction — and load-bearing here:
   // both services emit an `instantiated` trace, so building them eagerly puts
   // two lines into the capture of every test that passes a capturing logger
   // and asserts on emptiness.
   defineLazySlot(services, 'ServerLocale', () => serverLocale?.(services) ?? new DefaultServerLocale(services));
   defineLazySlot(services, 'MessageRenderer', () => messageRenderer?.(services) ?? new DefaultMessageRenderer(services));
   return services;
}

/** Install `name` as a memoized getter, so nothing is constructed until it is read. */
function defineLazySlot(target: object, name: string, create: () => unknown): void {
   let resolved: unknown;
   let built = false;
   Object.defineProperty(target, name, {
      configurable: true,
      enumerable: true,
      get: () => {
         if (!built) {
            resolved = create();
            built = true;
         }
         return resolved;
      }
   });
}
