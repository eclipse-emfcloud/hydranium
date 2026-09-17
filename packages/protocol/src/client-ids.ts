/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * Well-known values of the wire's `clientId` / `sourceClientId` field.
 *
 * The framework tracks each document as belonging to one or more "clients" —
 * typically an LSP-text client (Monaco, VS Code, …), a GLSP diagram client,
 * and/or a structured-form client — and keys its holds and watches per
 * `(uri, clientId)`. These three values are not real participants, so a client
 * minting its own id must avoid them.
 *
 * **Here rather than in the server package, because the side that has to
 * RECOGNISE them is the client.** An inbound `onDocumentUpdated` carries
 * `sourceClientId`, and a consumer deciding what to do with it is asking which
 * of these it is — so a frontend would otherwise have to depend on the server
 * tier to name three strings, and in practice retypes the literal instead.
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

/**
 * Every id the framework reserves, for a client checking that the identity it
 * is about to mint collides with none of them.
 */
export const FRAMEWORK_CLIENT_IDS: readonly string[] = [LANGUAGE_CLIENT_ID, UNKNOWN_CLIENT_ID, REVERT_ON_CLOSE_CLIENT_ID];
