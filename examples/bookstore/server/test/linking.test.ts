/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

// Tier two: does my cross-reference resolve.
//
// Both cases matter and they fail for different reasons. A same-document
// reference resolves through local scope alone; a cross-document one needs the
// declaring document's exports in the shared global index, which is what a
// multi-file workspace depends on and what a single-document test cannot see.

import { parseHelper } from '@hydranium/core/testing';
import { describe, expect, it } from 'vitest';
import { AstUtils } from '@hydranium/langium';
import type { BookstoreModel } from '../src/language-server/ast.js';
import { createServices } from '../src/services.js';

describe('Bookstore linking', () => {
   it('resolves a reference within one document', async () => {
      const { shared, Bookstore } = createServices();

      const document = await parseHelper<BookstoreModel>(Bookstore)('node first -> second\nnode second', {
         documentUri: 'file:///within.bookstore'
      });
      await shared.workspace.DocumentBuilder.build([document]);

      expect(document.parseResult.value.nodes[0].target?.ref?.name).toBe('second');
   });

   it('resolves a reference across documents, through the shared index', async () => {
      const { shared, Bookstore } = createServices();
      const parse = parseHelper<BookstoreModel>(Bookstore);

      const declaring = await parse('node second', { documentUri: 'file:///declaring.bookstore' });
      const referencing = await parse('node first -> second', { documentUri: 'file:///referencing.bookstore' });
      await shared.workspace.DocumentBuilder.build([declaring, referencing]);

      // The URI, not just the name: the referencing document declares no
      // `second` of its own, but asserting WHERE the target came from is what
      // keeps this about the global index rather than about local scope.
      const target = referencing.parseResult.value.nodes[0].target?.ref;
      expect(target?.name).toBe('second');
      expect(target ? AstUtils.getDocument(target).uri.toString() : undefined).toBe('file:///declaring.bookstore');
   });
});
