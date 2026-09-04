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
      renameServerLogs(this.dir);
   }
}
