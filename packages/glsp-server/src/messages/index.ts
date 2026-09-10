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
 * Enumeration only: GLSP's action protocol carries no slot for a message
 * identity on any of its notification actions, so a diagram error reaches the
 * client as English by upstream constraint. The declarations still earn their
 * place — an adopter rendering their own diagram chrome can key on the code, and
 * the barrel is how they discover the codes exist.
 */

export { SAVE_TARGET_UNKNOWN, SOURCE_URI_MISSING } from '../storage/hydranium-glsp-storage.js';
