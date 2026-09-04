/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { Project, type SourceFile } from 'ts-morph';
import { describe, expect, it } from 'vitest';
import { parseTerminals, resolveNamespacedStringUnion, typeAliasMemberGuard } from '../src/commands/generate-transfer-model.js';

/**
 * Build an in-memory AST source. Langium's real generated file is far larger, but
 * these tests only read terminal consts and namespaced type aliases, so a
 * hand-written excerpt in the same shape exercises the same code paths without a
 * fixture that has to be regenerated whenever the grammar moves.
 */
function astSource(text: string): SourceFile {
   return new Project({ useInMemoryFileSystem: true }).createSourceFile('ast.ts', text);
}

describe('parseTerminals', () => {
   const singleLanguage = `
      export const ProjectTerminals = {
         ID: /[_a-zA-Z][\\w_]*/,
         WS: /\\s+/
      };
   `;

   const multiLanguage = `
      export namespace LangA {
         export const Terminals = {
            ID: /[_a-zA-Z][\\w_]*/,
            NUMBER: /[0-9]+/
         };
      }
      export namespace LangB {
         export const Terminals = {
            ID: /[_a-zA-Z][\\w_]*/,
            ARROW: /->/
         };
      }
      export const ProjectTerminals = { ...LangA.Terminals, ...LangB.Terminals };
   `;

   it('reads the top-level const for a single-language project', () => {
      const terminals = parseTerminals(astSource(singleLanguage), 'ProjectTerminals', new Set());
      expect(terminals).toEqual([
         { name: 'ID', pattern: '/^(?:[_a-zA-Z][\\w_]*)$/' },
         { name: 'WS', pattern: '/^(?:\\s+)$/' }
      ]);
   });

   it('unions every namespace Terminals const for a multi-language project', () => {
      const names = parseTerminals(astSource(multiLanguage), 'ProjectTerminals', new Set()).map(terminal => terminal.name);
      // The top-level const is a spread (no regex literals of its own), so every
      // pattern comes from the namespaces — and each namespace only carries the
      // terminals its own grammar reaches.
      expect(names).toEqual(['ID', 'NUMBER', 'ARROW']);
   });

   it('de-duplicates a terminal declared by both grammars, keeping the first', () => {
      const terminals = parseTerminals(astSource(multiLanguage), 'ProjectTerminals', new Set());
      expect(terminals.filter(terminal => terminal.name === 'ID')).toHaveLength(1);
   });

   it('honours skipTerminals across both the top-level const and the namespaces', () => {
      const single = parseTerminals(astSource(singleLanguage), 'ProjectTerminals', new Set(['WS'])).map(t => t.name);
      const multi = parseTerminals(astSource(multiLanguage), 'ProjectTerminals', new Set(['ID'])).map(t => t.name);
      expect(single).toEqual(['ID']);
      expect(multi).toEqual(['NUMBER', 'ARROW']);
   });

   it('returns nothing when neither the named const nor a namespace declares terminals', () => {
      expect(parseTerminals(astSource('export const Unrelated = 1;'), 'ProjectTerminals', new Set())).toEqual([]);
   });
});

describe('resolveNamespacedStringUnion', () => {
   const source = astSource(`
      export namespace LangA {
         export type KeywordNames = 'shared' | 'only-a';
      }
      export namespace LangB {
         export type KeywordNames = 'only-b' | 'shared';
         export type NotLiterals = string | number;
      }
   `);

   it('leaves a plain string-literal union untouched', () => {
      expect(resolveNamespacedStringUnion(source, "'a' | 'b'")).toBe("'a' | 'b'");
   });

   it('flattens namespace-qualified members into one union, de-duplicated in first-seen order', () => {
      // 'shared' is declared by both grammars and must appear once.
      expect(resolveNamespacedStringUnion(source, 'LangB.KeywordNames | LangA.KeywordNames')).toBe("'only-b' | 'shared' | 'only-a'");
   });

   it('returns the definition unchanged when a referenced member is not a pure literal union', () => {
      const definition = 'LangB.NotLiterals | LangA.KeywordNames';
      expect(resolveNamespacedStringUnion(source, definition)).toBe(definition);
   });

   it('returns the definition unchanged when the namespace or member does not exist', () => {
      expect(resolveNamespacedStringUnion(source, 'Missing.KeywordNames')).toBe('Missing.KeywordNames');
      expect(resolveNamespacedStringUnion(source, 'LangA.Absent')).toBe('LangA.Absent');
   });
});

describe('typeAliasMemberGuard', () => {
   it('uses typeof for the typeof-checkable Langium primitives', () => {
      expect(typeAliasMemberGuard('string')).toBe("typeof item === 'string'");
      expect(typeAliasMemberGuard('number')).toBe("typeof item === 'number'");
      expect(typeAliasMemberGuard('boolean')).toBe("typeof item === 'boolean'");
      expect(typeAliasMemberGuard('bigint')).toBe("typeof item === 'bigint'");
   });

   it('uses instanceof for Date, which typeof reports as object', () => {
      expect(typeAliasMemberGuard('Date')).toBe('item instanceof Date');
   });

   it('delegates to the generated is<Member> guard for a named type', () => {
      expect(typeAliasMemberGuard('TypeOne')).toBe('isTypeOne(item)');
   });

   it('composes a mixed primitive + named union into a valid expression', () => {
      const definition = ['string', 'Date', 'TypeOne'];
      expect(definition.map(typeAliasMemberGuard).join(' || ')).toBe("typeof item === 'string' || item instanceof Date || isTypeOne(item)");
   });
});
