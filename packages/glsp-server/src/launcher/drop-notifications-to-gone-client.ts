/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import type { Logger as GlspLogger } from '@eclipse-glsp/server';
import { isClientGoneError } from '@hydranium/core';

/**
 * `connection` with a notification to a client that has gone dropped, logged
 * at debug, rather than left to throw or reject. GLSP sends every action as a
 * notification and drops the promise, so a client that disconnects mid-write
 * (an `EPIPE`) or a send after GLSP disposed the connection is otherwise an
 * unhandled rejection on every ordinary close. Any other failure still throws
 * or rejects: {@link isClientGoneError} tells the two apart, as on the
 * LSP head. A launcher that overrides `createConnection` applies it, as the
 * framework's own do.
 */
export function dropNotificationsToGoneClient<T extends { sendNotification(method: string, ...params: unknown[]): Promise<void> }>(
   connection: T,
   logger: GlspLogger
): T {
   const dropIfGone = (error: unknown): void => {
      if (!isClientGoneError(error)) {
         throw error;
      }
      logger.debug(`Dropped a notification to a client that has gone: ${String(error)}`);
   };
   const sendNotification = (method: string, ...params: unknown[]): Promise<void> => {
      try {
         return connection.sendNotification(method, ...params).catch(dropIfGone);
      } catch (error: unknown) {
         // A disposed connection throws rather than rejecting.
         dropIfGone(error);
         return Promise.resolve();
      }
   };
   return new Proxy(connection, {
      get(target, property, receiver) {
         return property === 'sendNotification' ? sendNotification : Reflect.get(target, property, receiver);
      }
   });
}
