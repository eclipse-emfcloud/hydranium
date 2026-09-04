/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * Re-exports of Langium's `langium/test` helpers, so that
 * `@hydranium/core/testing` is one import location for both test patterns:
 *
 * - the stubs from this subpath (`makeTestServices`, the `Stub*` classes) —
 *   when the unit under test is a framework production class and can be
 *   exercised without a real Langium grammar, against a
 *   `ServerSharedServices`-shaped tree that no parser drives;
 * - the Langium helpers re-exported here (`parseHelper`, `expectCompletion`,
 *   `expectError`, …) — when the unit under test needs the AST a real grammar
 *   produces.
 *
 * The re-export is verbatim and uncurated: the source of truth for the helpers'
 * contracts stays Langium upstream, so a rename there surfaces here rather than
 * being absorbed by a hand-maintained list.
 */
export * from '@hydranium/langium/test';
