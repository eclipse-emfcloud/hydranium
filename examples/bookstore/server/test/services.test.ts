/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

// The scaffold's first test: the DI tree composes and every language is
// registered. Deliberately grammar-agnostic, so it keeps passing once you
// replace the starter grammar with your own.
//
// `createServices()` not throwing is itself an assertion — the framework's
// `assertCoreSlotsBound` runs during bootstrap and fails loudly when a module
// is missing from the composition.

import { describe, expect, it } from 'vitest';
import { createServices } from '../src/services.js';

describe('Bookstore services', () => {
   it('composes the DI tree and registers exactly one language', () => {
      const { shared } = createServices();

      const registered = shared.ServiceRegistry.all.map(language => language.LanguageMetaData);
      expect(registered.map(metadata => metadata.languageId)).toEqual(['bookstore']);
      expect(registered.flatMap(metadata => [...metadata.fileExtensions])).toEqual(['.bookstore']);
   });

   it('binds a reflection covering the generated AST', () => {
      const { shared } = createServices();

      expect(shared.AstReflection.getAllTypes().length).toBeGreaterThan(0);
   });
});
