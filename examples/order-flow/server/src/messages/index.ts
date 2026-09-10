/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * Every user-facing message this example's server raises.
 *
 * An adopter enumerates its own codes exactly as the framework does — the
 * declarations stay beside their call sites and are re-exported here, so a
 * barrel is enumeration rather than centralization. `collectMessages(barrel)`
 * then yields every code and English default, which is what a translator needs
 * and what this example's catalogue test checks its keys against.
 *
 * Reached as `@hydranium/example-order-flow-server/lib/messages`. The framework's
 * own packages expose the same thing under a `./messages` subpath; this example
 * has no `exports` map, so the built path is the specifier.
 */

export { DUPLICATE_TRANSITION, SELF_TRANSITION } from '../language-server/process-validation.js';
export { PALETTE_EFFECT, PALETTE_GATEWAY, PALETTE_TASK, PALETTE_TRANSITION } from '../glsp/order-flow-tool-palette-item-provider.js';
