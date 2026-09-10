/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * The catalogue audit, over neutral-abstract codes.
 *
 * The helpers exist because the failure they find is invisible everywhere else:
 * a key naming no code falls back to the English, which is what a deliberately
 * partial catalogue also does.
 */

import { describe, expect, it } from 'vitest';
import { defineMessage } from '../../src/messages/primitives';
import { findSharedCodes, findUndeclaredCodes, flattenCatalogue } from '../../src/testing/catalogue-audit';

const THING_MISSING = defineMessage('hydranium/one/thing-missing', "No thing named '{name}'.");
const THING_STALE = defineMessage('hydranium/one/thing-stale', 'The thing is stale.');

/** A barrel, as `import * as messages` yields it: declarations beside functions. */
const BARREL = { THING_MISSING, THING_STALE, helper: () => 'not a declaration', VERSION: '1.0.0' };

describe('flattenCatalogue', () => {
   it("joins nested keys with '/', which is how a code is spelled", () => {
      // Theia flattens a nested catalogue exactly this way, on the same
      // separator the codes use — which is why a nested file and a flat one
      // describe the same key set.
      expect(flattenCatalogue({ hydranium: { one: { 'thing-missing': 'Kein Ding.' } } })).toEqual({
         'hydranium/one/thing-missing': 'Kein Ding.'
      });
   });

   it('keeps an already-flat catalogue as it is', () => {
      // The shape handed straight to a `ServerMessageRenderer`. Both forms reach
      // the audit, so neither may need a different call.
      expect(flattenCatalogue({ 'hydranium/one/thing-missing': 'Kein Ding.' })).toEqual({
         'hydranium/one/thing-missing': 'Kein Ding.'
      });
   });

   it('drops note keys by PREFIX, at every depth', () => {
      // By prefix rather than by one literal name, so a second note cannot
      // silently become an entry. A code is three `/`-separated segments, so no
      // real entry can begin with `_`.
      const flat = flattenCatalogue({
         _comment: 'what this file is',
         _note: 'a second note',
         hydranium: { _why: 'nested note', one: { 'thing-stale': 'Alt.' } }
      });

      expect(flat).toEqual({ 'hydranium/one/thing-stale': 'Alt.' });
   });

   it('ignores a value that is neither string nor object', () => {
      // A hand-edited catalogue can hold anything. Skipping rather than throwing
      // keeps the audit reporting the keys it CAN check.
      expect(flattenCatalogue({ a: 1, b: null, c: 'kept' } as unknown as Record<string, unknown>)).toEqual({ c: 'kept' });
   });
});

describe('findUndeclaredCodes', () => {
   it('reports nothing for a catalogue whose every key is declared', () => {
      expect(findUndeclaredCodes([THING_MISSING.code, THING_STALE.code], [BARREL])).toEqual([]);
   });

   it('names the orphan rather than counting it', () => {
      // The whole value of the helper: a count says something is wrong, the key
      // says what. A typo is the case, and it looks like a partial catalogue.
      expect(findUndeclaredCodes([THING_MISSING.code, 'hydranium/one/thing-mising'], [BARREL])).toEqual(['hydranium/one/thing-mising']);
   });

   it('accepts a PARTIAL catalogue, which is the shipped behaviour', () => {
      // Translating some codes and not others is what the framework promises; a
      // helper that flagged the gap would fail every honest adopter.
      expect(findUndeclaredCodes([THING_MISSING.code], [BARREL])).toEqual([]);
   });

   it('reads several barrels, since a catalogue spans framework and adopter codes', () => {
      const adopterBarrel = { OWN: defineMessage('adopter/area/own', 'Ours.') };

      expect(findUndeclaredCodes([THING_MISSING.code, 'adopter/area/own'], [BARREL, adopterBarrel])).toEqual([]);
      // And one barrel alone does NOT cover it — otherwise the multi-barrel
      // case above would pass against a helper that ignored the second.
      expect(findUndeclaredCodes([THING_MISSING.code, 'adopter/area/own'], [BARREL])).toEqual(['adopter/area/own']);
   });

   it('exempts a prefix for keys no barrel can declare', () => {
      // A host's own mechanism is the case: Theia's `nls.localize` takes its key
      // as an inline literal, so those keys exist only in source text.
      const keys = [THING_MISSING.code, 'hydranium/host/command-do-thing'];

      expect(findUndeclaredCodes(keys, [BARREL], { exemptPrefixes: ['hydranium/host/'] })).toEqual([]);
      // Unexempted, it is an orphan — which is what makes the exemption a
      // decision rather than a no-op.
      expect(findUndeclaredCodes(keys, [BARREL])).toEqual(['hydranium/host/command-do-thing']);
   });

   it('ignores the non-declaration exports a barrel also carries', () => {
      // `collectMessages` discriminates on `format`, so a `code` + `text` pair
      // alone is not enough. Asserted here because a helper that treated every
      // export as a declaration would silently accept any key.
      expect(findUndeclaredCodes(['1.0.0', 'helper'], [BARREL])).toEqual(['1.0.0', 'helper']);
   });
});

describe('findSharedCodes', () => {
   it('names a code two catalogues both hold', () => {
      // Two authorities over one sentence, which diverge on the first reword and
      // which nothing at runtime notices.
      expect(findSharedCodes([THING_MISSING.code, THING_STALE.code], [THING_STALE.code])).toEqual([THING_STALE.code]);
   });

   it('reports nothing for disjoint sets', () => {
      expect(findSharedCodes([THING_MISSING.code], [THING_STALE.code])).toEqual([]);
   });

   it('reports nothing when a set is EMPTY, which a caller has to guard', () => {
      // Documented as a limit rather than fixed here: emptiness is the shape a
      // failed read takes, and it satisfies a disjointness assertion while
      // proving nothing. The caller asserts non-emptiness.
      expect(findSharedCodes([], [THING_STALE.code])).toEqual([]);
      expect(findSharedCodes([THING_STALE.code], [])).toEqual([]);
   });
});
