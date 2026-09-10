/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { renameServerLogs, type ServerLogRenameReporterOptions } from './server-log-capture.js';

/**
 * Playwright reporter (registered by path via `captureServerLog`) that, at
 * the end of the run — once every per-frontend server has exited — renames the
 * opaque `<workspace-token>.log` files to spec names via {@link renameServerLogs}.
 * Implements only `onEnd`; declared structurally so this module imports nothing
 * from `@playwright/test`.
 */
export default class ServerLogRenameReporter {
   protected readonly dir: string;

   constructor(options: ServerLogRenameReporterOptions) {
      this.dir = options.dir;
   }

   onEnd(): void {
      const unattributed = renameServerLogs(this.dir);
      if (unattributed.length > 0) {
         // Loud, because the alternative is a capture run that reads as
         // complete: these logs exist and have content, but are named by an
         // opaque workspace token and carry no test boundaries, so nothing
         // about them says which spec they belong to.
         console.warn(
            `[server-log] ${unattributed.length} captured log(s) belong to no test: ${unattributed.join(', ')}.\n` +
               '[server-log] Those specs never marked a boundary — apply the `serverLog` fixture, ' +
               'or call `markServerLog`/`attachServerLog` from the suite, or their logs cannot be read per test.'
         );
      }
   }
}
