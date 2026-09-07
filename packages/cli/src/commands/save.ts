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
import * as fs from 'node:fs/promises';
import { logLevelEnv } from '../log-level.js';
import { withDataServer } from '../spawn-data-server.js';

/**
 * Options for the {@link runSave} subcommand. Updates the document at
 * `uri` with `content` (literal text or `@<path>` for a file reference)
 * and persists it via the data-server's `saveModelDocument` RPC. Writes
 * the post-save envelope as a single JSON line — the same shape
 * `query` emits, so a save's output is consumable by the same `jq`
 * pipelines.
 *
 * `clientId` defaults to `'hydranium-cli'` — adopters wanting a richer
 * identity (per-user, per-script) override.
 */
export interface SaveCommandOptions {
   readonly serverCommand: string;
   readonly serverArgs?: readonly string[];
   readonly cwd?: string;
   /** Log threshold for the spawned server, set on its `HYDRANIUM_LOG_LEVEL` env. */
   readonly logLevel?: LogThreshold;
   readonly uri: string;
   /** Literal content text, or `@<path>` to read from a file. */
   readonly content: string;
   readonly clientId?: string;
   readonly write?: (line: string) => void;
   readonly __proxyForTest?: DataServerProtocol<TransferElement>;
   /** Test-only: override the file-reader so unit tests can stub `@<path>` expansion. */
   readonly __readFileForTest?: (path: string) => Promise<string>;
}

export async function runSave(options: SaveCommandOptions): Promise<void> {
   const write = options.write ?? ((line: string) => process.stdout.write(line));
   const clientId = options.clientId ?? 'hydranium-cli';
   const model = await resolveContent(options.content, options.__readFileForTest);

   if (options.__proxyForTest) {
      const doc = await options.__proxyForTest.saveModelDocument({ uri: options.uri, clientId, model });
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
         const doc = await server.saveModelDocument({ uri: options.uri, clientId, model });
         write(`${JSON.stringify(doc)}\n`);
      }
   );
}

/**
 * Resolve the `--content` argument to its textual form. The `@<path>`
 * prefix reads from a file (parses as UTF-8); anything else is taken
 * literally. The leading `@` can be escaped as `\@` for content that
 * legitimately starts with `@`.
 */
async function resolveContent(content: string, readFile?: (path: string) => Promise<string>): Promise<string> {
   if (content.startsWith('@')) {
      const path = content.slice(1);
      const reader = readFile ?? ((target: string) => fs.readFile(target, 'utf8'));
      return reader(path);
   }
   if (content.startsWith('\\@')) {
      return content.slice(1);
   }
   return content;
}
