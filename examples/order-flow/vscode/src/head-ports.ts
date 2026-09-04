/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * Discovery of the server's socket heads from the extension host.
 *
 * Both ports are ephemeral and published as LSP requests, so the host asks the
 * running language client for them rather than reading configuration. The
 * request names are imported from the server package, never restated here: a
 * retyped literal still compiles, the server never answers a request it does not
 * publish, and the failure surfaces as an exhausted poll rather than at build
 * time.
 *
 * Importing them across the module-system boundary works: this package is
 * CommonJS and the server is ESM, and Node 22's `require(esm)` resolves it —
 * verified by running the emitted output, not only by compiling it.
 */

import { ORDER_FLOW_DATA_SERVER_PORT_COMMAND, ORDER_FLOW_GLSP_PORT_COMMAND } from '@hydranium/example-order-flow-server';
import type { LanguageClient } from 'vscode-languageclient/node';

/** The LSP request each socket head answers with its listening port. */
export const ORDER_FLOW_PORT_COMMANDS = {
   dataServer: ORDER_FLOW_DATA_SERVER_PORT_COMMAND,
   glsp: ORDER_FLOW_GLSP_PORT_COMMAND
} as const;

/**
 * The server registers its port request handlers asynchronously, after the
 * heads have bound their sockets, so the first request legitimately fails. Poll
 * until one answers — bounded, unlike the framework's Theia-side default of
 * `findPortAttempts = -1`, so a genuinely wrong command surfaces as an error
 * instead of hanging forever.
 */
export async function awaitPort(
   client: LanguageClient,
   portCommand: string,
   options: { attempts?: number; intervalMs?: number } = {}
): Promise<number> {
   const attempts = options.attempts ?? 40;
   const intervalMs = options.intervalMs ?? 500;
   let lastError: unknown;
   for (let attempt = 0; attempt < attempts; attempt++) {
      try {
         const port = await client.sendRequest<number>(portCommand);
         if (typeof port === 'number' && port > 0) {
            return port;
         }
      } catch (error: unknown) {
         lastError = error;
      }
      await new Promise(resolve => setTimeout(resolve, intervalMs));
   }
   throw new Error(
      `No port answered '${portCommand}' after ${attempts} attempts. ` +
         `Check that the server publishes it${lastError instanceof Error ? `: ${lastError.message}` : ''}`
   );
}
