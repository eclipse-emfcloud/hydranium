/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

// The LSP requests a host queries to discover this server's socket heads.
//
// Both are keyed by the PROJECT, not the language: one server of each kind per
// process serves every registered grammar, so a language-derived name would tie
// a project-level endpoint to whichever grammar was scaffolded first.
//
// The server publishes them and a host shell has to name the same string to
// reach the head; both import them from here. A shell that retypes the literal
// gets no error when it drifts: the framework's port poll retries indefinitely
// by default.
//
// The host commands are the same ports for a host with no language client,
// such as a Theia app sideloading the servers extension: it runs the command
// and the extension sends the request.

/** LSP request the host queries to discover the data-server socket port. */
export const BOOKSTORE_DATA_SERVER_PORT_COMMAND = 'bookstore/data-server/port';

/** LSP request the host queries to discover the GLSP socket port. */
export const BOOKSTORE_GLSP_SERVER_PORT_COMMAND = 'bookstore/glsp-server/port';

/** Host command the servers extension answers with the data-server socket port. */
export const BOOKSTORE_DATA_SERVER_HOST_COMMAND = 'bookstore.port.dataServer';

/** Host command the servers extension answers with the GLSP socket port. */
export const BOOKSTORE_GLSP_SERVER_HOST_COMMAND = 'bookstore.port.glsp';
