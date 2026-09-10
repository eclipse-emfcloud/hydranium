/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * Every user-facing message `@hydranium/core` raises, plus the carrier helpers
 * that attach an identity to one.
 *
 * Declarations stay beside their call sites and are re-exported here, so this is
 * enumeration rather than centralization: a code's package segment has to name
 * the package that raises it. The English is a fallback, not a contract; the
 * code is the contract, and renaming one is a breaking change.
 */

export * from './carriers.js';
export * from './renderer.js';

export { MODEL_UPDATE_EDIT } from '../langium/model-service/model-service.js';
export { SEPARATOR_IN_NAME } from '../langium/naming/name-separator-validation.js';
export { UNRESOLVED_REFERENCE } from '../langium/validation/document-validator.js';
export { NO_LOADABLE_CONTENT } from '../langium/workspace/langium-documents.js';
export { NO_SUCH_FILE, NO_SUCH_PATH } from '../langium/workspace/in-memory-file-system-provider.js';
