/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import type { GrammarReflection } from '@hydranium/core/node';
import { describe, expect, it } from 'vitest';
import { formatReflectionReport } from '../src/commands/reflect-report.js';

const REFLECTION: GrammarReflection = {
   languages: [
      {
         languageId: 'demo',
         fileExtensions: ['.demo'],
         entryRule: 'Root',
         terminals: [
            { name: 'WS', pattern: '\\s+', hidden: true },
            { name: 'ID', pattern: '\\w+', hidden: false },
            { name: 'BROKEN', hidden: false }
         ]
      }
   ],
   types: [
      {
         name: 'TypeOne',
         superTypes: ['BaseType'],
         directSubTypes: [],
         properties: [
            { name: 'name', array: false, hasDefault: false },
            { name: 'owner', referenceType: 'TypeTwo', array: false, hasDefault: false }
         ]
      },
      { name: 'BaseType', superTypes: [], directSubTypes: ['TypeOne'], properties: [{ name: 'name', array: false, hasDefault: false }] },
      { name: 'TypeTwo', superTypes: [], directSubTypes: [], properties: [{ name: 'entities', array: true, hasDefault: true }] }
   ]
};

describe('formatReflectionReport', () => {
   it('json: emits the raw reflection', () => {
      const output = formatReflectionReport(REFLECTION, { json: true });
      expect(JSON.parse(output)).toEqual(REFLECTION);
   });

   it('markdown: renders languages, terminals, hierarchy, cross-refs and per-type tables', () => {
      const output = formatReflectionReport(REFLECTION);

      expect(output).toContain('# Grammar reflection');
      // Language surface.
      expect(output).toContain('### demo');
      expect(output).toContain('- Entry rule: `Root`');
      expect(output).toContain('| WS | `\\s+` | yes |');
      expect(output).toContain('| ID | `\\w+` |  |');
      // A pattern-less terminal renders an empty pattern cell.
      expect(output).toContain('| BROKEN |  |  |');
      // Hierarchy: BaseType is a root, TypeOne nested one level under it.
      expect(output).toContain('- BaseType\n  - TypeOne');
      // Cross-reference targets.
      expect(output).toContain('- `TypeOne.owner` → `TypeTwo`');
      // Per-type detail.
      expect(output).toContain('- Super types: `BaseType`');
      expect(output).toContain('| entities |  | yes | yes |');
   });

   it('markdown: notes the absence of cross-references and properties', () => {
      const output = formatReflectionReport({
         languages: [],
         types: [{ name: 'Empty', superTypes: [], directSubTypes: [], properties: [] }]
      });
      expect(output).toContain('_No cross-references._');
      expect(output).toContain('_No properties._');
   });
});
