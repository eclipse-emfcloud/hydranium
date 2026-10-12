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

/**
 * Options for the {@link runDelete} subcommand. Deletes the document at `uri`,
 * its file and then the document, via the data-server's `deleteModelDocument`
 * RPC, whatever text it holds. Prints nothing; a failed delete rejects.
 *
 * `clientId` defaults to `'hydranium-cli'`. The command deletes as a client
 * session under it: it registers the session, opens the document, deletes it,
 * and ends the session.
 */
export interface DeleteCommandOptions extends LogOptions {
   readonly serverCommand: string;
   readonly serverArgs?: readonly string[];
   readonly cwd?: string;
   readonly uri: string;
   readonly clientId?: string;
   readonly __proxyForTest?: DataServerProtocol<TransferElement>;
}

export async function runDelete(options: DeleteCommandOptions): Promise<void> {
   const clientId = options.clientId ?? 'hydranium-cli';
   if (options.__proxyForTest) {
      await deleteOpened(options.__proxyForTest, options.uri, clientId);
      return;
   }
   await withDataServer(
      {
         command: options.serverCommand,
         args: options.serverArgs,
         cwd: options.cwd,
         env: logEnv(options)
      },
      server => deleteOpened(server, options.uri, clientId)
   );
}

/** Open `uri` as the session `clientId` and delete it, then end the session. */
function deleteOpened(
   server: Pick<DataServerProtocol<TransferElement>, 'createSession' | 'openModelDocument' | 'deleteModelDocument' | 'closeSession'>,
   uri: string,
   clientId: string
): Promise<void> {
   return withClientSession(server, clientId, async () => {
      await server.openModelDocument({ uri, clientId });
      await server.deleteModelDocument({ uri, clientId, baseVersion: 'any' });
   });
}
