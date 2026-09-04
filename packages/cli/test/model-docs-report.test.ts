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
import { formatModelDocs } from '../src/commands/model-docs-report.js';

const REFLECTION: GrammarReflection = {
   languages: [
      {
         languageId: 'demo',
         fileExtensions: ['.demo'],
         entryRule: 'Root',
         terminals: [{ name: 'ID', pattern: '\\w+', hidden: false }]
      }
   ],
   types: [
      {
         name: 'TypeOne',
         superTypes: ['BaseType'],
         directSubTypes: [],
         properties: [
            { name: 'name', array: false, hasDefault: false },
            { name: 'type', referenceType: 'TypeTwo', array: false, hasDefault: false }
         ]
      },
      { name: 'TypeTwo', superTypes: [], directSubTypes: [], properties: [{ name: 'name', array: false, hasDefault: false }] },
      { name: 'BaseType', superTypes: [], directSubTypes: ['TypeOne'], properties: [{ name: 'name', array: false, hasDefault: false }] }
   ]
};

describe('formatModelDocs', () => {
   const output = formatModelDocs(REFLECTION);

   it('renders a title, language summary, and terminals table', () => {
      expect(output).toContain('# Model reference');
      expect(output).toContain('### demo');
      expect(output).toContain('- Entry rule: `Root`');
      expect(output).toContain('| ID | `\\w+` |  |');
   });

   it('renders an anchor-linked type index marking abstract types', () => {
      expect(output).toContain('## Types (3)');
      expect(output).toContain('- [TypeOne](#typeone)');
      // BaseType has a subtype → abstract marker.
      expect(output).toContain('- [BaseType](#basetype) _(abstract)_');
   });

   it('cross-links super/sub types and reference-property targets', () => {
      expect(output).toContain('- Extends: [BaseType](#basetype)');
      expect(output).toContain('- Known subtypes: [TypeOne](#typeone)');
      // TypeOne.type references TypeTwo → linked target cell.
      expect(output).toContain('| type | reference | [TypeTwo](#typetwo) |  |');
   });

   it('builds a reverse referenced-by index on the target type', () => {
      // TypeTwo is referenced by TypeOne.type.
      expect(output).toContain('- Referenced by: [TypeOne](#typeone).type');
   });

   it('classifies non-reference properties as value', () => {
      expect(output).toContain('| name | value |  |  |');
   });
});
