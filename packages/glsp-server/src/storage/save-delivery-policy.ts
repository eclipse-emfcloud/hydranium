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
 * delivered as a bound option (see the {@link SaveDeliveryPolicy} symbol) rather
 * than a behaviour hook.
 *
 * **Neither arm guards on a based-on version.** A save flushes the store's
 * settled text rather than authoring from the diagram's captured model, and the
 * store already holds every other client's change — so a guard here refuses a
 * write whose content is already correct. The gate that does exist sits on the
 * update path, per operation, where the diagram authors.
 */
export type SaveDeliveryPolicy =
   /** Await the write and propagate any failure to the GLSP save action. The default. */
   | { kind: 'await' }
   /**
    * Fire-and-forget, logging and swallowing every failure. Correct when a
    * failed diagram save must neither block the action nor surface as an error.
    */
   | { kind: 'fire-and-forget' };

/** The policy applied when no {@link SaveDeliveryPolicy} option is bound. */
export const DEFAULT_SAVE_DELIVERY_POLICY: SaveDeliveryPolicy = { kind: 'await' };

/**
 * DI token for the {@link SaveDeliveryPolicy} option. Bind a constant value in a
 * `DiagramModule` to select a non-default policy; left unbound,
 * `HydraniumGlspStorage` falls back to {@link DEFAULT_SAVE_DELIVERY_POLICY}.
 * Shares its name with the type, the way a `class` is both a value and a type.
 */
export const SaveDeliveryPolicy = Symbol('SaveDeliveryPolicy');
