/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * The `@hydranium/conformance/glsp/node` subpath: a socket driver for the
 * {@link GlspConformanceDriver} port, over a real TCP socket, for proving a
 * deployed GLSP server rather than a container built in the test process.
 *
 * It speaks GLSP's JSON-RPC by method name, so like the rest of the kit it names
 * no `@eclipse-glsp/*` type and the adopter's fixtures supply every action.
 */

import { randomUUID } from 'node:crypto';
import * as net from 'node:net';
import { createMessageConnection, SocketMessageReader, SocketMessageWriter, type MessageConnection } from 'vscode-jsonrpc/node';
import type { GlspConformanceDriver } from '../index.js';

const DEFAULT_PROTOCOL_VERSION = '1.0.0';

const DEFAULT_TIMEOUT_MS = 15_000;

/** Configuration for {@link connectGlspSocketDriver}. */
export interface GlspSocketDriverOptions<TAction extends { readonly kind: string } = { readonly kind: string }> {
   readonly port: number;
   /** Defaults to `127.0.0.1`. */
   readonly host?: string;
   /** The diagram type the client session is opened for. */
   readonly diagramType: string;
   /**
    * The action kinds this client handles, which the server routes back to it.
    * Declare every kind the server sends during the checks: one it sends that
    * neither side handles fails the server's dispatch, and the session gets a
    * rejected request or an error message instead.
    */
   readonly clientActionKinds: readonly string[];
   /** Defaults to a fresh id per driver, so drivers sharing one server never share a session. */
   readonly clientSessionId?: string;
   readonly applicationId?: string;
   /**
    * The GLSP protocol version announced in `initialize`. The server refuses
    * `initialize` unless it equals its own, so a server on a newer protocol
    * needs this. Defaults to `1.0.0`.
    */
   readonly protocolVersion?: string;
   /**
    * The client's reply to a received action, sent back to the server, or
    * `undefined` for none. A server that lays out on the client finishes a
    * `requestModel` only once its `requestBounds` is answered with
    * `computedBounds`, so a load without this stops half way. A throw fails
    * every pending and later wait with it.
    */
   readonly respond?: (action: TAction) => TAction | undefined;
   /** Default bound for {@link GlspConformanceDriver.nextAction}, and the bound on the TCP connect and on each `start()` request. */
   readonly timeoutMs?: number;
}

/** A {@link GlspConformanceDriver} over a socket, with the actions it received. */
export interface GlspSocketDriver<TAction extends { readonly kind: string }> extends GlspConformanceDriver<TAction> {
   /** Every action the server sent to this session, in arrival order; append-only. */
   readonly actions: ReadonlyArray<TAction>;
}

/** GLSP's `process` notification payload, in either direction. */
interface ActionMessage<TAction> {
   readonly clientId: string;
   readonly action: TAction;
}

function isActionMessage(value: unknown): value is ActionMessage<{ readonly kind: string }> {
   if (typeof value !== 'object' || value === null || !('clientId' in value) || !('action' in value)) {
      return false;
   }
   const { action } = value;
   return typeof action === 'object' && action !== null && 'kind' in action && typeof action.kind === 'string';
}

/**
 * Open a TCP connection to a GLSP server and wrap it as a driver. The session is
 * not initialised until the kit calls `start()`.
 */
export async function connectGlspSocketDriver<TAction extends { readonly kind: string }>(
   options: GlspSocketDriverOptions<TAction>
): Promise<GlspSocketDriver<TAction>> {
   const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
   const clientSessionId = options.clientSessionId ?? `glsp-socket-${randomUUID()}`;
   const socket = await openSocket(options.host ?? '127.0.0.1', options.port, timeoutMs);
   const connection: MessageConnection = createMessageConnection(new SocketMessageReader(socket), new SocketMessageWriter(socket), console);

   const actions: TAction[] = [];
   const send = (action: TAction): void => {
      // Fire-and-forget, so neither a closed connection, which throws here, nor
      // a failed write reaches the caller; the wait that follows reports it.
      try {
         connection.sendNotification('process', { clientId: clientSessionId, action }).catch(() => undefined);
      } catch {
         // Already reported by the closed state every later wait reads.
      }
   };
   const consumed = new WeakSet<TAction>();
   const waiters: Array<{ readonly kind: string; readonly resolve: (action: TAction) => void; readonly fail: (error: Error) => void }> = [];
   // Why no awaited action can arrive any more, once something ended the session.
   let ended: { readonly reason: string; readonly cause?: unknown } | undefined;

   // A wait still pending when the session ends fails at once, naming why,
   // rather than at its timeout reading like a declined operation.
   function end(reason: string, cause?: unknown): void {
      ended ??= { reason, cause };
      for (const waiter of waiters.splice(0)) {
         waiter.fail(new Error(`${ended.reason} while waiting for '${waiter.kind}'`, { cause: ended.cause }));
      }
   }
   const closedReason = `GLSP connection to session ${clientSessionId} closed`;
   connection.onClose(() => end(closedReason));

   connection.onNotification('process', (message: unknown) => {
      if (!isActionMessage(message) || message.clientId !== clientSessionId) {
         return;
      }
      // The fixture's own action type; the guard has checked the one field read here.
      const action = message.action as TAction;
      actions.push(action);
      const index = waiters.findIndex(waiter => waiter.kind === action.kind);
      if (index >= 0) {
         const [waiter] = waiters.splice(index, 1);
         consumed.add(action);
         waiter.resolve(action);
      }
      // The connection only logs a handler's throw, so a fixture bug would
      // otherwise surface as an unrelated wait timing out.
      let reply: TAction | undefined;
      try {
         reply = options.respond?.(action);
      } catch (error: unknown) {
         end(`respond threw on '${action.kind}' (${String(error)})`, error);
         return;
      }
      if (reply) {
         send(reply);
      }
   });
   connection.listen();

   let disposed = false;

   return {
      actions,

      async start(): Promise<void> {
         // Bounded, so a server that accepts the socket and never answers fails
         // naming the request, when the runner's own timeout is the longer one.
         await within(
            connection.sendRequest('initialize', {
               applicationId: options.applicationId ?? 'hydranium-conformance',
               protocolVersion: options.protocolVersion ?? DEFAULT_PROTOCOL_VERSION
            }),
            timeoutMs,
            'initialize'
         );
         await within(
            connection.sendRequest('initializeClientSession', {
               clientSessionId,
               diagramType: options.diagramType,
               clientActionKinds: options.clientActionKinds
            }),
            timeoutMs,
            'initializeClientSession'
         );
      },

      dispatch: send,

      nextAction<T extends TAction = TAction>(kind: string, waitMs = timeoutMs): Promise<T> {
         const existing = actions.find(action => action.kind === kind && !consumed.has(action));
         if (existing) {
            consumed.add(existing);
            return Promise.resolve(existing as T);
         }
         if (ended) {
            return Promise.reject(new Error(`${ended.reason}; no '${kind}' action can arrive`, { cause: ended.cause }));
         }
         return new Promise<T>((resolve, reject) => {
            const waiter = {
               kind,
               resolve: (action: TAction): void => {
                  clearTimeout(timer);
                  resolve(action as T);
               },
               fail: (error: Error): void => {
                  clearTimeout(timer);
                  reject(error);
               }
            };
            const timer = setTimeout(() => {
               const at = waiters.indexOf(waiter);
               if (at >= 0) {
                  waiters.splice(at, 1);
               }
               // Naming what did arrive tells an operation the server declined
               // (a status or nothing at all) apart from a transport that hangs.
               const seen = actions.map(action => action.kind).join(', ') || 'nothing';
               reject(new Error(`No '${kind}' action within ${waitMs}ms on session ${clientSessionId}; received: ${seen}`));
            }, waitMs);
            waiters.push(waiter);
         });
      },

      dispose(): void {
         if (disposed) {
            return;
         }
         disposed = true;
         // A disposed connection fires no close event, so the waits end here.
         end(closedReason);
         connection.dispose();
         socket.destroy();
      }
   };
}

function within<T>(request: Promise<T>, timeoutMs: number, method: string): Promise<T> {
   return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`GLSP server did not answer '${method}' within ${timeoutMs}ms`)), timeoutMs);
      request.then(
         value => {
            clearTimeout(timer);
            resolve(value);
         },
         (error: unknown) => {
            clearTimeout(timer);
            reject(error);
         }
      );
   });
}

function openSocket(host: string, port: number, timeoutMs: number): Promise<net.Socket> {
   return new Promise<net.Socket>((resolve, reject) => {
      const socket = net.createConnection({ host, port });
      const timer = setTimeout(() => {
         socket.destroy();
         reject(new Error(`TCP connect to GLSP server at ${host}:${port} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      socket.once('connect', () => {
         clearTimeout(timer);
         resolve(socket);
      });
      socket.once('error', error => {
         clearTimeout(timer);
         reject(error);
      });
   });
}
