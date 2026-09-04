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
import { collectGrammarReflection, type ReflectableLanguageServices } from '../../src/node/reflect-grammar.js';

/** Per-type shape a {@link reflection} fixture accepts (mirrors the reflection meta data we read). */
interface FakeType {
   superTypes?: string[];
   properties?: Record<string, { defaultValue?: unknown; referenceType?: string }>;
}

/**
 * A reflection stub richer than the shared `makeFakeReflection` (which models
 * `getTypeMetaData().properties` only): this one also serves `getAllTypes()` and
 * per-type `superTypes`, which the grammar-reflection collector reads. Local to
 * this suite — the shared builder's signature cannot express a type hierarchy.
 */
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

/** Build a `ReflectableLanguageServices` from a grammar rule list + language meta data. */
function language(
   languageId: string,
   fileExtensions: string[],
   rules: ReadonlyArray<Record<string, unknown>>
): ReflectableLanguageServices {
   return {
      Grammar: { rules } as unknown as Grammar,
      LanguageMetaData: { languageId, fileExtensions, caseInsensitive: false, mode: 'production' }
   };
}

function terminalRule(name: string, source: string, hidden = false): Record<string, unknown> {
   return { $type: 'TerminalRule', name, hidden, definition: { $type: 'RegexToken', regex: `/${source}/` } };
}

function parserRule(name: string, entry = false): Record<string, unknown> {
   return { $type: 'ParserRule', name, entry };
}

describe('collectGrammarReflection', () => {
   it('sorts types, inverts superTypes into directSubTypes, and flattens property meta data', () => {
      const result = collectGrammarReflection(
         reflection({
            BaseType: { properties: { name: {} } },
            TypeOne: {
               superTypes: ['BaseType'],
               properties: {
                  members: { defaultValue: [] },
                  ref: { referenceType: 'TypeTwo' },
                  name: {}
               }
            },
            TypeTwo: { properties: { members: { defaultValue: [] } } }
         }),
         []
      );

      // Types are alphabetical.
      expect(result.types.map(type => type.name)).toEqual(['BaseType', 'TypeOne', 'TypeTwo']);

      const base = result.types.find(type => type.name === 'BaseType')!;
      // `BaseType` gains `TypeOne` as a direct subtype (inverted from TypeOne.superTypes).
      expect(base.directSubTypes).toEqual(['TypeOne']);

      const one = result.types.find(type => type.name === 'TypeOne')!;
      expect(one.superTypes).toEqual(['BaseType']);
      // Properties are alphabetical, with array / reference / default surfaced.
      expect(one.properties).toEqual([
         { name: 'members', referenceType: undefined, array: true, hasDefault: true },
         { name: 'name', referenceType: undefined, array: false, hasDefault: false },
         { name: 'ref', referenceType: 'TypeTwo', array: false, hasDefault: false }
      ]);
   });

   it('reflects a language: id, extensions, entry rule, and terminals (name, pattern, hidden)', () => {
      const result = collectGrammarReflection(reflection({}), [
         language(
            'demo',
            ['.demo', '.dm'],
            [terminalRule('WS', '\\s+', true), parserRule('Root', true), terminalRule('ID', '\\w+'), parserRule('TypeOne')]
         )
      ]);

      expect(result.languages).toHaveLength(1);
      const [demo] = result.languages;
      expect(demo.languageId).toBe('demo');
      expect(demo.fileExtensions).toEqual(['.demo', '.dm']);
      expect(demo.entryRule).toBe('Root');
      expect(demo.terminals).toEqual([
         { name: 'WS', pattern: '\\s+', hidden: true },
         { name: 'ID', pattern: '\\w+', hidden: false }
      ]);
   });

   it('degrades to a pattern-less terminal when the rule cannot be compiled to a RegExp', () => {
      const result = collectGrammarReflection(reflection({}), [
         // A terminal rule with no resolvable definition — terminalRegex throws, caught to undefined.
         language('demo', ['.demo'], [{ $type: 'TerminalRule', name: 'BROKEN', hidden: false, definition: {} }])
      ]);

      expect(result.languages[0].terminals).toEqual([{ name: 'BROKEN', pattern: undefined, hidden: false }]);
      expect(result.languages[0].entryRule).toBeUndefined();
   });
});
