/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/** Ordering cells on the browser dispatch scope: renders, saves, handler dispatches and client responses arriving while the diagram is busy. */

import { describeOrdering } from './uncommitted-edit-harness.js';

describeOrdering('browser', 'rest');
