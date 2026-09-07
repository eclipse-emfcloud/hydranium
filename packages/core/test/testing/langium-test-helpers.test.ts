/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, expect, test } from 'vitest';
import * as langiumTest from '@hydranium/langium/test';
import * as serverCoreTesting from '../../src/testing/index.js';

/**
 * Smoke test for the `langium/test` re-export. Asserts the surface lifts
 * verbatim — no manual curation that could go stale relative to Langium
 * upstream.
 */
describe('@hydranium/core/testing — langium/test re-export', () => {
   /**
    * The functions adopters most commonly reach for. If Langium renames or
    * removes any of them, this test fails — flagging that adopters need to
    * follow Langium's deprecation path.
    */
   const KEY_HELPERS = ['parseHelper', 'expectCompletion', 'expectError', 'expectFormatting'] as const;

   test.each(KEY_HELPERS)('re-exports %s from langium/test', name => {
      expect((serverCoreTesting as Record<string, unknown>)[name]).toBe((langiumTest as Record<string, unknown>)[name]);
   });

   test('parseHelper is a callable function', () => {
      expect(typeof serverCoreTesting.parseHelper).toBe('function');
   });

   test('re-export covers every named export from langium/test', () => {
      const upstream = Object.keys(langiumTest).sort();
      const downstream = Object.keys(serverCoreTesting).sort();
      // Every upstream name must appear in the downstream surface.
      const missing = upstream.filter(name => !downstream.includes(name));
      expect(missing).toEqual([]);
   });
});
