// GLSP diagram-type and element-type ids for the __GRAMMAR__ diagram.
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
export const __GRAMMAR_ID_CONST___DIAGRAM_TYPE = '__LANGUAGE_ID__';

/** A `__NODE_RULE__` — the starter grammar's one named, referenceable node. */
export const __GRAMMAR_ID_CONST___NODE_TYPE = `${DefaultTypes.NODE}:__GRAMMAR_ID__-node`;

/** A resolved `target` reference, drawn as a connection between two nodes. */
export const __GRAMMAR_ID_CONST___EDGE_TYPE = `${DefaultTypes.EDGE}:__GRAMMAR_ID__-target`;
