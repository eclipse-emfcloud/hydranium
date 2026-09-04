/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { type LogFileSink, setLogFileSink } from '../langium/diagnostics/logger.js';

/**
 * `node:fs`-backed {@link LogFileSink}. Synchronous (`appendFileSync`) so log
 * lines preserve emission order; all errors are swallowed because a failing
 * log sink must never propagate.
 */
export const nodeLogFileSink: LogFileSink = {
   append(path: string, data: string): void {
      try {
         appendFileSync(path, data);
      } catch {
         // A failing log sink must not propagate.
      }
   },
   ensureDir(path: string): void {
      try {
         mkdirSync(dirname(path), { recursive: true });
      } catch {
         // ignore — the write attempt will simply fail and be swallowed too.
      }
   }
};

/**
 * Install the Node file-tee sink so a configured `HYDRANIUM_LOG_FILE` target
 * is honoured. Idempotent. Called once at `@hydranium/core/node` load so any
 * Node host that imports the entry gets the file-tee for free.
 */
export function installNodeLogFileSink(): void {
   setLogFileSink(nodeLogFileSink);
}
