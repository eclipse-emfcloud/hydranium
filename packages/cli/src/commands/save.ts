/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import type { TransferElement } from '@hydranium/protocol';
import type { DataServerProtocol } from '@hydranium/protocol/data';
import { logEnv, type LogOptions } from '../log-level.js';
import { withDataServer } from '../spawn-data-server.js';
import { withClientSession } from './client-session.js';
import { resolveContent } from './harness-args.js';

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
 *
 * The command saves as a client session under `clientId`: it registers the
 * session, opens the document, saves, and ends the session, which leaves
 * nothing open behind it. A missing file fails the open; `runCreate` writes a
 * new one.
 */
export interface SaveCommandOptions extends LogOptions {
   readonly serverCommand: string;
   readonly serverArgs?: readonly string[];
   readonly cwd?: string;
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
      write(`${JSON.stringify(await saveOpened(options.__proxyForTest, options.uri, clientId, model))}\n`);
      return;
   }

   await withDataServer(
      {
         command: options.serverCommand,
         args: options.serverArgs,
         cwd: options.cwd,
         env: logEnv(options)
      },
      async server => {
         write(`${JSON.stringify(await saveOpened(server, options.uri, clientId, model))}\n`);
      }
   );
}

/** Open `uri` as the session `clientId` and save `model` to it, then end the session. */
function saveOpened(
   server: Pick<DataServerProtocol<TransferElement>, 'createSession' | 'openModelDocument' | 'saveModelDocument' | 'closeSession'>,
   uri: string,
   clientId: string,
   model: string
): Promise<unknown> {
   return withClientSession(server, clientId, async () => {
      await server.openModelDocument({ uri, clientId });
      return server.saveModelDocument({ uri, clientId, model, baseVersion: 'any' });
   });
}
