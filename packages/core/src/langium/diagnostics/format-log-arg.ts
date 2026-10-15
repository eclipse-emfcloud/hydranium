/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describeErrorWithStack } from '@hydranium/protocol';

/**
 * Render a log argument for the single string a line carries, to the LSP
 * `window/logMessage` channel and the log file: a string as it is, an error by
 * its stack and causes, another object as JSON, and anything else, what JSON
 * renders as nothing or cannot render included, by its description. Never
 * throws, since a log call that throws loses the line and interrupts its
 * caller. A `%s`-style specifier is not substituted.
 */
export function formatLogArg(value: unknown): string {
   if (typeof value === 'string') {
      return value;
   }
   if (typeof value === 'object' && value !== null) {
      try {
         // `undefined` where `toJSON` returns nothing.
         const json: string | undefined = value instanceof Error ? undefined : JSON.stringify(value);
         if (json !== undefined) {
            return json;
         }
      } catch {
         // Cyclic, not serialisable, or a revoked proxy; described below instead.
      }
   }
   return describeErrorWithStack(value);
}
