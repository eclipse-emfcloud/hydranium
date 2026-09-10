/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { Emitter, type Event, type MessageConnection } from 'vscode-jsonrpc';
import { type BindRpcMethodsOptions, bindRpcMethods } from './bind-rpc-methods';
import { assertValidMethodNamespace } from './wire-prefix';

/**
 * Lifecycle events surfaced on every {@link createRpcProxy} return — `onDidOpenConnection`
 * fires once after the underlying `MessageConnection` resolves; `onDidCloseConnection`
 * fires when the connection's `onClose` triggers. Useful for proxy-only consumers
 * (widgets, downstream services) that don't hold the `MessageConnection` directly
 * and would otherwise need it threaded through just to react to disconnects.
 *
 * Reconnection is NOT modelled — the framework assumes a single connection
 * lifetime per proxy. If the transport drops, the adopter constructs a new
 * connection + proxy.
 *
 * **Reserved property names on `RpcProxy<T>`.** The proxy's get-trap
 * intercepts four property names — any wire method declared on `T` with
 * one of these names would shadow the reserved behaviour instead of
 * dispatching a wire call. Adopters defining wire-method names should
 * avoid:
 *
 *   - `onDidOpenConnection` / `onDidCloseConnection` — return the
 *     lifecycle events declared on this interface.
 *   - `then` — returns `undefined` so the proxy is not auto-awaited
 *     when caught by Promise-detection in the host environment.
 *   - `toJSON` — returns `undefined` so JSON serializers do not try to
 *     flatten the proxy.
 *
 * Symbol property accesses also return `undefined` (the proxy is not
 * iterable, not a thenable, not serialisable).
 */
export interface RpcProxyLifecycle {
   /**
    * Fires exactly once, when the underlying connection promise resolves. It
    * does NOT replay: a proxy built over an already-resolved connection fires
    * on the next microtask, so a subscriber attached after that never hears
    * anything. Subscribe in the same synchronous block that builds the proxy,
    * or track readiness yourself.
    *
    * Never fires if the connection promise rejects — a failed transport
    * construction is indistinguishable here from one still pending, and is
    * meant to be observed where the connection is built.
    */
   readonly onDidOpenConnection: Event<void>;
   /**
    * Fires when the transport closes. Reconnection is not modelled, so it fires
    * at most once and is never followed by another open — a consumer that has
    * to survive a drop constructs a new proxy rather than waiting here.
    */
   readonly onDidCloseConnection: Event<void>;
}

/** Proxy of `T` plus the framework's connection-lifecycle events. */
export type RpcProxy<T extends object> = T & RpcProxyLifecycle;

/**
 * Options controlling how method-name properties on the returned proxy
 * are translated into wire calls.
 *
 * Generic over `TLocal` — the type of an OPTIONAL inbound handler target
 * (see {@link localTarget} / {@link localMethods}). `TLocal` defaults to
 * `never`, so callers that only want an outbound proxy omit the local
 * fields entirely and the proxy behaves exactly as a pure remote proxy.
 */
export interface CreateRpcProxyOptions<TLocal extends object = never> {
   /**
    * Prefix prepended to the property name to form the JSON-RPC method
    * string. For example, prefix `'data-server/'` turns a property access
    * `proxy.getModelDocument` into the wire method
    * `'data-server/getModelDocument'`. Defaults to the empty string —
    * the property name is the wire name.
    *
    * When {@link localTarget} is supplied, the SAME prefix applies to the
    * inbound handler registrations — both ends of a combined connection
    * share one namespace.
    */
   readonly methodNamespace?: string;

   /**
    * Predicate to discriminate notification methods from request methods
    * by their TS property name. Notification methods lower to
    * `connection.sendNotification` and return `void`; request methods
    * lower to `connection.sendRequest` and return `Promise<TResult>`.
    *
    * Default: property names starting with `'on'` followed by an uppercase
    * letter are notifications. Adopters defining typed contracts in the
    * `DataClientProtocol` style get the right routing without per-method
    * configuration.
    *
    * Applies symmetrically to the {@link localTarget} binding, so the
    * inbound and outbound sides agree on which methods are notifications.
    */
   readonly isNotification?: (methodName: string) => boolean;

   /**
    * OPTIONAL inbound-handler target. When supplied together with
    * {@link localMethods}, `createRpcProxy` ALSO binds those methods of
    * `localTarget` as inbound request/notification handlers on the same
    * connection (delegating to `bindRpcMethods`) — collapsing the common
    * "proxy the remote + handle the local" two-step into one call. The
    * binding is torn down on `connection.onClose`; the return value stays
    * just the remote proxy (no `Disposable` surfaced — there is no use
    * case for unbinding a connection-scoped target before its connection
    * closes). Callers that need the explicit `Disposable` call
    * `bindRpcMethods` directly instead.
    *
    * Omit (the `TLocal = never` default) for a pure outbound proxy.
    */
   readonly localTarget?: TLocal;

   /**
    * Method names of {@link localTarget} to bind as inbound handlers.
    * REQUIRED for the binding to happen (no auto-enumeration — TypeScript
    * access modifiers are erased at runtime, so a class instance's
    * prototype carries internal helpers that must not become wire
    * endpoints; the explicit list is the allowlist). Declare it
    * `as const satisfies keyof TLocal` at the call site for a compile-time
    * drift check; `bindRpcMethods` additionally verifies each name exists
    * on the target at attach time.
    */
   readonly localMethods?: readonly (keyof TLocal & string)[];

   /**
    * Forwarded to the inbound {@link localTarget} binding: when supplied, every
    * inbound handler is timed into this collector under its wire name. Lets a
    * head that owns its server through `createRpcProxy` (rather than a bare
    * `bindRpcMethods` call) still capture per-method latency. Absent by default.
    */
   readonly latency?: BindRpcMethodsOptions['latency'];

   /**
    * Forwarded to the inbound {@link localTarget} binding: renders the message
    * an outgoing rejection carries. Only the inbound direction has rejections
    * to render — the outbound proxy is this side making requests, and a
    * rejection it receives was rendered by whoever answered.
    */
   readonly renderErrorMessage?: BindRpcMethodsOptions['renderErrorMessage'];
}

/**
 * Default notification discriminator — `on`-followed-by-an-uppercase-letter
 * methods are notifications (`onProgress`, `onDocumentUpdated`).
 *
 * The uppercase requirement is what keeps the heuristic honest: a
 * request-shaped method that merely *starts* with the letters "on"
 * (`onboardUser`, `onlineCheck`) stays a request, instead of being misrouted
 * as a fire-and-forget notification with its `Promise` result silently
 * dropped. It follows the observer-callback convention the framework's
 * contracts already use, where the capital always marks the event name.
 *
 * Still lexical, so it cannot catch everything — `onDemandRebuild` reads as a
 * request but matches. Supply a custom
 * {@link CreateRpcProxyOptions.isNotification} for contracts that don't fit
 * the convention, and pass the same predicate to both ends.
 */
export function defaultIsNotification(methodName: string): boolean {
   return /^on[A-Z]/.test(methodName);
}

/**
 * Runtime enforcement of the single-arg convention. TypeScript catches
 * misuse at compile time for typed contract callers, but loosely-typed
 * callsites (`any` / `unknown` proxy) would silently drop extra args.
 * Throw loudly so the violation is visible.
 */
function assertSingleArg(wireName: string, args: unknown[]): void {
   if (args.length > 1) {
      throw new Error(
         `RPC method '${wireName}' called with ${args.length} arguments — typed contracts use a single params object. ` +
            'Pass a single object instead: proxy.foo({ ...args }).'
      );
   }
}

/**
 * Build a typed RPC proxy `T` over a vscode-jsonrpc {@link MessageConnection}.
 * Every method access on the returned object lowers transparently to
 * `connection.sendRequest` (request methods) or `connection.sendNotification`
 * (notification methods, by default `on*`-prefixed). The single-arg
 * payload shape is preserved: `proxy.foo(args)` sends `(method, args)`
 * over the wire and resolves with the response.
 *
 * `on` + an uppercase letter is the only notification marker — see
 * {@link defaultIsNotification}, and pass a custom `isNotification` to both
 * ends for a contract that doesn't fit.
 *
 * **Wire tracing.** The proxy adds no tracing layer of its own, deliberately:
 * vscode-jsonrpc's own `connection.trace` already covers wire method names,
 * params, results and errors, and a second layer here would double every
 * traced line.
 *
 * Accepts either a ready connection or a `Promise<MessageConnection>` —
 * proxy methods called before the promise resolves queue until it does,
 * then dispatch, so adopters can wire the proxy before its underlying
 * transport is available (e.g. before the Langium services finish
 * constructing).
 *
 * A few property names are intercepted rather than dispatched — see
 * {@link RpcProxyLifecycle} for the reserved list and why each is guarded.
 *
 * Each method of `T` dispatches under `<methodNamespace><methodName>`: a
 * request method resolves through `connection.sendRequest`, while one the
 * notification heuristic matches goes out through `sendNotification` and
 * returns nothing, so a caller that awaits it waits on `undefined` rather
 * than on delivery.
 *
 * **Combined proxy + inbound binding.** Supply `localTarget` + `localMethods`
 * to ALSO register inbound handlers on the same connection in one call —
 * the typical both-ends-of-a-bidirectional-connection setup. The remote
 * proxy is still the return value; the inbound binding tears down on
 * `connection.onClose`, so binding twice over one connection leaks the
 * first set of handlers until it closes.
 */
export function createRpcProxy<T extends object, TLocal extends object = never>(
   connection: MessageConnection | Promise<MessageConnection>,
   options: CreateRpcProxyOptions<TLocal> = {}
): RpcProxy<T> {
   const methodNamespace = options.methodNamespace ?? '';
   assertValidMethodNamespace(methodNamespace, 'createRpcProxy');
   const isNotification = options.isNotification ?? defaultIsNotification;
   const resolvedConnection = Promise.resolve(connection);

   // Tied to `connection.onClose` so the inbound handlers release with the
   // connection; see `localTarget` for why no `Disposable` is surfaced.
   const { localTarget, localMethods } = options;
   if (localTarget && localMethods && localMethods.length > 0) {
      const binding = bindRpcMethods(connection, localTarget, localMethods, {
         methodNamespace,
         isNotification,
         latency: options.latency,
         renderErrorMessage: options.renderErrorMessage
      });
      resolvedConnection.then(conn => conn.onClose(() => binding.dispose())).catch(() => undefined);
   }

   const onDidOpenConnectionEmitter = new Emitter<void>();
   const onDidCloseConnectionEmitter = new Emitter<void>();
   resolvedConnection
      .then(conn => {
         onDidOpenConnectionEmitter.fire(undefined);
         conn.onClose(() => onDidCloseConnectionEmitter.fire(undefined));
      })
      .catch(() => {
         // Connection promise rejected — treat as never-opened; lifecycle
         // events simply never fire. Adopters observe transport-construction
         // failures through their own connection-construction error handling.
      });

   const target = Object.create(null) as T;
   return new Proxy(target, {
      get(_t, prop) {
         if (typeof prop !== 'string') {
            return undefined;
         }
         // Keep the proxy out of thenable / serializer code paths so it
         // doesn't trigger spurious requests.
         if (prop === 'then' || prop === 'toJSON') {
            return undefined;
         }
         if (prop === 'onDidOpenConnection') {
            return onDidOpenConnectionEmitter.event;
         }
         if (prop === 'onDidCloseConnection') {
            return onDidCloseConnectionEmitter.event;
         }
         const wireName = methodNamespace + prop;
         if (isNotification(prop)) {
            return (...args: unknown[]): void => {
               assertSingleArg(wireName, args);
               // Fire-and-forget; rejection (e.g. connection closed) is swallowed
               // to match the notification contract — adopters observe transport
               // failures via the connection's own close / error events, never
               // via a notification's return value.
               void resolvedConnection.then(connection => connection.sendNotification(wireName, args[0])).catch(() => undefined);
            };
         }
         return (...args: unknown[]): Promise<unknown> => {
            assertSingleArg(wireName, args);
            // Capture the calling stack frame BEFORE the await so debugging gets
            // both client- and server-side stacks on rejection. vscode-jsonrpc's
            // default error envelope surfaces only the server-side stack; without
            // this, a rejected RPC promise looks like it came from "somewhere
            // inside vscode-jsonrpc" rather than from the calling code.
            const capturedError = new Error(`RPC request '${wireName}' failed`);
            return resolvedConnection
               .then(connection => connection.sendRequest(wireName, args[0]))
               .catch((err: unknown) => {
                  if (err instanceof Error && capturedError.stack) {
                     err.stack = `${err.stack ?? err.message}\nCaused by request from:\n${capturedError.stack}`;
                  }
                  throw err;
               });
         };
      }
   }) as RpcProxy<T>;
}
