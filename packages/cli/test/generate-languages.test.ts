/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { Project, type SourceFile } from 'ts-morph';
import { describe, expect, it } from 'vitest';
import { buildLanguagesSource } from '../src/commands/generate-languages.js';

/**
 * Build an in-memory `module.ts` in the shape langium-cli emits. Only the
 * `<Grammar>LanguageMetaData` consts are read, so an excerpt exercises the same
 * paths as a real generated file.
 */
function moduleSource(text: string): SourceFile {
   return new Project({ useInMemoryFileSystem: true }).createSourceFile('/src/generated/module.ts', text);
}

const OPTIONS = { regenCommand: 'Run: npm run generate' };

const MULTI_GRAMMAR = `
   import type { LanguageMetaData } from 'langium';
   export const DomainLanguageMetaData = {
       languageId: 'order-flow-domain',
       fileExtensions: ['.domain'],
       caseInsensitive: false,
       mode: 'development'
   } as const satisfies LanguageMetaData;
   export const OrderLineLanguageMetaData = {
       languageId: 'order-flow-order-line',
       fileExtensions: ['.line', '.lines'],
       caseInsensitive: false,
       mode: 'development'
   } as const satisfies LanguageMetaData;
   export const OrderFlowGeneratedSharedModule = {};
`;

describe('buildLanguagesSource', () => {
   it('emits one object per grammar, named after the grammar declaration', () => {
      const source = buildLanguagesSource(moduleSource(MULTI_GRAMMAR), OPTIONS);
      expect(source).toContain('export const DOMAIN_LANGUAGE = { languageId: "order-flow-domain", fileExtensions: [".domain"] } as const;');
      expect(source).toContain(
         'export const ORDER_LINE_LANGUAGE = { languageId: "order-flow-order-line", fileExtensions: [".line", ".lines"] } as const;'
      );
   });

   it('lists every grammar in ALL_LANGUAGES, in declaration order', () => {
      const source = buildLanguagesSource(moduleSource(MULTI_GRAMMAR), OPTIONS);
      expect(source).toContain('export const ALL_LANGUAGES = [DOMAIN_LANGUAGE, ORDER_LINE_LANGUAGE] as const;');
   });

   it('writes ids and extensions as valid literals whatever they contain', () => {
      const quoted = `export const DomainLanguageMetaData = { languageId: "it's", fileExtensions: ['.a\\\\b'] } as const;`;
      const source = buildLanguagesSource(moduleSource(quoted), OPTIONS);
      expect(
         moduleSource(source)
            .getPreEmitDiagnostics()
            .map(diagnostic => diagnostic.getMessageText())
      ).toEqual([]);
      expect(source).toContain(`languageId: "it's"`);
      expect(source).toContain(`fileExtensions: [".a\\\\b"]`);
   });

   it('fails loudly when two grammars map to one constant name', () => {
      // `OrderLine` and `orderLine` are distinct grammars whose names split to
      // the same constant; emitting both would declare it twice.
      const colliding = `
         export const OrderLineLanguageMetaData = { languageId: 'a', fileExtensions: ['.a'] } as const;
         export const orderLineLanguageMetaData = { languageId: 'b', fileExtensions: ['.b'] } as const;
      `;
      expect(() => buildLanguagesSource(moduleSource(colliding), OPTIONS)).toThrow(/both map to 'ORDER_LINE_LANGUAGE'/);
   });

   it('fails loudly when the module declares no language metadata', () => {
      // A file that did not come from `langium generate` would otherwise yield
      // an empty ALL_LANGUAGES, and every host would silently register nothing.
      expect(() => buildLanguagesSource(moduleSource('export const Other = {};'), OPTIONS)).toThrow(/no '<Grammar>LanguageMetaData'/);
   });

   it('fails loudly when a metadata object lacks its language id', () => {
      const broken = "export const DomainLanguageMetaData = { fileExtensions: ['.domain'] } as const;";
      expect(() => buildLanguagesSource(moduleSource(broken), OPTIONS)).toThrow(/DomainLanguageMetaData.*languageId/);
   });

   it('carries the regen command into the generated header', () => {
      const source = buildLanguagesSource(moduleSource(MULTI_GRAMMAR), OPTIONS);
      expect(source).toContain('DO NOT EDIT MANUALLY!');
      expect(source).toContain('Run: npm run generate');
   });
});
