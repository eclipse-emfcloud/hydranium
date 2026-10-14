/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

// GLSP diagram-type and element-type ids for the Bookstore diagram, which the
// server stamps onto the graph and every client registers.
//
// Declared once, here, for both ends. A drift between them fails silently:
// sprotty's registries are exact-key maps with no prefix fallback, so an id the
// client does not know yields an element with none of a node's features,
// rendered by `MissingView` with only a `no registered view for type '…'`
// console warning. Nothing fails server-side.
//
// The ids stay namespaced under the GLSP defaults (`node:` / `edge:`) so a
// reader can tell a node id from an edge id at a glance.

import { DefaultTypes } from '@eclipse-glsp/protocol';
import { BOOKSTORE_LANGUAGE } from './generated-hydranium/languages.js';

/**
 * The GLSP diagram type — the string GLSP routes every per-diagram-type request
 * by. A mismatch silently DROPS the request rather than reporting an unknown
 * diagram type. Read from the language id, so renaming the language renames
 * the diagram type at the next `generate`.
 */
export const BOOKSTORE_DIAGRAM_TYPE = BOOKSTORE_LANGUAGE.languageId;

/** A `BookstoreNode` — the starter grammar's one named, referenceable node. */
export const BOOKSTORE_NODE_TYPE = `${DefaultTypes.NODE}:bookstore-node`;

/** A resolved `target` reference, drawn as a connection between two nodes. */
export const BOOKSTORE_EDGE_TYPE = `${DefaultTypes.EDGE}:bookstore-target`;

/**
 * Every element type id the server stamps.
 *
 * A tuple, so {@link BookstoreElementType} is a union of the ids rather than
 * `string`: a client table keyed by that union does not compile while an id
 * lacks its registration. Nothing holds the tuple to the constants above, so
 * an id declared without joining it escapes that check.
 */
export const BOOKSTORE_ELEMENT_TYPES = [BOOKSTORE_NODE_TYPE, BOOKSTORE_EDGE_TYPE] as const;

/** One of the element type ids in {@link BOOKSTORE_ELEMENT_TYPES}. */
export type BookstoreElementType = (typeof BOOKSTORE_ELEMENT_TYPES)[number];
