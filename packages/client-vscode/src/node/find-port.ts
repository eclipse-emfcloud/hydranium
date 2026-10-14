/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/** Options for {@link findPort}. */
export interface FindPortOptions {
   /**
    * How many requests to send before giving up, the first included, so at
    * least 1. The Theia handler's `findPortAttempts` counts the retries after
    * the first instead.
    */
   readonly attempts?: number;
   /** The wait after each failed attempt. */
   readonly intervalMs?: number;
}

/** {@link FindPortOptions.attempts} when none is given. */
export const DEFAULT_FIND_PORT_ATTEMPTS = 40;
/** {@link FindPortOptions.intervalMs} when none is given. */
export const DEFAULT_FIND_PORT_INTERVAL_MS = 500;

/**
 * Ask the language server for a socket head's listening port.
 *
 * The server registers its port requests after the heads bind their sockets,
 * so the first requests legitimately fail and this polls. The poll is bounded,
 * unlike the Theia handler's default, so a request the server never publishes
 * surfaces as an error instead of a connection that waits forever.
 *
 * Call it once per connection rather than caching the answer: a restarted
 * server binds a fresh ephemeral port. `client` is typed by the one method
 * used, which `vscode-languageclient`'s `LanguageClient` has, so this package
 * does not pin the adopter's copy.
 */
export async function findPort(
   client: { sendRequest<R>(method: string): Promise<R> },
   request: string,
   options: FindPortOptions = {}
): Promise<number> {
   const attempts = options.attempts ?? DEFAULT_FIND_PORT_ATTEMPTS;
   const intervalMs = options.intervalMs ?? DEFAULT_FIND_PORT_INTERVAL_MS;
   if (!Number.isInteger(attempts) || attempts < 1) {
      throw new RangeError(`findPort: attempts must be a whole number of at least 1, got ${attempts}`);
   }
   let lastError: unknown;
   for (let attempt = 0; attempt < attempts; attempt++) {
      try {
         const port = await client.sendRequest<unknown>(request);
         if (typeof port === 'number' && port > 0) {
            return port;
         }
      } catch (error: unknown) {
         lastError = error;
      }
      if (attempt + 1 < attempts) {
         await new Promise(resolve => setTimeout(resolve, intervalMs));
      }
   }
   const detail = lastError instanceof Error ? ` The last attempt failed: ${lastError.message}` : '';
   throw new Error(
      `No port answered '${request}' after ${attempts} ${attempts === 1 ? 'attempt' : 'attempts'}. Check that the server publishes it.${detail}`
   );
}
