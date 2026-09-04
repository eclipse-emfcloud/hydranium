/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * How `HydraniumGlspStorage.saveSourceModel` reacts when a concurrent edit has
 * advanced the document past the version this diagram was last captured at.
 *
 * A save spans otherwise-independent choices — whether to guard on the captured
 * based-on version, whether the GLSP save action awaits the persist, and what
 * happens on failure. Each arm bundles those into one coherent, nameable policy
 * so an adopter selects a whole behaviour rather than assembling an incoherent
 * mix: fire-and-forget plus rethrow would leave an unhandled rejection. It is a
 * *selection of configuration*, delivered as a bound option (see the
 * {@link SaveConflictPolicy} symbol) rather than a behaviour hook.
 */
export type SaveConflictPolicy =
   /**
    * Last-write-wins: no based-on guard, await the persist, propagate any
    * failure to the GLSP save action. The default; correct for a single-editor
    * head where nothing races the save.
    */
   | { kind: 'overwrite' }
   /**
    * Guard on the captured version, await the persist, and surface a
    * `ConflictError` (and any other failure) to the GLSP save action.
    */
   | { kind: 'reject' }
   /**
    * Guard on the captured version, fire-and-forget, and log + swallow every
    * failure. Correct when another editor of the same document may already have
    * written the truth, so a stale diagram save is benign and must neither
    * block the action nor surface as an error.
    */
   | { kind: 'drop-and-log' };

/** The policy applied when no {@link SaveConflictPolicy} option is bound. */
export const DEFAULT_SAVE_CONFLICT_POLICY: SaveConflictPolicy = { kind: 'overwrite' };

/**
 * DI token for the {@link SaveConflictPolicy} option. Bind a constant value in a
 * `DiagramModule` to select a non-default policy; left unbound,
 * `HydraniumGlspStorage` falls back to
 * {@link DEFAULT_SAVE_CONFLICT_POLICY}. Shares its name with the type, the way a
 * `class` is both a value and a type.
 */
export const SaveConflictPolicy = Symbol('SaveConflictPolicy');
