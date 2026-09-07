/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

// Tier three: does a broken model get reported.
//
// These are the FRAMEWORK's own linker diagnostics, not adopter checks — the
// scaffold binds no `validation.checks`, and a test over an invented one would
// assert its own fixture rather than the language. Bind a check in your
// language module and assert it here alongside these.

import { parseHelper } from '@hydranium/core/testing';
import { describe, expect, it } from 'vitest';
import { DiagnosticSeverity } from 'vscode-languageserver';
import type { BookstoreModel } from '../src/language-server/ast.js';
import { createServices } from '../src/services.js';

describe('Bookstore validation', () => {
   it('reports nothing for a well-formed document', async () => {
      const { shared, Bookstore } = createServices();

      const document = await parseHelper<BookstoreModel>(Bookstore)('node first -> second\nnode second', {
         documentUri: 'file:///valid.bookstore'
      });
      await shared.workspace.DocumentBuilder.build([document], { validation: true });

      expect(document.diagnostics ?? []).toHaveLength(0);
   });

   it('reports an error for a reference that resolves to nothing', async () => {
      const { shared, Bookstore } = createServices();

      const document = await parseHelper<BookstoreModel>(Bookstore)('node first -> absent', {
         documentUri: 'file:///dangling.bookstore'
      });
      await shared.workspace.DocumentBuilder.build([document], { validation: true });

      const diagnostics = document.diagnostics ?? [];
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0].severity).toBe(DiagnosticSeverity.Error);
      expect(diagnostics[0].message).toContain('absent');
   });
});
