/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, expect, it } from 'vitest';
import { AbstractAstReflection, type AstMetaData, type AstReflection } from '@hydranium/langium';
import { assertSingleLangiumCopy } from '../../src/langium/single-langium-copy.js';

/** Another installed copy's base class, under the name its bundle gave it, with the fields Langium's base creates. */
function otherCopyBase(name: string): new () => object {
   return {
      [name]: class {
         readonly types: AstMetaData = {};
         protected subtypes = {};
         protected allSubtypes = {};
      }
   }[name];
}

class OwnCopyReflection extends AbstractAstReflection {
   override readonly types: AstMetaData = { Element: { name: 'Element', properties: {}, superTypes: [] } };
}

describe('assertSingleLangiumCopy', () => {
   it('throws on a reflection built on another copy of langium, naming it and where its causes are listed', () => {
      class OtherCopyReflection extends otherCopyBase('AbstractAstReflection') {}

      expect(() => assertSingleLangiumCopy(new OtherCopyReflection() as unknown as AstReflection)).toThrow(
         /OtherCopyReflection.*another instance of `langium`.*a second physical copy or one install loaded twice.*npm explain langium.*troubleshooting\.md#startup-rejects-the-ast-reflection/s
      );
   });

   // The renames esbuild, rolldown and webpack give the second of two same-named classes, and a minifier's.
   it.each(['AbstractAstReflection2', 'AbstractAstReflection$1', 'a_AbstractAstReflection', 'e'])(
      'throws on another copy whose base a bundler or minifier named %s',
      name => {
         class RenamedReflection extends otherCopyBase(name) {}

         expect(() => assertSingleLangiumCopy(new RenamedReflection() as unknown as AstReflection)).toThrow(
            /RenamedReflection.*second physical copy/s
         );
      }
   );

   it("finds the fields it matches on in Langium's own base, so a Langium bump that renames them fails here", () => {
      expect(Object.keys(new OwnCopyReflection())).toEqual(expect.arrayContaining(['subtypes', 'allSubtypes']));
   });

   it('says a prototype-less reflection carrying the other copy fields has no constructor, rather than undefined', () => {
      const withoutPrototype = Object.assign(Object.create(null), { types: {}, subtypes: {}, allSubtypes: {} }) as AstReflection;

      expect(() => assertSingleLangiumCopy(withoutPrototype)).toThrow(/the shared AstReflection \(no constructor\)/);
   });

   it('accepts a reflection with no prototype rather than failing on its constructor', () => {
      expect(() => assertSingleLangiumCopy(Object.create(null) as AstReflection)).not.toThrow();
   });

   it('accepts a reflection built on the framework copy', () => {
      expect(() => assertSingleLangiumCopy(new OwnCopyReflection())).not.toThrow();
   });

   it('accepts a hand-written reflection that extends no base, which the slot allows', () => {
      expect(() => assertSingleLangiumCopy({ getAllTypes: () => [] } as unknown as AstReflection)).not.toThrow();
   });
});
