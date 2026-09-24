/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { LogMessageNotification, MessageType, type Features, type RemoteConsole } from 'vscode-languageserver';
import { isConnectionGoneError } from '../util/connection-liveness.js';

/**
 * Add Hydranium's connection-liveness handling to a language-server
 * connection's console. The upstream `RemoteConsole` catches every failed log
 * notification and prints `Sending log message failed`, so every ordinary
 * teardown reports a failure; this console drops only a failure that
 * {@link isConnectionGoneError} recognises and re-raises any other as an
 * unhandled rejection.
 *
 * Supply it where the connection is created. `createConnection` builds the
 * console from these features, so a connection that already exists keeps the
 * upstream console for its whole lifetime.
 */
export function withHydraniumLspFeatures<T extends Features>(features: T): T {
   return {
      ...features,
      console: (Base: new () => RemoteConsole) =>
         class extends Base {
            override error(message: string): void {
               this.sendLogMessage(MessageType.Error, message);
            }

            override warn(message: string): void {
               this.sendLogMessage(MessageType.Warning, message);
            }

            override info(message: string): void {
               this.sendLogMessage(MessageType.Info, message);
            }

            override log(message: string): void {
               this.sendLogMessage(MessageType.Log, message);
            }

            override debug(message: string): void {
               this.sendLogMessage(MessageType.Debug, message);
            }

            private sendLogMessage(type: MessageType, message: string): void {
               try {
                  void this.connection.sendNotification(LogMessageNotification.type, { type, message }).catch(error => {
                     this.handleLogSendFailure(error);
                  });
               } catch (error) {
                  this.handleLogSendFailure(error);
               }
            }

            private handleLogSendFailure(error: unknown): void {
               if (!isConnectionGoneError(error)) {
                  void Promise.reject(error);
               }
            }
         }
   } as T;
}
