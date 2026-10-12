/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { existsSync, readFileSync } from 'node:fs';

/**
 * How far each log has been read. A suite starts its app before its first
 * test's marker, so reading from the marker would leave startup unread.
 */
const readUpTo = new Map<string, number>();

/**
 * The part of `file` written since the last read of it, up to its last complete
 * line, since the server may be mid-write. Every test reads, checked or not, so
 * a test that is not checked leaves no lines to the next one.
 */
export function readServerLogRegion(file: string): string {
   if (!existsSync(file)) {
      return '';
   }
   const log = readFileSync(file);
   const end = log.lastIndexOf('\n') + 1;
   const text = log.subarray(readUpTo.get(file) ?? 0, end).toString('utf-8');
   readUpTo.set(file, end);
   return text;
}
