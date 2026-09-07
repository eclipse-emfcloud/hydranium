/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

// Tier one of the three a new language breaks in order: does my rule parse.
//
// Grammar-derived, so replacing the starter grammar replaces this file — but
// the SHAPE survives, which is the point of scaffolding it: the questions stay
// the same for every language, only the source text changes.

import { parseHelper } from '@hydranium/core/testing';
import { describe, expect, it } from 'vitest';
import type { BookstoreModel } from '../src/language-server/ast.js';
import { createServices } from '../src/services.js';

describe('Bookstore parsing', () => {
   it('parses the starter rules and populates the AST', async () => {
      const { Bookstore } = createServices();

      const document = await parseHelper<BookstoreModel>(Bookstore)('node first -> second\nnode second', {
         documentUri: 'file:///parsing.bookstore'
      });

      expect(document.parseResult.lexerErrors).toHaveLength(0);
      expect(document.parseResult.parserErrors).toHaveLength(0);
      expect(document.parseResult.value.nodes.map(node => node.name)).toEqual(['first', 'second']);
   });

   it('reports a parser error for text the grammar does not accept', async () => {
      const { Bookstore } = createServices();

      // The name is mandatory, so this is a parse failure rather than a
      // validation one — nothing downstream of the parser runs on it.
      const document = await parseHelper<BookstoreModel>(Bookstore)('node -> second', {
         documentUri: 'file:///invalid.bookstore'
      });

      expect(document.parseResult.parserErrors.length).toBeGreaterThan(0);
   });
});
