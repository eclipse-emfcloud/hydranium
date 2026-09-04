/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

// GLSP diagram-type and element-type ids for the Bookstore diagram.
//
// **Authoritative half of a client/server contract.** Every id here has to be
// registered on the client too: sprotty's registries are exact-key maps with no
// prefix fallback, so an id the client does not know yields an element with none
// of a node's features, rendered by `MissingView` with only a
// `no registered view for type '…'` console warning. Nothing fails server-side.
//
// The ids stay namespaced under the GLSP defaults (`node:` / `edge:`) so a
// reader can tell a node id from an edge id at a glance.

import { DefaultTypes } from '@eclipse-glsp/server';

/**
 * The GLSP diagram type — the string GLSP routes every per-diagram-type request
 * by. Mirrored by the client; a mismatch silently DROPS the request rather than
 * reporting an unknown diagram type. Same value as the language id, so the two
 * cannot drift apart as a diagram gains element types.
 */
export const BOOKSTORE_DIAGRAM_TYPE = 'bookstore';

/** A `BookstoreNode` — the starter grammar's one named, referenceable node. */
export const BOOKSTORE_NODE_TYPE = `${DefaultTypes.NODE}:bookstore-node`;

/** A resolved `target` reference, drawn as a connection between two nodes. */
export const BOOKSTORE_EDGE_TYPE = `${DefaultTypes.EDGE}:bookstore-target`;
