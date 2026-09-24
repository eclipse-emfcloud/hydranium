/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import type { Connection } from 'vscode-languageserver';
import { isConnectionGoneError } from '../util/connection-liveness.js';

const wrappedConnections = new WeakSet<object>();

/**
 * Protect Langium's fire-and-forget diagnostics publish from the expected
 * failure caused by a peer disconnecting during teardown.
 *
 * A publish issued after the connection is disposed throws synchronously
 * instead of rejecting, and Langium's publisher is a document-phase listener,
 * so an unguarded throw fails the build that validated the document. The
 * `try` answers that case with a resolved promise; a guard on the promise
 * alone never sees it.
 *
 * Otherwise the original promise is returned unchanged. The detached catch is
 * deliberate: it marks the original promise as observed, suppresses only the
 * expected connection-liveness error, and rethrows unexpected failures so they
 * stay visible as unhandled rejections, as an unguarded fire-and-forget send
 * would leave them.
 */
export function guardDiagnosticsConnection(connection: Connection): void {
   if (wrappedConnections.has(connection)) {
      return;
   }
   wrappedConnections.add(connection);

   const sendDiagnostics = connection.sendDiagnostics.bind(connection);
   connection.sendDiagnostics = params => {
      let result: Promise<void>;
      try {
         result = sendDiagnostics(params);
      } catch (error: unknown) {
         if (isConnectionGoneError(error)) {
            return Promise.resolve();
         }
         throw error;
      }
      void result.catch(error => {
         if (isConnectionGoneError(error)) {
            return;
         }
         throw error;
      });
      return result;
   };
}
