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

const noopLogger = { trace: () => undefined, for: () => noopLogger };

/** Test-only helper: split the legacy `{ reflection, ...options }` shape into the post-Phase-E.5.38 `(services, options)` call. */
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

describe('JsonSerializer', () => {
   describe('object layout', () => {
      it('emits properties in grammar-declared order with default 2-space indent', async () => {
         const serializer = buildJson(JsonSerializer, {
            reflection: makeFakeReflection({ Person: {} }),
            propertyOrder: new Map([['Person', ['name', 'age']]]),
            referenceWrapperTypes: new Map()
         });
         const node = { $type: 'Person', age: 30, name: 'Alice' };
         expect(await serializer.serializeAst(node as never)).toBe('{\n  "name": "Alice",\n  "age": 30\n}');
      });

      it('emits compact output when indent is false', async () => {
         const serializer = buildJson(JsonSerializer, {
            reflection: makeFakeReflection({ Person: {} }),
            propertyOrder: new Map([['Person', ['name', 'age']]]),
            referenceWrapperTypes: new Map(),
            indent: false
         });
         expect(await serializer.serializeAst({ $type: 'Person', name: 'Alice', age: 30 } as never)).toBe('{"name":"Alice","age":30}');
      });

      it('honours a custom numeric indent', async () => {
         const serializer = buildJson(JsonSerializer, {
            reflection: makeFakeReflection({ Person: {} }),
            propertyOrder: new Map([['Person', ['name']]]),
            referenceWrapperTypes: new Map(),
            indent: 4
         });
         expect(await serializer.serializeAst({ $type: 'Person', name: 'Alice' } as never)).toBe('{\n    "name": "Alice"\n}');
      });

      it('emits {} for a node with no serializable properties', async () => {
         const serializer = buildJson(JsonSerializer, {
            reflection: makeFakeReflection({ Empty: {} }),
            propertyOrder: new Map([['Empty', []]]),
            referenceWrapperTypes: new Map()
         });
         expect(await serializer.serializeAst({ $type: 'Empty' } as never)).toBe('{}');
      });
   });

   describe('default value skipping', () => {
      it('omits properties whose value equals the grammar-declared default', async () => {
         const serializer = buildJson(JsonSerializer, {
            reflection: makeFakeReflection({ Attr: { mandatory: { defaultValue: false } } }),
            propertyOrder: new Map([['Attr', ['name', 'mandatory']]]),
            referenceWrapperTypes: new Map()
         });
         expect(await serializer.serializeAst({ $type: 'Attr', name: 'foo', mandatory: false } as never)).toBe('{\n  "name": "foo"\n}');
      });
   });

   describe('reference encoding', () => {
      it('emits cross-references as object-wrappers by default', async () => {
         const serializer = buildJson(JsonSerializer, {
            reflection: makeFakeReflection({ Edge: { target: { referenceType: 'Node' } } }),
            propertyOrder: new Map([['Edge', ['target']]]),
            referenceWrapperTypes: new Map()
         });
         expect(await serializer.serializeAst({ $type: 'Edge', target: 'someId' } as never)).toBe('{\n  "target": { "$ref": "someId" }\n}');
      });

      it('emits cross-references as bare strings when configured', async () => {
         const serializer = buildJson(JsonSerializer, {
            reflection: makeFakeReflection({ Edge: { target: { referenceType: 'Node' } } }),
            propertyOrder: new Map([['Edge', ['target']]]),
            referenceWrapperTypes: new Map(),
            referenceEncoding: 'string'
         });
         expect(await serializer.serializeAst({ $type: 'Edge', target: 'someId' } as never)).toBe('{\n  "target": "someId"\n}');
      });

      it('compacts the object-wrapper form when indent is false', async () => {
         const serializer = buildJson(JsonSerializer, {
            reflection: makeFakeReflection({ Edge: { target: { referenceType: 'Node' } } }),
            propertyOrder: new Map([['Edge', ['target']]]),
            referenceWrapperTypes: new Map(),
            indent: false
         });
         expect(await serializer.serializeAst({ $type: 'Edge', target: 'someId' } as never)).toBe('{"target":{"$ref":"someId"}}');
      });

      it('extracts $refText from a Langium Reference object', async () => {
         const serializer = buildJson(JsonSerializer, {
            reflection: makeFakeReflection({ Edge: { target: { referenceType: 'Node' } } }),
            propertyOrder: new Map([['Edge', ['target']]]),
            referenceWrapperTypes: new Map()
         });
         const reference = { $refText: 'targetId', $refNode: undefined, ref: undefined, error: undefined };
         expect(await serializer.serializeAst({ $type: 'Edge', target: reference } as never)).toBe(
            '{\n  "target": { "$ref": "targetId" }\n}'
         );
      });
   });

   describe('arrays', () => {
      it('serializes a primitive array as a pretty JSON array', async () => {
         const serializer = buildJson(JsonSerializer, {
            reflection: makeFakeReflection({ Tags: {} }),
            propertyOrder: new Map([['Tags', ['names']]]),
            referenceWrapperTypes: new Map()
         });
         expect(await serializer.serializeAst({ $type: 'Tags', names: ['a', 'b', 'c'] } as never)).toBe(
            '{\n  "names": [\n    "a",\n    "b",\n    "c"\n  ]\n}'
         );
      });

      it('serializes a reference array as object-wrappers', async () => {
         const serializer = buildJson(JsonSerializer, {
            reflection: makeFakeReflection({ Group: { members: { referenceType: 'Person' } } }),
            propertyOrder: new Map([['Group', ['members']]]),
            referenceWrapperTypes: new Map()
         });
         expect(await serializer.serializeAst({ $type: 'Group', members: ['a', 'b'] } as never)).toBe(
            '{\n  "members": [\n    { "$ref": "a" },\n    { "$ref": "b" }\n  ]\n}'
         );
      });

      it('compacts arrays when indent is false', async () => {
         const serializer = buildJson(JsonSerializer, {
            reflection: makeFakeReflection({ Tags: {} }),
            propertyOrder: new Map([['Tags', ['names']]]),
            referenceWrapperTypes: new Map(),
            indent: false
         });
         expect(await serializer.serializeAst({ $type: 'Tags', names: ['a', 'b'] } as never)).toBe('{"names":["a","b"]}');
      });
   });

   describe('nested nodes', () => {
      it('recurses into nested AST nodes with increased indent', async () => {
         const serializer = buildJson(JsonSerializer, {
            reflection: makeFakeReflection({ Outer: {}, Inner: {} }),
            propertyOrder: new Map([
               ['Outer', ['inner']],
               ['Inner', ['name']]
            ]),
            referenceWrapperTypes: new Map()
         });
         const input = { $type: 'Outer', inner: { $type: 'Inner', name: 'foo' } };
         expect(await serializer.serializeAst(input as never)).toBe('{\n  "inner": {\n    "name": "foo"\n  }\n}');
      });
   });

   describe('id property formatting via serializeCustomValue', () => {
      class CustomSerializer extends JsonSerializer {
         protected override serializeCustomValue(
            nodeType: string,
            key: string,
            value: unknown,
            indentationLevel: number
         ): string | undefined {
            if (key === 'id' && typeof value === 'string') {
               return JSON.stringify(value.toUpperCase());
            }
            return super.serializeCustomValue(nodeType, key, value, indentationLevel) as string | undefined;
         }
      }

      it('lets an adopter route the `id` property through serializeCustomValue', async () => {
         const serializer = buildJson(CustomSerializer, {
            reflection: makeFakeReflection({ Thing: {} }),
            propertyOrder: new Map([['Thing', ['id', 'name']]]),
            referenceWrapperTypes: new Map()
         });
         expect(await serializer.serializeAst({ $type: 'Thing', id: 'foo', name: 'Foo' } as never)).toBe(
            '{\n  "id": "FOO",\n  "name": "Foo"\n}'
         );
      });
   });

   describe('reference wrapper types', () => {
      it('collapses a wrapper node to just the wrapped reference id', async () => {
         const serializer = buildJson(JsonSerializer, {
            reflection: makeFakeReflection({ Outer: {}, RefWrap: {} }),
            propertyOrder: new Map([
               ['Outer', ['link']],
               ['RefWrap', ['value']]
            ]),
            referenceWrapperTypes: new Map([['RefWrap', 'value']])
         });
         const reference = { $refText: 'targetId', $refNode: undefined, ref: undefined, error: undefined };
         const input = { $type: 'Outer', link: { $type: 'RefWrap', value: reference } };
         expect(await serializer.serializeAst(input as never)).toBe('{\n  "link": { "$ref": "targetId" }\n}');
      });
   });

   describe('serializeCustomValue extension point', () => {
      class WithCustomHandler extends JsonSerializer {
         protected override serializeCustomValue(_type: string, _key: string, value: unknown): string | undefined {
            if (typeof value === 'object' && value !== null && (value as { $type?: string }).$type === 'Inline') {
               return JSON.stringify(`<<inline:${(value as { token: string }).token}>>`);
            }
            return undefined;
         }
      }

      it('lets a subclass intercept type-specific serialization', async () => {
         const serializer = buildJson(WithCustomHandler, {
            reflection: makeFakeReflection({ Container: {}, Inline: {} }),
            propertyOrder: new Map([
               ['Container', ['inner']],
               ['Inline', ['token']]
            ]),
            referenceWrapperTypes: new Map()
         });
         const input = { $type: 'Container', inner: { $type: 'Inline', token: 'hello' } };
         expect(await serializer.serializeAst(input as never)).toBe('{\n  "inner": "<<inline:hello>>"\n}');
      });
   });

   describe('async hooks', () => {
      class AsyncPrimitive extends JsonSerializer {
         protected override formatPrimitive(value: unknown): Promise<string> {
            return Promise.resolve(JSON.stringify(value));
         }
      }

      it('awaits an async adopter override and resolves to the expected text', async () => {
         const serializer = buildJson(AsyncPrimitive, {
            reflection: makeFakeReflection({ Person: {} }),
            propertyOrder: new Map([['Person', ['name', 'age']]]),
            referenceWrapperTypes: new Map()
         });
         const result = await serializer.serializeAst({ $type: 'Person', name: 'Alice', age: 30 } as never);
         expect(result).toBe('{\n  "name": "Alice",\n  "age": 30\n}');
      });
   });

   describe('indent styles', () => {
      it('uses a tab per level when indent is "tab"', async () => {
         const serializer = buildJson(JsonSerializer, {
            reflection: makeFakeReflection({ Outer: {}, Inner: {} }),
            propertyOrder: new Map([
               ['Outer', ['inner']],
               ['Inner', ['name']]
            ]),
            referenceWrapperTypes: new Map(),
            indent: 'tab'
         });
         const node = { $type: 'Outer', inner: { $type: 'Inner', name: 'foo' } };
         expect(await serializer.serializeAst(node as never)).toBe('{\n\t"inner": {\n\t\t"name": "foo"\n\t}\n}');
      });
   });

   describe('reference array element handling', () => {
      it('formats Reference-object and string ids and drops non-reference elements', async () => {
         const serializer = buildJson(JsonSerializer, {
            reflection: makeFakeReflection({ Group: { members: { referenceType: 'Person' } } }),
            propertyOrder: new Map([['Group', ['members']]]),
            referenceWrapperTypes: new Map()
         });
         // A Langium Reference object resolves via $refText; a bare string formats directly;
         // a non-reference value (number) is dropped. Pins the three reference-array arms.
         const reference = { $refText: 'a', $refNode: undefined, ref: undefined, error: undefined };
         const node = { $type: 'Group', members: [reference, 'b', 5] };
         expect(await serializer.serializeAst(node as never)).toBe('{\n  "members": [\n    { "$ref": "a" },\n    { "$ref": "b" }\n  ]\n}');
      });
   });

   describe('array with holes', () => {
      it('renders [] when every element is undefined', async () => {
         const serializer = buildJson(JsonSerializer, {
            reflection: makeFakeReflection({ Tags: {} }),
            propertyOrder: new Map([['Tags', ['names']]]),
            referenceWrapperTypes: new Map()
         });
         // A non-empty array of holes is not skipped by shouldSkipProperty, so it reaches
         // composeArray with zero collected elements — the `[]` short-circuit.
         const node = { $type: 'Tags', names: [undefined, undefined] };
         expect(await serializer.serializeAst(node as never)).toBe('{\n  "names": []\n}');
      });

      it('indents nested objects within an array one level deeper than the array', async () => {
         const serializer = buildJson(JsonSerializer, {
            reflection: makeFakeReflection({ Doc: {}, O: {} }),
            propertyOrder: new Map([
               ['Doc', ['items']],
               ['O', ['x']]
            ]),
            referenceWrapperTypes: new Map()
         });
         // Pins the array-element indentationLevel bump: each object body must sit two
         // levels in, not at the array's level.
         const node = {
            $type: 'Doc',
            items: [
               { $type: 'O', x: 1 },
               { $type: 'O', x: 2 }
            ]
         };
         expect(await serializer.serializeAst(node as never)).toBe(
            '{\n  "items": [\n    {\n      "x": 1\n    },\n    {\n      "x": 2\n    }\n  ]\n}'
         );
      });
   });

   describe('values that serialize to undefined', () => {
      it('omits a property whose value JSON.stringify drops', async () => {
         const serializer = buildJson(JsonSerializer, {
            reflection: makeFakeReflection({ P: {} }),
            propertyOrder: new Map([['P', ['name', 'fn']]]),
            referenceWrapperTypes: new Map()
         });
         // A function stringifies to `undefined`; the entry must be dropped, not pushed.
         const node = { $type: 'P', name: 'Alice', fn: () => 0 };
         expect(await serializer.serializeAst(node as never)).toBe('{\n  "name": "Alice"\n}');
      });
   });

   describe('async element handling', () => {
      class AsyncPrimitive extends JsonSerializer {
         protected override formatPrimitive(value: unknown): Promise<string> {
            return Promise.resolve(JSON.stringify(value) as string);
         }
      }
      class AsyncReference extends JsonSerializer {
         protected override formatReferenceValue(value: string): Promise<string> {
            return Promise.resolve(super.formatReferenceValue(value) as string);
         }
      }

      it('awaits async element formatting across a primitive array', async () => {
         const serializer = buildJson(AsyncPrimitive, {
            reflection: makeFakeReflection({ Tags: {} }),
            propertyOrder: new Map([['Tags', ['names']]]),
            referenceWrapperTypes: new Map()
         });
         expect(await serializer.serializeAst({ $type: 'Tags', names: ['a', 'b', 'c'] } as never)).toBe(
            '{\n  "names": [\n    "a",\n    "b",\n    "c"\n  ]\n}'
         );
      });

      it('awaits async reference formatting across a reference array', async () => {
         const serializer = buildJson(AsyncReference, {
            reflection: makeFakeReflection({ Group: { members: { referenceType: 'Person' } } }),
            propertyOrder: new Map([['Group', ['members']]]),
            referenceWrapperTypes: new Map()
         });
         expect(await serializer.serializeAst({ $type: 'Group', members: ['a', 'b'] } as never)).toBe(
            '{\n  "members": [\n    { "$ref": "a" },\n    { "$ref": "b" }\n  ]\n}'
         );
      });

      it('drops a property whose async value resolves to undefined', async () => {
         const serializer = buildJson(AsyncPrimitive, {
            reflection: makeFakeReflection({ P: {} }),
            propertyOrder: new Map([['P', ['name', 'fn']]]),
            referenceWrapperTypes: new Map()
         });
         // The async formatter resolves the function to `undefined`; the resumed async
         // tail must not push the dropped entry.
         const node = { $type: 'P', name: 'Alice', fn: () => 0 };
         expect(await serializer.serializeAst(node as never)).toBe('{\n  "name": "Alice"\n}');
      });
   });
});
