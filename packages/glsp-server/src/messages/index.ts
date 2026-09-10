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

export { SAVE_TARGET_UNKNOWN, SOURCE_URI_MISSING } from '../storage/hydranium-glsp-storage.js';
