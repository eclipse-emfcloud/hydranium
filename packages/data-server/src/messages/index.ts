/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * Every user-facing message `@hydranium/data-server` raises.
 *
 * Declarations stay beside their call sites and are re-exported here, so this is
 * enumeration rather than centralization: a code's package segment has to name
 * the package that raises it. The English is a fallback, not a contract; the
 * code is the contract, and renaming one is a breaking change.
 */

export { NO_ACTIVE_PROFILE, NO_ACTIVE_PROFILE_CODE, noActiveProfileError } from '../data-server.js';
