/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { NameBasedKeyProvider } from './name-based-key-provider.js';

/**
 * Re-export of {@link NameBasedKeyProvider} under the conventional
 * "default" name — the framework's default key strategy. Aliased
 * rather than subclassed so the editorial intent ("this IS the default")
 * is visible at the binding line; the concrete implementation lives on
 * {@link NameBasedKeyProvider} with its full stability documentation.
 */
export const DefaultElementKeyProvider = NameBasedKeyProvider;
export type DefaultElementKeyProvider = NameBasedKeyProvider;
