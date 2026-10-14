/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { LAYOUT_LANGUAGE, PROCESS_LANGUAGE } from '@hydranium/example-order-flow-protocol';

/**
 * The one rule binding a layout to its process: the same path, with `.layout`
 * for `.process`. The diagram reads and writes the layout at
 * {@link layoutUriFor}, and the layout's entries resolve against the process at
 * {@link processUriFor}, so the two directions have to stay each other's
 * inverse.
 */

// The first extension is each grammar's canonical one; a layout pairs with a
// process by it, and a second extension would not be swapped.
const [PROCESS_EXTENSION] = PROCESS_LANGUAGE.fileExtensions;
const [LAYOUT_EXTENSION] = LAYOUT_LANGUAGE.fileExtensions;

/** The layout file for a process document. */
export function layoutUriFor(processUri: string): string {
   return swapExtension(processUri, PROCESS_EXTENSION, LAYOUT_EXTENSION);
}

/** The process document a layout file lays out. */
export function processUriFor(layoutUri: string): string {
   return swapExtension(layoutUri, LAYOUT_EXTENSION, PROCESS_EXTENSION);
}

function swapExtension(uri: string, from: string, to: string): string {
   return uri.endsWith(from) ? uri.slice(0, -from.length) + to : uri;
}
