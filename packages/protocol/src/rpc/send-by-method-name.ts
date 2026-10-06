/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { CancellationToken } from 'vscode-jsonrpc';

/**
 * `connection` with `sendRequest` and `sendNotification` sending a typed message
 * by its method name, so it survives a message type built by another copy of
 * `vscode-jsonrpc`. Wrap a connection wherever it is handed to code that sends
 * another copy's typed messages, GLSP's clients and launchers in particular.
 *
 * **Why an install holds several copies.** Upstream pins exactly:
 * - `@eclipse-glsp/*` 2.x pin `vscode-jsonrpc` `8.2.0`, and npm can nest a copy
 *   under each GLSP package, so GLSP's packages can split from each other: a
 *   connection one of them creates rejects the typed messages another builds.
 *   GLSP's upgrade to 9.x, which could let it share the framework's copy, is
 *   open as https://github.com/eclipse-glsp/glsp/issues/1720.
 * - `vscode-languageserver@10.0.1` pins `vscode-languageserver-protocol`
 *   `3.18.1`, which pins `vscode-jsonrpc` `9.0.0`.
 * - Theia brings protocol `3.17.5` and with it `vscode-jsonrpc` 8.
 *
 * npm hoists one version per name and nests the rest. `overrides` are read from
 * the root manifest alone and never ship with a package, so the framework cannot
 * collapse an adopter's tree.
 *
 * **What breaks across copies.**
 * - Sending: a connection compares a typed message's parameter structure with
 *   its own copy's `ParameterStructures.auto` singleton by identity, so a
 *   `RequestType` or `NotificationType` built by another copy throws
 *   `Unknown parameter structure auto`. GLSP sends typed messages, in
 *   `BaseJsonrpcGLSPClient` and in `JsonrpcClientProxy.process`.
 *   `vscode-languageserver`'s connection resends by method name already, which
 *   is why LSP sends are unaffected.
 * - Types: `ParameterStructures` has a private member, so TypeScript treats each
 *   copy's `MessageConnection` as a different type.
 * - Errors: a connection keeps a thrown `ResponseError`'s code and data only
 *   when the error is an instance of its own copy's class, and sends a returned
 *   one of another copy as a successful result.
 *
 * **What is copy-safe.** Receiving a typed message from another copy, since the
 * receive path compares only against its own `byName` and `byPosition`. With
 * sends by method name, the LSP, data and GLSP heads run over a tree whose GLSP
 * packages keep `vscode-jsonrpc` `8.2.0`.
 *
 * **How it works.** A `Proxy` whose `sendRequest` and `sendNotification` pass the
 * typed message's `method` string; every other member is the connection's own.
 * The parameters go out as the typed send packs them: the first
 * `numberOfParams`, missing ones `null`, and a request's cancellation token
 * from the position after them. Sent by method name, a single parameter goes by
 * name when it is an object and by position otherwise, which matches `auto` and
 * `byName` with an object, as `vscode-languageserver-protocol`'s types use it. A
 * `byPosition` object or a `byName` non-object throws rather than going out in
 * another shape, the packing read from the type's `toString()` since it cannot
 * be compared by identity. So wrapping narrows what a connection accepts: its
 * own copy sends such a type unwrapped. The result is typed as whichever copy's
 * connection its context expects, or as `connection`'s own type without one.
 * That type is the caller's assertion: it holds for the members both copies
 * share, since the sends go by name and the receives are copy-safe.
 *
 * **Where it stops.** Errors: a rejection it produces is still its own copy's
 * `ResponseError`, so recognise errors with `isResponseError`, and build a
 * connection whose errors must keep their code from the framework's copy.
 *
 * See https://github.com/eclipse-emfcloud/hydranium/issues/279.
 */
export function sendByMethodName<
   In extends {
      sendRequest<R>(method: string, ...params: unknown[]): Promise<R>;
      sendNotification(method: string, ...params: unknown[]): Promise<void>;
   },
   Out extends {
      sendRequest<R>(method: string, ...params: unknown[]): Promise<R>;
      sendNotification(method: string, ...params: unknown[]): Promise<void>;
   } = In
>(connection: In): Out {
   const sendRequest = (type: string | TypedMessage, ...params: unknown[]) =>
      typeof type === 'string'
         ? connection.sendRequest(type, ...params)
         : connection.sendRequest(type.method, ...argsOf(type, params, true));
   const sendNotification = (type: string | TypedMessage, ...params: unknown[]) =>
      typeof type === 'string'
         ? connection.sendNotification(type, ...params)
         : connection.sendNotification(type.method, ...argsOf(type, params, false));
   const wrapped: Pick<In, 'sendRequest' | 'sendNotification'> = new Proxy(connection, {
      get(target, property, receiver) {
         if (property === 'sendRequest') {
            return sendRequest;
         }
         if (property === 'sendNotification') {
            return sendNotification;
         }
         return Reflect.get(target, property, receiver);
      }
   });
   // Typed as the connection its context expects, which the doc above justifies.
   return wrapped as Out;
}

/** A typed message as any copy of `vscode-jsonrpc` builds it, read by shape rather than identity. */
interface TypedMessage {
   readonly method: string;
   readonly numberOfParams: number;
   readonly parameterStructures: { toString(): string };
}

/** Whether `vscode-jsonrpc` sends `param` by name under `auto`. */
function isNamedParam(param: unknown): boolean {
   return param !== undefined && param !== null && !Array.isArray(param) && typeof param === 'object';
}

/**
 * The arguments that send `type` by method name with the typed send's params:
 * the first `numberOfParams` of `params`, missing ones `null`, then a request's
 * cancellation token, which the typed send takes from that position. A request
 * always ends in a token, `CancellationToken.None` when it has none, since a
 * send by method name takes a token-shaped last argument for its token. Throws
 * for the one-parameter packing a send by method name cannot express.
 */
function argsOf(type: TypedMessage, params: unknown[], isRequest: boolean): unknown[] {
   const args = Array.from({ length: type.numberOfParams }, (_, i) => (i < params.length ? params[i] : null));
   if (type.numberOfParams === 1) {
      const packing = String(type.parameterStructures);
      if ((packing === 'byPosition' && isNamedParam(args[0])) || (packing === 'byName' && !isNamedParam(args[0]))) {
         throw new Error(
            `sendByMethodName cannot send '${type.method}' ${packing}: by method name, a single object goes by name and anything else by position.`
         );
      }
   }
   if (!isRequest) {
      return args;
   }
   const token = params[type.numberOfParams];
   return [...args, CancellationToken.is(token) ? token : CancellationToken.None];
}
