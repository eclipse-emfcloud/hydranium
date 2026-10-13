/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
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
 * Options for the {@link runCreate} subcommand. Creates the document at `uri`
 * with `content` (literal text or `@<path>` for a file reference) via the
 * data-server's `createModelDocument` RPC, and persists that text as it is.
 * Fails when the file exists or a client has it open. Writes the post-save
 * envelope as a single JSON line, as `save` does.
 *
 * `clientId` defaults to `'hydranium-cli'`. The command creates as a client
 * session under it: it registers the session, creates the document, persists
 * it, since a created document reaches disk only with a save, and ends the
 * session.
 */
export interface CreateCommandOptions extends LogOptions {
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

export async function runCreate(options: CreateCommandOptions): Promise<void> {
   const write = options.write ?? ((line: string) => process.stdout.write(line));
   const clientId = options.clientId ?? 'hydranium-cli';
   const text = await resolveContent(options.content, options.__readFileForTest);

   if (options.__proxyForTest) {
      write(`${JSON.stringify(await createPersisted(options.__proxyForTest, options.uri, clientId, text))}\n`);
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
         write(`${JSON.stringify(await createPersisted(server, options.uri, clientId, text))}\n`);
      }
   );
}

/**
 * Create `uri` with `text` as the session `clientId` and persist it, then end
 * the session. The persist is gated on the version the create made, so a
 * write that landed before the create's answer or after it, another client's
 * or an integrity repair, fails the command with a conflict and nothing
 * persists.
 */
function createPersisted(
   server: Pick<DataServerProtocol<TransferElement>, 'createSession' | 'createModelDocument' | 'persistModelDocument' | 'closeSession'>,
   uri: string,
   clientId: string,
   text: string
): Promise<unknown> {
   return withClientSession(server, clientId, async () => {
      const created = await server.createModelDocument({ uri, clientId, text });
      return server.persistModelDocument({ uri, clientId, baseVersion: created.created.version });
   });
}
