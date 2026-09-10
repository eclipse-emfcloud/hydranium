/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { ResponseError, type MessageConnection } from 'vscode-jsonrpc';
import type { LatencyCollector } from '../latency-collector';
import { type Disposable, DisposableCollection } from '../util';
import { defaultIsNotification } from './create-rpc-proxy';
import { assertValidMethodNamespace } from './wire-prefix';

/**
 * Options controlling how method names are translated into wire-method
 * registrations on the supplied connection. The defaults match
 * `createRpcProxy` so the two helpers compose cleanly: an adopter
 * defining a contract `T` registers handlers with `bindRpcMethods(conn, target, names, opts)`
 * on one side and a typed proxy with `createRpcProxy<T>(conn, opts)` on
 * the other — same wire prefix, same notification heuristic, no drift.
 */
export interface BindRpcMethodsOptions {
   /**
    * Prefix prepended to each method name to form the JSON-RPC wire string.
    * Defaults to the empty string.
    */
   readonly methodNamespace?: string;

   /**
    * Predicate to discriminate notification methods from request methods.
    * Notification methods register with `connection.onNotification`;
    * request methods register with `connection.onRequest`. Default: `on`
    * followed by an uppercase letter marks a notification, matching
    * `createRpcProxy`.
    */
   readonly isNotification?: (methodName: string) => boolean;

   /**
    * When `true` (the default), every name in `methodNames` MUST exist
    * as a function on `target` — missing names throw at attach time. This
    * catches typos in adopter-supplied `additionalMethods` arrays where
    * the names are string literals.
    *
    * Set to `false` to fall back to the silent-skip behaviour (useful
    * for transitional method-name lists where some methods are not yet
    * implemented on every target).
    */
   readonly requireAll?: boolean;

   /**
    * Invoked when a notification handler throws. Notifications have no reply
    * channel, so the error cannot propagate back to the caller; this hook
    * lets a caller that holds a logger route the failure somewhere
    * structured. Receives the wire-method name and the thrown value.
    *
    * Defaults to `console.error` — the protocol layer carries no logger of
    * its own, and a caller in a process whose stdout is not the JSON-RPC
    * transport (the framework's IPC / socket heads) can leave the default in
    * place. Callers binding handlers over a `--stdio` LSP connection should
    * pass a hook that routes through `connection.console` instead.
    */
   readonly onNotificationError?: (wireName: string, error: unknown) => void;

   /**
    * When supplied, every dispatched handler is timed into this collector under
    * its wire name (`<prefix><methodName>`) — the single RPC chokepoint the
    * latency/throughput surface hooks, so no per-handler change is needed.
    * Requests and notifications are both timed. Absent by default (no overhead).
    */
   readonly latency?: LatencyCollector;

   /**
    * Produce the `message` an outgoing rejection carries, so a user-facing
    * error is rendered by the side that knows the reading user's language.
    * Applied at this one chokepoint, which is what covers a caller's
    * additional methods as well as the framework's own.
    *
    * Only a `ResponseError` is routed through it — a plain `Error` carries no
    * identity to render from, and rewriting its message would relabel a
    * developer-facing failure as a translated one. The rejection is
    * RECONSTRUCTED rather than mutated, because the thrown value may be a
    * shared constant; nothing is lost, since only `code`, `message` and `data`
    * cross the wire and `instanceof` does not survive reconstruction anyway.
    *
    * Notifications are not covered, and "they have no reply channel" is only
    * half the reason — a notification's own PAYLOAD can carry prose. What makes
    * this sound is where that prose comes from: the only user-facing text on
    * the data head's client surface is the diagnostics riding the
    * document-updated and document-saved events, and those are read off
    * `LangiumDocument.diagnostics`, which the document builder has already
    * rendered at `Validated`. So they arrive rendered rather than escaping
    * unrendered. A notification that ever carries prose of its OWN needs its
    * own render at the raise site, as GLSP's actions do.
    */
   readonly renderErrorMessage?: (error: ResponseError<unknown>) => string;
}

/** The rejection to throw in place of `err`, with its message rendered. */
function renderRejection(err: unknown, render: (error: ResponseError<unknown>) => string): unknown {
   return err instanceof ResponseError ? new ResponseError(err.code, render(err), err.data) : err;
}

/**
 * Register each named method on `target` as a handler on `connection`
 * under the wire-name `<prefix><methodName>`. Notification methods (by
 * default `on` + an uppercase letter) register as fire-and-forget listeners; request
 * methods register as request handlers and propagate the method's return
 * value back to the caller.
 *
 * The returned disposable tears down every registered handler in one call —
 * sufficient for the framework's lifecycle: bind handlers at construction,
 * dispose at shutdown.
 *
 * Method dispatch always passes the JSON-RPC `params` to the target
 * method as a single argument. This matches the single-arg-per-method
 * convention used throughout the framework's typed contracts — adopters
 * defining methods with multiple positional parameters would need a
 * different binder.
 *
 * Errors thrown synchronously from a request handler — or surfaced as a
 * rejected promise — propagate back to the caller through vscode-jsonrpc's
 * standard error envelope, with the message rendered when
 * {@link BindRpcMethodsOptions.renderErrorMessage} is supplied. Errors from a
 * notification handler cannot propagate, and are routed to
 * {@link BindRpcMethodsOptions.onNotificationError} instead.
 *
 * Accepts either a ready connection or a `Promise<MessageConnection>` —
 * registrations queue until the connection resolves, then attach. The
 * returned disposable can be invoked at any time: if it fires before the
 * connection resolves the queued work is cancelled and never attaches;
 * if it fires afterwards the registrations dispose normally. Mirrors
 * `createRpcProxy`'s deferred-connection pattern so adopters can wire
 * inbound handlers in `@postConstruct` before the underlying transport
 * exists. Wire-side safety: no notifications can arrive before
 * `connection.listen()` runs, so a not-yet-attached handler cannot drop
 * a real message.
 */
export function bindRpcMethods<T extends object>(
   connection: MessageConnection | Promise<MessageConnection>,
   target: T,
   methodNames: readonly (keyof T & string)[],
   options: BindRpcMethodsOptions = {}
): Disposable {
   const methodNamespace = options.methodNamespace ?? '';
   assertValidMethodNamespace(methodNamespace, 'bindRpcMethods');
   const isNotification = options.isNotification ?? defaultIsNotification;
   const requireAll = options.requireAll ?? true;
   const onNotificationError =
      options.onNotificationError ??
      ((wireName: string, error: unknown) => console.error(`[bindRpcMethods] notification handler '${wireName}' threw:`, error));
   const disposables = new DisposableCollection();
   let cancelled = false;

   const attach = (resolved: MessageConnection): void => {
      if (cancelled) {
         return;
      }
      for (const methodName of methodNames) {
         const wireName = methodNamespace + methodName;
         const method = target[methodName];
         if (typeof method !== 'function') {
            if (requireAll) {
               throw new Error(
                  `bindRpcMethods: method '${methodName}' is not a function on the target. ` +
                     `Either fix the typo, implement the method, or pass { requireAll: false } to opt into silent-skip ` +
                     'for transitional method-name lists.'
               );
            }
            continue;
         }
         const bound = (method as (params: unknown) => unknown).bind(target);
         // Time the dispatch at this one chokepoint when a collector is present.
         const latency = options.latency;
         const dispatch = latency ? (params: unknown): unknown => latency.time(wireName, () => bound(params)) : bound;

         if (isNotification(methodName)) {
            disposables.push(
               resolved.onNotification(wireName, (params: unknown) => {
                  try {
                     dispatch(params);
                  } catch (err: unknown) {
                     onNotificationError(wireName, err);
                  }
               })
            );
         } else {
            const render = options.renderErrorMessage;
            disposables.push(
               resolved.onRequest(wireName, async (params: unknown) => {
                  if (!render) {
                     return dispatch(params);
                  }
                  try {
                     // Awaited inside the try, or a rejected promise escapes it.
                     return await dispatch(params);
                  } catch (err: unknown) {
                     throw renderRejection(err, render);
                  }
               })
            );
         }
      }
   };

   if (connection instanceof Promise) {
      void connection
         .then(resolved => attach(resolved))
         .catch(() => {
            // Connection promise rejected — treat as never-resolved; nothing
            // to register. Adopters observe transport failures through their
            // own connection-construction error handling.
         });
   } else {
      attach(connection);
   }

   return {
      dispose(): void {
         cancelled = true;
         disposables.dispose();
      }
   };
}
