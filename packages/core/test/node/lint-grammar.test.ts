/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { type AstReflection, type Grammar, type TypeMetaData } from '@hydranium/langium';
import { describe, expect, it } from 'vitest';
import { collectGrammarLint } from '../../src/node/lint-grammar.js';
import { type ReflectableLanguageServices } from '../../src/node/reflect-grammar.js';

/** Per-type shape a {@link reflection} fixture accepts. */
interface FakeType {
   superTypes?: string[];
   properties?: Record<string, { referenceType?: string }>;
}

/** A reflection stub serving `getAllTypes()` + per-type `superTypes`/`properties`. */
function reflection(types: Record<string, FakeType>): AstReflection {
   return {
      getAllTypes: () => Object.keys(types),
      getTypeMetaData: (type: string): TypeMetaData => {
         const declared = types[type] ?? {};
         const properties = Object.fromEntries(Object.entries(declared.properties ?? {}).map(([name, meta]) => [name, { name, ...meta }]));
         return { name: type, superTypes: declared.superTypes ?? [], properties } as unknown as TypeMetaData;
      }
   } as unknown as AstReflection;
}

/** Build a language services fixture from grammar rules + a language id. */
function language(languageId: string, rules: ReadonlyArray<Record<string, unknown>>): ReflectableLanguageServices {
   return {
      Grammar: { rules } as unknown as Grammar,
      LanguageMetaData: { languageId, fileExtensions: ['.demo'], caseInsensitive: false, mode: 'production' }
   };
}

const ENTRY_RULE = { $type: 'ParserRule', name: 'Root', entry: true };

describe('collectGrammarLint', () => {
   it('passes a grammar whose reference targets are nameable and which has an entry rule', () => {
      const result = collectGrammarLint(
         reflection({
            Root: { properties: { ref: { referenceType: 'TypeOne' } } },
            TypeOne: { properties: { name: {} } }
         }),
         [language('demo', [ENTRY_RULE])]
      );

      expect(result.findings).toEqual([]);
      expect(result.counts).toEqual({ error: 0, warning: 0 });
      expect(result.checkedReferenceTargets).toBe(1);
      expect(result.nameProperties).toEqual(['name']);
   });

   it('flags a concrete reference target that carries no name property', () => {
      const result = collectGrammarLint(
         reflection({
            Root: { properties: { ref: { referenceType: 'TypeOne' } } },
            TypeOne: { properties: { title: {} } }
         }),
         [language('demo', [ENTRY_RULE])]
      );

      expect(result.counts.error).toBe(1);
      expect(result.findings[0]).toMatchObject({ rule: 'reference-target-unnameable', severity: 'error', type: 'TypeOne' });
   });

   it('respects a custom name property set', () => {
      const passes = collectGrammarLint(
         reflection({ Root: { properties: { ref: { referenceType: 'TypeOne' } } }, TypeOne: { properties: { id: {} } } }),
         [language('demo', [ENTRY_RULE])],
         ['id']
      );
      expect(passes.findings).toEqual([]);
      expect(passes.nameProperties).toEqual(['id']);
   });

   it('checks only concrete leaves, not the abstract super type of a reference target', () => {
      // `BaseType` is referenced but abstract (has subtypes); its leaves carry a name → clean.
      const result = collectGrammarLint(
         reflection({
            Root: { properties: { ref: { referenceType: 'BaseType' } } },
            BaseType: {},
            TypeOne: { superTypes: ['BaseType'], properties: { name: {} } },
            TypeTwo: { superTypes: ['BaseType'], properties: { name: {} } }
         }),
         [language('demo', [ENTRY_RULE])]
      );
      expect(result.findings).toEqual([]);
   });

   it('flags an unnameable leaf reached through an abstract reference target', () => {
      const result = collectGrammarLint(
         reflection({
            Root: { properties: { ref: { referenceType: 'BaseType' } } },
            BaseType: {},
            TypeOne: { superTypes: ['BaseType'], properties: { name: {} } },
            TypeTwo: { superTypes: ['BaseType'], properties: { label: {} } }
         }),
         [language('demo', [ENTRY_RULE])]
      );
      expect(result.counts.error).toBe(1);
      expect(result.findings[0]).toMatchObject({ rule: 'reference-target-unnameable', type: 'TypeTwo' });
   });

   it('flags a language with no entry rule', () => {
      const result = collectGrammarLint(reflection({}), [language('demo', [{ $type: 'ParserRule', name: 'Root', entry: false }])]);
      expect(result.counts.error).toBe(1);
      expect(result.findings[0]).toMatchObject({ rule: 'no-entry-rule', language: 'demo' });
   });
});
