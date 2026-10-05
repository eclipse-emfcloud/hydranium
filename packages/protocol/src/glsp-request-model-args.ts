/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * The `RequestModelAction` option carrying a diagram's resume token. A load
 * whose token matches the one the live session under its client id was started
 * with takes that session over, so a diagram that reconnects or reloads keeps
 * its unsaved text; without it, the id held by another session is refused.
 */
export const RESUME_TOKEN_ARG = 'hydraniumResumeToken';
