/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * Every user-facing message `@hydranium/glsp-server` raises.
 *
 * **Each one is rendered AT ITS RAISE SITE**, through the shared
 * `MessageRenderer`, because GLSP's action protocol carries no slot for an
 * identity on any of its actions — so the identity is gone the moment a raise
 * site formats its text, and there is nothing at the error boundary to render
 * from. That makes this head the one place where a new message can ship
 * unrendered without any single chokepoint noticing, which is why the package's
 * own test suite scans for a declaration reached by `.format()` instead.
 *
 * The barrel is also how an adopter rendering their own diagram chrome
 * discovers the codes exist.
 */

export {
   DIAGRAM_REDO_CONFLICT,
   DIAGRAM_REDO_ERROR,
   DIAGRAM_REDO_FAILED,
   DIAGRAM_REDO_PARTLY_SKIPPED,
   DIAGRAM_REDO_SKIPPED,
   DIAGRAM_REDO_SYNTAX_ERROR,
   DIAGRAM_UNDO_CONFLICT,
   DIAGRAM_UNDO_ERROR,
   DIAGRAM_UNDO_FAILED,
   DIAGRAM_UNDO_PARTLY_SKIPPED,
   DIAGRAM_UNDO_SKIPPED,
   DIAGRAM_UNDO_SYNTAX_ERROR
} from '../command/hydranium-glsp-undo-redo-action-handler.js';
export { DIAGRAM_LAYOUT_STALE } from '../computed-bounds/hydranium-glsp-computed-bounds-action-handler.js';
export { DIAGRAM_EDIT_DROPPED } from '../status/diagram-status-reporter.js';
export {
   DIAGRAM_READONLY_PARSE_ERROR,
   DIAGRAM_SESSION_REFUSED,
   SAVE_TARGET_UNKNOWN,
   SOURCE_URI_MISSING
} from '../storage/hydranium-glsp-storage.js';
