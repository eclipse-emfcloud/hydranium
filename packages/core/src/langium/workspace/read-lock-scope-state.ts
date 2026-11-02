/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import type { WorkspaceLock } from '@hydranium/langium';
import type { ReadLockMark, ReadLockScope } from './read-lock-scope.js';

/**
 * The installed read-lock scope tracker, in a module of its own so the
 * workspace lock can read the caller's read without a public export.
 */
export const readLockScopeState: {
   scope: ReadLockScope | undefined;
} = { scope: undefined };

/** The lock that runs each read, so a wait for another lock's work is not refused there. */
export const readLockOwners = new WeakMap<ReadLockMark, WorkspaceLock>();
