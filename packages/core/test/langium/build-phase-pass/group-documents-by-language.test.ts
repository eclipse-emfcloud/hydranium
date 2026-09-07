/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, expect, it } from 'vitest';
import { URI, type LangiumDocument } from '@hydranium/langium';
import { groupDocumentsByLanguage } from '../../../src/langium/build-phase-pass/build-phase-pass.js';
import { makeStubServiceRegistry } from '../../../src/testing/index.js';

const doc = (name: string): LangiumDocument => ({ uri: URI.parse(`file:///${name}`) }) as unknown as LangiumDocument;

function twoLanguages(): { ServiceRegistry: ReturnType<typeof makeStubServiceRegistry> } {
   return {
      ServiceRegistry: makeStubServiceRegistry([
         { languageId: 'langA', fileExtensions: ['.a'] },
         { languageId: 'langB', fileExtensions: ['.b'] }
      ])
   };
}

describe('groupDocumentsByLanguage', () => {
   it('groups a mixed batch by owning language, preserving batch order within each group', () => {
      const services = twoLanguages();
      const [a1, b1, a2] = [doc('a1.a'), doc('b1.b'), doc('a2.a')];

      const grouped = [...groupDocumentsByLanguage(services, [a1, b1, a2])];

      expect(grouped.map(([language, group]) => [language.LanguageMetaData.languageId, group])).toEqual([
         ['langA', [a1, a2]],
         ['langB', [b1]]
      ]);
   });

   it('yields one group per language, not one per document', () => {
      // The mistake this helper exists to prevent is the opposite — running a
      // pass once over a mixed batch through ONE language's services. It must
      // also not swing to per-document, which would defeat a batch pass whose
      // whole point is cross-document ordering.
      const services = twoLanguages();
      const grouped = groupDocumentsByLanguage(services, [doc('a.a'), doc('b.a'), doc('c.a')]);
      expect(grouped.size).toBe(1);
      expect([...grouped.values()][0]).toHaveLength(3);
   });

   it('omits documents whose URI matches no registered language', () => {
      // A stray URI must not fail the whole build — a pass simply has no
      // language services to run over it.
      const services = twoLanguages();
      const known = doc('a.a');
      const grouped = groupDocumentsByLanguage(services, [known, doc('stray.unknown'), doc('directory')]);
      expect([...grouped.values()]).toEqual([[known]]);
   });

   it('returns an empty map for an empty batch', () => {
      expect(groupDocumentsByLanguage(twoLanguages(), []).size).toBe(0);
   });

   it('keys by the language services object, so a caller reaches its per-language slots', () => {
      const marker = { extendDocument: () => undefined };
      const services = {
         ServiceRegistry: makeStubServiceRegistry([
            { languageId: 'langA', fileExtensions: ['.a'], services: { ast: { AstExtensionService: marker } } },
            { languageId: 'langB', fileExtensions: ['.b'] }
         ])
      };
      const [language] = [...groupDocumentsByLanguage(services, [doc('a.a')]).keys()];
      expect(language?.ast.AstExtensionService).toBe(marker);
   });
});
