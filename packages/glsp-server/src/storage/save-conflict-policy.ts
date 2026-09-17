/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * How `HydraniumGlspStorage.saveSourceModel` delivers its result: whether the
 * GLSP save action awaits the write, and what happens on failure.
 *
 * The two are not independent — fire-and-forget plus rethrow would leave an
 * unhandled rejection — so each arm bundles them into one coherent, nameable
 * policy an adopter selects whole. It is a *selection of configuration*,
 * delivered as a bound option (see the {@link SaveConflictPolicy} symbol) rather
 * than a behaviour hook.
 *
 * **No arm guards on a based-on version**, despite the name. A save flushes the
 * store's settled text rather than authoring from the diagram's captured model,
 * and the store already holds every other client's change — so there is no stale
 * copy for a guard to refuse, and refusing would withhold a correct write.
 */
export type SaveConflictPolicy =
   /**
    * Await the write and propagate any failure to the GLSP save action. The
    * default.
    */
   | { kind: 'overwrite' }
   /**
    * Await the write and surface any failure to the GLSP save action.
    * Indistinguishable from `overwrite` now that neither guards a version;
    * retained because an adopter binding it means "a failed save must be
    * visible", which a future arm may honour differently.
    */
   | { kind: 'reject' }
   /**
    * Fire-and-forget, logging and swallowing every failure. Correct when a
    * failed diagram save must neither block the action nor surface as an error,
    * which is the posture a head takes when GLSP exposes no save-failure
    * back-channel to report it on.
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
