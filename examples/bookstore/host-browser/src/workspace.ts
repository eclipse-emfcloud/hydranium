/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

// The workspace root both ends name: the worker seeds its filesystem under it
// and the page opens documents by URIs below it.

/** The URI of the workspace root, which holds the files of `../workspace`. */
export const WORKSPACE_ROOT_URI = 'file:///workspace';
