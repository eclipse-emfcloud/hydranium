/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * Chokepoint mirror of Langium's `langium/test` subpath — parsing and
 * validation test helpers. Pure passthrough; it exists so framework packages
 * and adopters reach every Langium subpath through this package and inherit
 * its version pin instead of owning one themselves.
 */
export * from 'langium/test';
