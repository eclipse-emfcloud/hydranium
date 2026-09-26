/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { type URI } from '@hydranium/langium';

// Not re-exported from the workspace barrel: the framework's providers share
// it, and it is no API of theirs.

/**
 * A missing-file error shaped as a Node file system raises it, with code
 * `ENOENT` and the path: callers tell a missing file from any other failure by
 * those two fields, whichever provider is bound. The last close relies on it to
 * tell a document gone meanwhile from any other failed rebuild.
 */
export function notFound(message: string, uri: URI): Error {
   return Object.assign(new Error(message), { code: 'ENOENT', path: uri.fsPath });
}
