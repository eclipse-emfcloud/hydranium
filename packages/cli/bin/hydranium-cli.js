#!/usr/bin/env node
/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

// Committed rather than built, so the first install of a fresh clone links it:
// npm skips a `bin` whose target is missing, and `lib/` exists only after a build.
import '../lib/cli.js';
