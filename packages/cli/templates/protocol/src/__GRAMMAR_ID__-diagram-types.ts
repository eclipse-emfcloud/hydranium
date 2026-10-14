// GLSP diagram-type and element-type ids for the __GRAMMAR__ diagram, which the
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
import { __GRAMMAR_ID_CONST___LANGUAGE } from './generated-hydranium/languages.js';

/**
 * The GLSP diagram type — the string GLSP routes every per-diagram-type request
 * by. A mismatch silently DROPS the request rather than reporting an unknown
 * diagram type. Read from the language id, so renaming the language renames
 * the diagram type at the next `generate`.
 */
export const __GRAMMAR_ID_CONST___DIAGRAM_TYPE = __GRAMMAR_ID_CONST___LANGUAGE.languageId;

/** A `__NODE_RULE__` — the starter grammar's one named, referenceable node. */
export const __GRAMMAR_ID_CONST___NODE_TYPE = `${DefaultTypes.NODE}:__GRAMMAR_ID__-node`;

/** A resolved `target` reference, drawn as a connection between two nodes. */
export const __GRAMMAR_ID_CONST___EDGE_TYPE = `${DefaultTypes.EDGE}:__GRAMMAR_ID__-target`;

/**
 * Every element type id the server stamps.
 *
 * A tuple, so {@link __GRAMMAR__ElementType} is a union of the ids rather than
 * `string`: a client table keyed by that union does not compile while an id
 * lacks its registration. Nothing holds the tuple to the constants above, so
 * an id declared without joining it escapes that check.
 */
export const __GRAMMAR_ID_CONST___ELEMENT_TYPES = [__GRAMMAR_ID_CONST___NODE_TYPE, __GRAMMAR_ID_CONST___EDGE_TYPE] as const;

/** One of the element type ids in {@link __GRAMMAR_ID_CONST___ELEMENT_TYPES}. */
export type __GRAMMAR__ElementType = (typeof __GRAMMAR_ID_CONST___ELEMENT_TYPES)[number];
