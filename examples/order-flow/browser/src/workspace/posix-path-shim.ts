/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * The one `path` function the portable framework surface still reaches for,
 * implemented for a host that has no `node:path`.
 *
 * `@hydranium/core`'s workspace initialization imports bare `'path'` — not
 * `node:path` — specifically so a browser bundle can alias it here. That is the
 * only such import left on the portable `.` entry, and it is reached only by the
 * headless seam that accepts workspace folders as filesystem-path *strings*. A
 * browser host passes `WorkspaceFolder` URIs through LSP `initialize` instead,
 * so nothing here is expected to run; it exists to make the module graph
 * resolve.
 *
 * # The alias must stay this narrow
 *
 * Aliasing bare `'path'` does NOT alias `node:path`, which keeps the bundle's
 * neutrality property intact: a genuine Node import anywhere in the graph still
 * fails the build rather than silently binding to this shim. Widening the alias
 * to cover `node:*` would trade a loud build failure for a runtime one in a
 * worker with no console attached.
 */

/**
 * POSIX `path.resolve`. A browser has no working directory, so a fully relative
 * argument list resolves against the root rather than against a cwd — which is
 * the only defensible answer, and differs from Node's.
 */
export function resolve(...segments: string[]): string {
   let resolved = '';
   let isAbsolute = false;
   for (let i = segments.length - 1; i >= 0 && !isAbsolute; i--) {
      const segment = segments[i];
      if (segment.length === 0) {
         continue;
      }
      resolved = resolved.length === 0 ? segment : `${segment}/${resolved}`;
      isAbsolute = segment.startsWith('/');
   }

   const parts: string[] = [];
   for (const part of resolved.split('/')) {
      if (part === '' || part === '.') {
         continue;
      }
      if (part === '..') {
         parts.pop();
      } else {
         parts.push(part);
      }
   }
   return `/${parts.join('/')}`;
}
