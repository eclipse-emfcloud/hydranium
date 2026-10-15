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
// A dangling reference is the FRAMEWORK's own linker diagnostic; a repeated
// name is reported by the scaffold's own validation check. Bind a further
// check in your language module and assert it here alongside these.

import { parseHelper } from '@hydranium/core/testing';
import { describe, expect, it } from 'vitest';
import { DiagnosticSeverity } from 'vscode-languageserver';
import type { BookstoreModel } from '../src/language-server/ast.js';
import { createServices } from '../src/node/services.js';

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

   it('warns on each node named like one before it', async () => {
      const { shared, Bookstore } = createServices();

      const document = await parseHelper<BookstoreModel>(Bookstore)('node first\nnode second\nnode first', {
         documentUri: 'file:///duplicate.bookstore'
      });
      await shared.workspace.DocumentBuilder.build([document], { validation: true });

      const diagnostics = document.diagnostics ?? [];
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0].severity).toBe(DiagnosticSeverity.Warning);
      expect(diagnostics[0].message).toBe("A node named 'first' is already declared.");
      expect(diagnostics[0].range.start.line).toBe(2);
   });
});
