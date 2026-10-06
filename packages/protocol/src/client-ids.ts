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

/**
 * The id an event names when no single client is behind it: the source of a
 * `'rebuilt'` event, a document no client authored, or a build with more than
 * one cause.
 */
export const UNKNOWN_CLIENT_ID = 'unknown';

/**
 * Synthetic author id on the `onDocumentUpdated` broadcast a data-server
 * emits for the build that follows a document's release, once no client holds
 * it; by default that build reverts the document to its disk content,
 * discarding unsaved edits. Not a real client: it lets consumers tell the
 * release broadcast from client-authored updates.
 */
export const DOCUMENT_RELEASE_CLIENT_ID = 'document-release';

/**
 * Every id the framework reserves, for a client checking that the identity it
 * is about to mint collides with none of them.
 */
export const FRAMEWORK_CLIENT_IDS: readonly string[] = [LANGUAGE_CLIENT_ID, UNKNOWN_CLIENT_ID, DOCUMENT_RELEASE_CLIENT_ID];
