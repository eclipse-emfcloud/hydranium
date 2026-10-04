/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * The one rule binding a layout to its process: the same path, with `.layout`
 * for `.process`. The diagram reads and writes the layout at
 * {@link layoutUriFor}, and the layout's entries resolve against the process at
 * {@link processUriFor}, so the two directions have to stay each other's
 * inverse.
 */

/** The layout file for a process document. */
export function layoutUriFor(processUri: string): string {
   return processUri.replace(/\.process$/, '.layout');
}

/** The process document a layout file lays out. */
export function processUriFor(layoutUri: string): string {
   return layoutUri.replace(/\.layout$/, '.process');
}
