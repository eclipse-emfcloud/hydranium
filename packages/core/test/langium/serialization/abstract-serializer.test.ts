/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, expect, it } from 'vitest';
import type { AstReflection } from '@hydranium/langium';
import type { HydraniumLanguageServices } from '../../../src/langium/language-module.js';
import { JsonSerializer, type JsonSerializerOptions } from '../../../src/langium/serialization/json-serializer.js';
import { makeFakeReflection, makeNoopTracer } from '../../../src/testing/index.js';

/**
 * Tests for the shared, format-agnostic `AbstractSerializer` base dispatch
 * (`serializePropertyValue` order, `serializeReferenceText`, `shouldSkipProperty`,
 * `getOrderedPropertyNames`, the reference-wrapper collapse) — the half of the
 * serializer that is independent of any concrete output format. The base is
 * abstract, so the cases drive it through {@link JsonSerializer}, the simplest
 * concrete subclass with a fully predictable layout; the behaviour under test
 * lives entirely in the base class. Format-specific layout assertions live in
 * the sibling `json-serializer.test.ts` / `yaml-serializer.test.ts`.
 */

const noopLogger = { trace: () => undefined, for: () => noopLogger };

/** Test-only helper: split a flat `{ reflection, ...options }` config into the `(services, options)` constructor call. */
function buildJson<S extends JsonSerializer>(
   Ctor: new (services: HydraniumLanguageServices, options?: JsonSerializerOptions) => S,
   config: JsonSerializerOptions & { reflection: AstReflection }
): S {
   const { reflection, ...options } = config;
   const services = {
      shared: { AstReflection: reflection, Logger: noopLogger, Tracer: makeNoopTracer() }
   } as unknown as HydraniumLanguageServices;
   return new Ctor(services, options);
}

/** Exposes the protected {@link JsonSerializer.serializeReferenceText} so the reference-detection contract can be asserted directly. */
class RefTextProbe extends JsonSerializer {
   probe(value: unknown): string | undefined {
      return this.serializeReferenceText(value);
   }
}

describe('AbstractSerializer base dispatch', () => {
   describe('$-prefixed property keys', () => {
      it('skips $-prefixed keys even when listed in propertyOrder (Langium internals never serialize)', async () => {
         const serializer = buildJson(JsonSerializer, {
            reflection: makeFakeReflection({ TypeOne: {} }),
            // A `$`-prefixed entry would only ever appear in a hand-built order map; the
            // walker must still drop it. Guards the `key.startsWith('$')` early return.
            propertyOrder: new Map([['TypeOne', ['$internal', 'name']]]),
            referenceWrapperTypes: new Map()
         });
         const node = { $type: 'TypeOne', $internal: 'secret', name: 'Alice' };
         expect(await serializer.serializeAst(node as never)).toBe('{\n  "name": "Alice"\n}');
      });
   });

   describe('serializeReferenceText reference detection', () => {
      const serializer = buildJson(RefTextProbe, {
         reflection: makeFakeReflection({ Any: {} }),
         propertyOrder: new Map(),
         referenceWrapperTypes: new Map()
      });

      it('extracts $refText from a reference-shaped object', () => {
         expect(serializer.probe({ $refText: 'targetId' })).toBe('targetId');
      });

      it('returns undefined for null (no `in` probe against a non-object)', () => {
         // Pins the `value !== null` guard: dropping it makes `'$refText' in null` throw.
         expect(serializer.probe(null)).toBeUndefined();
      });

      it('returns a bare string verbatim — the transfer-mode reference shape', () => {
         // The `TransferEncoder` emits every cross-reference as a plain string id, so
         // rendering one is this method's transfer-mode half. It cannot tell a reference
         // id from a primitive string on its own and does not try: the caller guarantees
         // the value IS a reference (the walker via `isReferenceProperty`, a hand-written
         // emitter by construction). The gating test below is the other half of that
         // contract.
         expect(serializer.probe('targetId')).toBe('targetId');
      });

      it('returns undefined for a non-string primitive', () => {
         expect(serializer.probe(42)).toBeUndefined();
         expect(serializer.probe(true)).toBeUndefined();
      });

      it('returns undefined for an object without a $refText property', () => {
         expect(serializer.probe({ name: 'not a reference' })).toBeUndefined();
      });

      it('returns undefined when $refText is present but not a string', () => {
         // Pins the `typeof ... === 'string'` clause: a non-string $refText is not a reference.
         expect(serializer.probe({ $refText: 42 })).toBeUndefined();
      });

      it('renders a reference property in BOTH shapes identically', async () => {
         // The whole point of gating on reflection: one walker, one method, and an
         // AST-mode `Reference` and a transfer-mode plain id produce the same text.
         const bothShapes = buildJson(JsonSerializer, {
            reflection: makeFakeReflection({ TypeOne: { ref: { referenceType: 'TypeTwo' } } }),
            propertyOrder: new Map([['TypeOne', ['ref']]]),
            referenceWrapperTypes: new Map()
         });
         const astShape = { $type: 'TypeOne', ref: { $refText: 'Element' } };
         const transferShape = { $type: 'TypeOne', ref: 'Element' };
         const expected = '{\n  "ref": { "$ref": "Element" }\n}';
         expect(await bothShapes.serializeAst(astShape as never)).toBe(expected);
         expect(await bothShapes.serializeAst(transferShape as never)).toBe(expected);
      });

      it('does NOT treat a plain string property as a reference (reflection gates it)', async () => {
         // The safety property that lets `serializeReferenceText` accept bare strings.
         // `name` is not a declared reference, so it must format as a primitive — if the
         // walker inspected the value before consulting reflection, transfer-mode support
         // would turn every string property into an unquoted reference id.
         const gated = buildJson(JsonSerializer, {
            reflection: makeFakeReflection({ TypeTwo: { ref: { referenceType: 'TypeOne' }, name: {} } }),
            propertyOrder: new Map([['TypeTwo', ['name', 'ref']]]),
            referenceWrapperTypes: new Map()
         });
         // Two identical-looking strings take different paths, and JSON's `$ref` envelope
         // makes the split visible: `ref` is a declared reference, `name` is not.
         const node = { $type: 'TypeTwo', name: 'plain', ref: 'Element' };
         expect(await gated.serializeAst(node as never)).toBe('{\n  "name": "plain",\n  "ref": { "$ref": "Element" }\n}');
      });

      it('serializes a {$refText: <non-string>} value as a plain object, not a reference', async () => {
         const refSerializer = buildJson(JsonSerializer, {
            reflection: makeFakeReflection({ Holder: {} }),
            propertyOrder: new Map([['Holder', ['payload']]]),
            referenceWrapperTypes: new Map()
         });
         // `$refText: 42` must fall through to primitive formatting, proving the detector
         // requires BOTH the property to be present and its value to be a string.
         const node = { $type: 'Holder', payload: { $refText: 42 } };
         expect(await refSerializer.serializeAst(node as never)).toBe('{\n  "payload": {"$refText":42}\n}');
      });
   });

   describe('option fallbacks (all optional maps omitted)', () => {
      it('falls back to Object.keys order and tolerates an absent referenceWrapperTypes map', async () => {
         // No propertyOrder => Object.keys fallback; no referenceWrapperTypes => the
         // optional-chaining lookup on a nested node must not throw.
         const serializer = buildJson(JsonSerializer, { reflection: makeFakeReflection({ Outer: {}, Inner: {} }) });
         const node = { $type: 'Outer', inner: { $type: 'Inner', name: 'foo' } };
         expect(await serializer.serializeAst(node as never)).toBe('{\n  "inner": {\n    "name": "foo"\n  }\n}');
      });
   });

   describe('shouldSkipProperty', () => {
      it('omits an empty array entirely rather than emitting []', async () => {
         // JSON would render a non-skipped empty array as `[]`; asserting omission pins
         // the `Array.isArray(value) && value.length === 0` skip branch.
         const serializer = buildJson(JsonSerializer, {
            reflection: makeFakeReflection({ Bag: {} }),
            propertyOrder: new Map([['Bag', ['tags', 'name']]]),
            referenceWrapperTypes: new Map()
         });
         expect(await serializer.serializeAst({ $type: 'Bag', tags: [], name: 'x' } as never)).toBe('{\n  "name": "x"\n}');
      });
   });

   describe('reference wrapper types', () => {
      it('collapses a transfer-mode wrapper (plain string id) to the bare reference', async () => {
         // The wrapped value is a plain string (transfer shape), not a Reference object —
         // exercises the `typeof refValue === 'string'` arm of the wrapper collapse.
         const serializer = buildJson(JsonSerializer, {
            reflection: makeFakeReflection({ Outer: {}, RefWrap: {} }),
            propertyOrder: new Map([
               ['Outer', ['link']],
               ['RefWrap', ['value']]
            ]),
            referenceWrapperTypes: new Map([['RefWrap', 'value']])
         });
         const node = { $type: 'Outer', link: { $type: 'RefWrap', value: 'targetId' } };
         expect(await serializer.serializeAst(node as never)).toBe('{\n  "link": { "$ref": "targetId" }\n}');
      });

      it('serializes a wrapper carrying a second non-empty declared property as a normal node (no collapse)', async () => {
         // A collapse here would silently drop `extra` — the conditional collapse must
         // fall through to the regular nested-node path instead.
         const serializer = buildJson(JsonSerializer, {
            reflection: makeFakeReflection({ Outer: {}, RefWrap: { value: { referenceType: 'Target' }, extra: {} } }),
            propertyOrder: new Map([
               ['Outer', ['link']],
               ['RefWrap', ['value', 'extra']]
            ]),
            referenceWrapperTypes: new Map([['RefWrap', 'value']])
         });
         const node = { $type: 'Outer', link: { $type: 'RefWrap', value: 'targetId', extra: 'otherId' } };
         expect(await serializer.serializeAst(node as never)).toBe(
            '{\n  "link": {\n    "value": { "$ref": "targetId" },\n    "extra": "otherId"\n  }\n}'
         );
      });

      it('still collapses a wrapper whose extra declared properties are empty', async () => {
         // undefined, empty array, and blank-$refText reference all count as empty —
         // the wrapper keeps its collapsed single-id form.
         const serializer = buildJson(JsonSerializer, {
            reflection: makeFakeReflection({ Outer: {}, RefWrap: { value: {}, unset: {}, list: {}, blankRef: {} } }),
            propertyOrder: new Map([
               ['Outer', ['link']],
               ['RefWrap', ['value', 'unset', 'list', 'blankRef']]
            ]),
            referenceWrapperTypes: new Map([['RefWrap', 'value']])
         });
         const node = {
            $type: 'Outer',
            link: { $type: 'RefWrap', value: 'targetId', unset: undefined, list: [], blankRef: { $refText: '' } }
         };
         expect(await serializer.serializeAst(node as never)).toBe('{\n  "link": { "$ref": "targetId" }\n}');
      });

      it('collapses a wrapper carrying synthesized (undeclared) companion fields', async () => {
         // Transfer-model wrappers cross the wire with enumerable synthesized companions
         // (e.g. a display-label projection). Those are not grammar-declared, so they must
         // not count as "more" — only declared properties can veto the collapse. Scanning
         // the node's own keys instead would break every enriched wrapper round-trip.
         const serializer = buildJson(JsonSerializer, {
            reflection: makeFakeReflection({ Outer: {}, RefWrap: { value: { referenceType: 'Target' } } }),
            propertyOrder: new Map([['Outer', ['link']]]),
            referenceWrapperTypes: new Map([['RefWrap', 'value']])
         });
         const node = { $type: 'Outer', link: { $type: 'RefWrap', value: 'targetId', _valueDisplayName: 'Target Id' } };
         expect(await serializer.serializeAst(node as never)).toBe('{\n  "link": { "$ref": "targetId" }\n}');
      });

      it('serializes a wrapper whose wrapped value is neither a reference nor a string as a normal node', async () => {
         // Wrapped value is a number: both the reference and the string arm miss, so the
         // node serializes through the regular path. Pins the `propertyReference !== undefined`
         // guard (forcing it true would drop the property).
         const serializer = buildJson(JsonSerializer, {
            reflection: makeFakeReflection({ Outer: {}, RefWrap: {} }),
            propertyOrder: new Map([
               ['Outer', ['link']],
               ['RefWrap', ['value']]
            ]),
            referenceWrapperTypes: new Map([['RefWrap', 'value']])
         });
         const node = { $type: 'Outer', link: { $type: 'RefWrap', value: 42 } };
         expect(await serializer.serializeAst(node as never)).toBe('{\n  "link": {\n    "value": 42\n  }\n}');
      });
   });
});
