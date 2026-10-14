/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import type { MessageConnection } from 'vscode-jsonrpc/browser';

type Send = (type: unknown, ...params: unknown[]) => unknown;

/**
 * `connection` as a connection of another `vscode-jsonrpc` copy takes a send:
 * a message type built by this copy throws, since a connection matches the
 * type's `ParameterStructures.auto` by identity, and a method name goes out.
 */
export function anotherCopyConnection(connection: MessageConnection): MessageConnection {
   const guarded =
      (send: Send): Send =>
      (type, ...params) => {
         if (typeof type !== 'string') {
            throw new Error('Unknown parameter structure auto');
         }
         return send(type, ...params);
      };
   const sendRequest = guarded(connection.sendRequest.bind(connection) as Send);
   const sendNotification = guarded(connection.sendNotification.bind(connection) as Send);
   return new Proxy(connection, {
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
}
