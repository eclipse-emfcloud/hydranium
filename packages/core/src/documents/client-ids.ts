/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * Well-known client-kind identifiers used across the multi-client framework.
 *
 * The framework tracks each document as belonging to one or more "clients"
 * — typically an LSP-text-client (Monaco, VS Code, etc.), a GLSP diagram
 * client, and/or a structured-form client. Each kind carries a stable id so
 * the server can route outbound corrections, edits, and notifications to the
 * right transport.
 */

/** Identifier for an LSP-text client (Monaco, VS Code, …). */
export const LANGUAGE_CLIENT_ID = 'language-client';

/** Fallback identifier when a document's author is unknown (e.g. cold workspace-init load). */
export const UNKNOWN_CLIENT_ID = 'unknown';

/**
 * Synthetic author id on the `onDocumentUpdated` broadcast a data-server
 * emits after the LAST client closed a document and the framework rebuilt it
 * from its disk content (discarding unsaved in-session edits). Not a real
 * client: it lets consumers distinguish the revert broadcast from
 * client-authored updates.
 */
export const REVERT_ON_CLOSE_CLIENT_ID = 'revert-on-close';
