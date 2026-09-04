/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import type { LogThreshold, TransferElement } from '@hydranium/protocol';
import type { DataServerProtocol } from '@hydranium/protocol/data';
import { logLevelEnv } from '../log-level.js';
import { withDataServer } from '../spawn-data-server.js';

/**
 * Options for the {@link runQuery} subcommand. Prints the data-server's
 * current view of a document — invokes `getModelDocument({ uri })` on
 * the spawned subprocess and writes the response envelope as a single
 * JSON line. Adopters piping the output into `jq` get a complete record
 * per invocation.
 *
 * Test-only `__proxyForTest` bypasses the spawn for unit tests; the
 * production CLI never passes it.
 */
export interface QueryCommandOptions {
   readonly serverCommand: string;
   readonly serverArgs?: readonly string[];
   readonly cwd?: string;
   /** Log threshold for the spawned server, set on its `HYDRANIUM_LOG_LEVEL` env. */
   readonly logLevel?: LogThreshold;
   readonly uri: string;
   readonly write?: (line: string) => void;
   readonly __proxyForTest?: DataServerProtocol<TransferElement>;
}

export async function runQuery(options: QueryCommandOptions): Promise<void> {
   const write = options.write ?? ((line: string) => process.stdout.write(line));

   if (options.__proxyForTest) {
      // One-shot, unsubscribed read — request validation so the dumped envelope carries diagnostics.
      const doc = await options.__proxyForTest.getModelDocument({ uri: options.uri, includeDiagnostics: true });
      write(`${JSON.stringify(doc)}\n`);
      return;
   }

   await withDataServer(
      {
         command: options.serverCommand,
         args: options.serverArgs,
         cwd: options.cwd,
         env: options.logLevel ? logLevelEnv(options.logLevel) : undefined
      },
      async server => {
         const doc = await server.getModelDocument({ uri: options.uri, includeDiagnostics: true });
         write(`${JSON.stringify(doc)}\n`);
      }
   );
}
