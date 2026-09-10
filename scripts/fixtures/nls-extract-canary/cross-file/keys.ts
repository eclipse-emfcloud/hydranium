/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

// CANARY — the sibling module this fixture's key is imported FROM. A same-file
// constant resolves fine, so the second file is what makes the reference
// cross-file and therefore droppable.

export const CROSS_FILE_KEY = 'canary/cross-file/dropped';
