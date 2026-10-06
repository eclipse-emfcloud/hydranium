/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { type URI } from '@hydranium/langium';

// Not re-exported from the workspace barrel: the framework's providers and
// the release handler share it, and it is no API of theirs.

/**
 * A missing-file error shaped as a Node file system raises it, with code
 * `ENOENT` and the path: callers tell a missing file from any other failure by
 * those two fields, whichever provider is bound. The release relies on it to
 * tell a document gone meanwhile from any other failed rebuild.
 */
export function notFound(message: string, uri: URI): Error {
   return Object.assign(new Error(message), { code: 'ENOENT', path: uri.fsPath });
}

/**
 * Whether `err` reports that the file of `target` does not exist, as a Node
 * file system and {@link notFound} do: code `ENOENT`, with `target`'s path. A
 * missing file of another document is a different failure.
 */
export function isFileNotFound(err: unknown, target: URI): boolean {
   if (typeof err !== 'object' || err === null || !('code' in err) || err.code !== 'ENOENT') {
      return false;
   }
   return !('path' in err) || err.path === target.fsPath;
}
