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
import { YamlSerializer, type YamlSerializerOptions } from '../../../src/langium/serialization/yaml-serializer.js';
import { makeFakeReflection, makeNoopTracer } from '../../../src/testing/index.js';

const noopLogger = { trace: () => undefined, for: () => noopLogger };

/** Test-only helper: split the legacy `{ reflection, ...options }` shape into the post-Phase-E.5.38 `(services, options)` call. */
function buildYaml<S extends YamlSerializer>(
   Ctor: new (services: HydraniumLanguageServices, options?: YamlSerializerOptions) => S,
   config: YamlSerializerOptions & { reflection: AstReflection }
): S {
   const { reflection, ...options } = config;
   const services = {
      shared: { AstReflection: reflection, Logger: noopLogger, Tracer: makeNoopTracer() }
   } as unknown as HydraniumLanguageServices;
   return new Ctor(services, options);
}

describe('YamlSerializer', () => {
   describe('property order', () => {
      it('serializes properties in the configured grammar order, not key-insertion order', async () => {
         const serializer = buildYaml(YamlSerializer, {
            reflection: makeFakeReflection({ Person: {} }),
            propertyOrder: new Map([['Person', ['name', 'age']]]),
            unquotedProperties: new Set(),
            inlineSerializedTypes: new Set(),
            referenceWrapperTypes: new Map()
         });

         // Object built with reverse insertion order
         const node = { $type: 'Person', age: 30, name: 'Alice' };
         expect(await serializer.serializeAst(node as never)).toBe('name: "Alice"\nage: 30');
      });

      it('skips properties not declared in propertyOrder', async () => {
         const serializer = buildYaml(YamlSerializer, {
            reflection: makeFakeReflection({ Person: {} }),
            propertyOrder: new Map([['Person', ['name']]]),
            unquotedProperties: new Set(),
            inlineSerializedTypes: new Set(),
            referenceWrapperTypes: new Map()
         });

         expect(await serializer.serializeAst({ $type: 'Person', name: 'Bob', age: 99 } as never)).toBe('name: "Bob"');
      });
   });

   describe('default value skipping', () => {
      it('omits properties whose value equals the grammar-declared default', async () => {
         const serializer = buildYaml(YamlSerializer, {
            reflection: makeFakeReflection({ Attr: { mandatory: { defaultValue: false } } }),
            propertyOrder: new Map([['Attr', ['name', 'mandatory']]]),
            unquotedProperties: new Set(),
            inlineSerializedTypes: new Set(),
            referenceWrapperTypes: new Map()
         });

         expect(await serializer.serializeAst({ $type: 'Attr', name: 'foo', mandatory: false } as never)).toBe('name: "foo"');
      });

      it('keeps properties whose value differs from the default', async () => {
         const serializer = buildYaml(YamlSerializer, {
            reflection: makeFakeReflection({ Attr: { mandatory: { defaultValue: false } } }),
            propertyOrder: new Map([['Attr', ['name', 'mandatory']]]),
            unquotedProperties: new Set(),
            inlineSerializedTypes: new Set(),
            referenceWrapperTypes: new Map()
         });

         expect(await serializer.serializeAst({ $type: 'Attr', name: 'foo', mandatory: true } as never)).toBe(
            'name: "foo"\nmandatory: true'
         );
      });
   });

   describe('skipped values', () => {
      it.each([
         ['undefined', { $type: 'P', name: 'X', other: undefined }, 'name: "X"'],
         ['null', { $type: 'P', name: 'X', other: null }, 'name: "X"'],
         ['empty array', { $type: 'P', name: 'X', other: [] }, 'name: "X"'],
         ['empty/whitespace string', { $type: 'P', name: 'X', other: '   ' }, 'name: "X"']
      ])('skips %s values', async (_label, input, expected) => {
         const serializer = buildYaml(YamlSerializer, {
            reflection: makeFakeReflection({ P: {} }),
            propertyOrder: new Map([['P', ['name', 'other']]]),
            unquotedProperties: new Set(),
            inlineSerializedTypes: new Set(),
            referenceWrapperTypes: new Map()
         });

         expect(await serializer.serializeAst(input as never)).toBe(expected);
      });
   });

   describe('reference properties', () => {
      it('formats a transfer-model string reference via formatReferenceValue', async () => {
         const serializer = buildYaml(YamlSerializer, {
            reflection: makeFakeReflection({ Edge: { target: { referenceType: 'Node' } } }),
            propertyOrder: new Map([['Edge', ['target']]]),
            unquotedProperties: new Set(),
            inlineSerializedTypes: new Set(),
            referenceWrapperTypes: new Map()
         });

         expect(await serializer.serializeAst({ $type: 'Edge', target: 'someId' } as never)).toBe('target: "someId"');
      });

      it('formats a Langium Reference object via $refText', async () => {
         const serializer = buildYaml(YamlSerializer, {
            reflection: makeFakeReflection({ Edge: { target: { referenceType: 'Node' } } }),
            propertyOrder: new Map([['Edge', ['target']]]),
            unquotedProperties: new Set(),
            inlineSerializedTypes: new Set(),
            referenceWrapperTypes: new Map()
         });

         // Mimic Langium Reference shape — must include `$refNode` and `error` to satisfy isReference.
         const reference = { $refText: 'targetId', $refNode: undefined, ref: undefined, error: undefined };
         expect(await serializer.serializeAst({ $type: 'Edge', target: reference } as never)).toBe('target: "targetId"');
      });

      it('formats Reference-object and string ids in a reference array and drops non-reference elements', async () => {
         const serializer = buildYaml(YamlSerializer, {
            reflection: makeFakeReflection({ Group: { members: { referenceType: 'Person' } } }),
            propertyOrder: new Map([['Group', ['members']]]),
            unquotedProperties: new Set(),
            inlineSerializedTypes: new Set(),
            referenceWrapperTypes: new Map()
         });

         // A Langium Reference resolves via $refText; a bare string formats directly; a
         // non-reference value (number) is dropped. Pins the three reference-array arms.
         const reference = { $refText: 'a', $refNode: undefined, ref: undefined, error: undefined };
         const node = { $type: 'Group', members: [reference, 'b', 5] };
         expect(await serializer.serializeAst(node as never)).toBe('members:\n  - "a"\n  - "b"');
      });
   });

   describe('unquoted properties', () => {
      it('emits unquoted enum-like values without JSON.stringify', async () => {
         const serializer = buildYaml(YamlSerializer, {
            reflection: makeFakeReflection({ Card: {} }),
            propertyOrder: new Map([['Card', ['kind']]]),
            unquotedProperties: new Set(['Card.kind']),
            inlineSerializedTypes: new Set(),
            referenceWrapperTypes: new Map()
         });

         expect(await serializer.serializeAst({ $type: 'Card', kind: 'one-to-many' } as never)).toBe('kind: one-to-many');
      });
   });

   describe('block scalar properties', () => {
      it('serializes a multi-line value for a qualified path as a block scalar', async () => {
         const serializer = buildYaml(YamlSerializer, {
            reflection: makeFakeReflection({ TypeTwo: {} }),
            propertyOrder: new Map([['TypeTwo', ['expression']]]),
            unquotedProperties: new Set(),
            inlineSerializedTypes: new Set(),
            referenceWrapperTypes: new Map(),
            blockScalarProperties: new Set(['TypeTwo.expression'])
         });

         expect(await serializer.serializeAst({ $type: 'TypeTwo', expression: 'a\nb' } as never)).toBe('expression: |\n  a\n  b');
      });

      it('keeps a single-line value for a block-scalar property quoted', async () => {
         const serializer = buildYaml(YamlSerializer, {
            reflection: makeFakeReflection({ TypeTwo: {} }),
            propertyOrder: new Map([['TypeTwo', ['expression']]]),
            unquotedProperties: new Set(),
            inlineSerializedTypes: new Set(),
            referenceWrapperTypes: new Map(),
            blockScalarProperties: new Set(['TypeTwo.expression'])
         });

         expect(await serializer.serializeAst({ $type: 'TypeTwo', expression: 'a' } as never)).toBe('expression: "a"');
      });

      it('matches a bare property name against that property on any node type', async () => {
         const serializer = buildYaml(YamlSerializer, {
            reflection: makeFakeReflection({ TypeOne: {}, TypeTwo: {} }),
            propertyOrder: new Map([
               ['TypeOne', ['description']],
               ['TypeTwo', ['description']]
            ]),
            unquotedProperties: new Set(),
            inlineSerializedTypes: new Set(),
            referenceWrapperTypes: new Map(),
            blockScalarProperties: new Set(['description'])
         });

         expect(await serializer.serializeAst({ $type: 'TypeOne', description: 'a\nb' } as never)).toBe('description: |\n  a\n  b');
         expect(await serializer.serializeAst({ $type: 'TypeTwo', description: 'c\nd' } as never)).toBe('description: |\n  c\n  d');
      });

      it('leaves a multi-line value quoted when neither qualified nor bare name is listed', async () => {
         const serializer = buildYaml(YamlSerializer, {
            reflection: makeFakeReflection({ TypeOne: {} }),
            propertyOrder: new Map([['TypeOne', ['note']]]),
            unquotedProperties: new Set(),
            inlineSerializedTypes: new Set(),
            referenceWrapperTypes: new Map(),
            blockScalarProperties: new Set(['description'])
         });

         expect(await serializer.serializeAst({ $type: 'TypeOne', note: 'a\nb' } as never)).toBe('note: "a\\nb"');
      });
   });

   describe('id property formatting via serializeCustomValue', () => {
      class CustomSerializer extends YamlSerializer {
         protected override serializeCustomValue(
            nodeType: string,
            key: string,
            value: unknown,
            indentationLevel: number
         ): string | undefined {
            if (key === 'id' && typeof value === 'string') {
               return value; // emit the id raw — adopter-specific id convention
            }
            return super.serializeCustomValue(nodeType, key, value, indentationLevel) as string | undefined;
         }
      }

      it('lets an adopter route the `id` property through serializeCustomValue', async () => {
         const serializer = buildYaml(CustomSerializer, {
            reflection: makeFakeReflection({ Thing: {} }),
            propertyOrder: new Map([['Thing', ['id', 'name']]]),
            unquotedProperties: new Set(),
            inlineSerializedTypes: new Set(),
            referenceWrapperTypes: new Map()
         });

         expect(await serializer.serializeAst({ $type: 'Thing', id: 'foo', name: 'Foo' } as never)).toBe('id: foo\nname: "Foo"');
      });
   });

   describe('typeSpecificKeywords option', () => {
      it('default behaviour (no map provided) uses the property name unchanged', async () => {
         const serializer = buildYaml(YamlSerializer, {
            reflection: makeFakeReflection({ Root: {}, Thing: {} }),
            propertyOrder: new Map([
               ['Root', ['objectDefinition']],
               ['Thing', ['id']]
            ]),
            unquotedProperties: new Set(),
            inlineSerializedTypes: new Set(),
            referenceWrapperTypes: new Map()
         });

         const out = await serializer.serializeAst({
            $type: 'Root',
            objectDefinition: { $type: 'Thing', id: 'X' }
         } as never);
         expect(out).toBe('objectDefinition:\n  id: "X"');
      });

      it('dispatches keyword by value $type when a map entry matches', async () => {
         const serializer = buildYaml(YamlSerializer, {
            reflection: makeFakeReflection({ Root: {}, TypeOneDefinition: {}, TypeTwoDefinition: {} }),
            propertyOrder: new Map([
               ['Root', ['objectDefinition']],
               ['TypeOneDefinition', ['id']],
               ['TypeTwoDefinition', ['id']]
            ]),
            unquotedProperties: new Set(),
            inlineSerializedTypes: new Set(),
            referenceWrapperTypes: new Map(),
            typeSpecificKeywords: new Map([
               ['objectDefinition.TypeOneDefinition', 'typeOneDefinition'],
               ['objectDefinition.TypeTwoDefinition', 'typeTwoDefinition']
            ])
         });

         const typeOneRoot = await serializer.serializeAst({
            $type: 'Root',
            objectDefinition: { $type: 'TypeOneDefinition', id: 'Element' }
         } as never);
         expect(typeOneRoot).toBe('typeOneDefinition:\n  id: "Element"');

         const typeTwoRoot = await serializer.serializeAst({
            $type: 'Root',
            objectDefinition: { $type: 'TypeTwoDefinition', id: 'email' }
         } as never);
         expect(typeTwoRoot).toBe('typeTwoDefinition:\n  id: "email"');
      });

      it('falls back to the property name when the $type has no map entry', async () => {
         const serializer = buildYaml(YamlSerializer, {
            reflection: makeFakeReflection({ Root: {}, KnownDef: {}, UnknownDef: {} }),
            propertyOrder: new Map([
               ['Root', ['objectDefinition']],
               ['KnownDef', ['id']],
               ['UnknownDef', ['id']]
            ]),
            unquotedProperties: new Set(),
            inlineSerializedTypes: new Set(),
            referenceWrapperTypes: new Map(),
            typeSpecificKeywords: new Map([['objectDefinition.KnownDef', 'knownDef']])
         });

         const unknown = await serializer.serializeAst({
            $type: 'Root',
            objectDefinition: { $type: 'UnknownDef', id: 'X' }
         } as never);
         expect(unknown).toBe('objectDefinition:\n  id: "X"');
      });

      it('does not consult the map for non-AstNode values (primitives)', async () => {
         const serializer = buildYaml(YamlSerializer, {
            reflection: makeFakeReflection({ Thing: {} }),
            propertyOrder: new Map([['Thing', ['id', 'name']]]),
            unquotedProperties: new Set(),
            inlineSerializedTypes: new Set(),
            referenceWrapperTypes: new Map(),
            // Even if a stray entry collides, primitives shouldn't dispatch.
            typeSpecificKeywords: new Map([['id.foo', 'identifier']])
         });

         const out = await serializer.serializeAst({ $type: 'Thing', id: 'foo', name: 'Foo' } as never);
         expect(out).toBe('id: "foo"\nname: "Foo"');
      });

      it('lets adopters subclass and override getPropertyKeyword for procedural logic', async () => {
         class LowercaseFirstLetterSerializer extends YamlSerializer {
            protected override getPropertyKeyword(prop: string, valueType?: string): string {
               if (prop === 'objectDefinition' && valueType?.endsWith('Definition')) {
                  return valueType.charAt(0).toLowerCase() + valueType.slice(1);
               }
               return super.getPropertyKeyword(prop, valueType);
            }
         }
         const serializer = buildYaml(LowercaseFirstLetterSerializer, {
            reflection: makeFakeReflection({ Root: {}, TypeOneDefinition: {}, TypeThreeDefinition: {} }),
            propertyOrder: new Map([
               ['Root', ['objectDefinition']],
               ['TypeOneDefinition', ['id']],
               ['TypeThreeDefinition', ['id']]
            ]),
            unquotedProperties: new Set(),
            inlineSerializedTypes: new Set(),
            referenceWrapperTypes: new Map()
            // No typeSpecificKeywords option — adopter routes through method override.
         });

         const typeOneRoot = await serializer.serializeAst({
            $type: 'Root',
            objectDefinition: { $type: 'TypeOneDefinition', id: 'Element' }
         } as never);
         expect(typeOneRoot).toBe('typeOneDefinition:\n  id: "Element"');

         const typeThreeRoot = await serializer.serializeAst({
            $type: 'Root',
            objectDefinition: { $type: 'TypeThreeDefinition', id: 'Third' }
         } as never);
         expect(typeThreeRoot).toBe('typeThreeDefinition:\n  id: "Third"');
      });
   });

   describe('serializeCustomValue extension point', () => {
      class WithCustomHandler extends YamlSerializer {
         protected override serializeCustomValue(_type: string, _key: string, value: unknown): string | undefined {
            if (typeof value === 'object' && value !== null && (value as { $type?: string }).$type === 'Inline') {
               return `<<inline:${(value as { token: string }).token}>>`;
            }
            return undefined;
         }
      }

      it('lets a subclass intercept type-specific serialization', async () => {
         const serializer = buildYaml(WithCustomHandler, {
            reflection: makeFakeReflection({ Container: {}, Inline: {} }),
            propertyOrder: new Map([
               ['Container', ['inner']],
               ['Inline', ['token']]
            ]),
            unquotedProperties: new Set(),
            inlineSerializedTypes: new Set(['Inline']),
            referenceWrapperTypes: new Map()
         });

         const input = { $type: 'Container', inner: { $type: 'Inline', token: 'hello' } };
         expect(await serializer.serializeAst(input as never)).toBe('inner: <<inline:hello>>');
      });

      it('falls through to default handling when serializeCustomValue returns undefined', async () => {
         const serializer = buildYaml(WithCustomHandler, {
            reflection: makeFakeReflection({ Plain: {} }),
            propertyOrder: new Map([['Plain', ['name']]]),
            unquotedProperties: new Set(),
            inlineSerializedTypes: new Set(),
            referenceWrapperTypes: new Map()
         });

         expect(await serializer.serializeAst({ $type: 'Plain', name: 'X' } as never)).toBe('name: "X"');
      });
   });

   describe('reference detection precedes serializeCustomValue', () => {
      class RecordingSerializer extends YamlSerializer {
         readonly seen: unknown[] = [];
         protected override serializeCustomValue(
            nodeType: string,
            key: string,
            value: unknown,
            indentationLevel: number
         ): string | undefined {
            this.seen.push(value);
            return super.serializeCustomValue(nodeType, key, value, indentationLevel) as string | undefined;
         }
      }

      it('does not pass Langium Reference objects to serializeCustomValue (reorder routes references first)', async () => {
         const serializer = buildYaml(RecordingSerializer, {
            reflection: makeFakeReflection({ Edge: { target: { referenceType: 'Node' } } }),
            propertyOrder: new Map([['Edge', ['target', 'label']]]),
            unquotedProperties: new Set(),
            inlineSerializedTypes: new Set(),
            referenceWrapperTypes: new Map()
         });

         const reference = { $refText: 'targetId', $refNode: undefined, ref: undefined, error: undefined };
         const result = await serializer.serializeAst({ $type: 'Edge', target: reference, label: 'plain' } as never);

         // The reference still serialized through formatReferenceValue.
         expect(result).toBe('target: "targetId"\nlabel: "plain"');
         // The custom hook saw the plain `label` value but never the Reference object.
         expect(serializer.seen).toContain('plain');
         expect(serializer.seen).not.toContain(reference);
      });
   });

   describe('reference wrapper types', () => {
      it('emits a wrapper node as just the wrapped reference id', async () => {
         const serializer = buildYaml(YamlSerializer, {
            reflection: makeFakeReflection({ Outer: {}, RefWrap: {} }),
            propertyOrder: new Map([
               ['Outer', ['link']],
               ['RefWrap', ['value']]
            ]),
            unquotedProperties: new Set(),
            inlineSerializedTypes: new Set(['RefWrap']),
            referenceWrapperTypes: new Map([['RefWrap', 'value']])
         });

         const reference = { $refText: 'targetId', $refNode: undefined, ref: undefined, error: undefined };
         const input = { $type: 'Outer', link: { $type: 'RefWrap', value: reference } };
         expect(await serializer.serializeAst(input as never)).toBe('link: "targetId"');
      });
   });

   describe('arrays', () => {
      it('serializes a string-reference array as YAML list items', async () => {
         const serializer = buildYaml(YamlSerializer, {
            reflection: makeFakeReflection({ Group: { members: { referenceType: 'Person' } } }),
            propertyOrder: new Map([['Group', ['members']]]),
            unquotedProperties: new Set(),
            inlineSerializedTypes: new Set(),
            referenceWrapperTypes: new Map()
         });

         const result = await serializer.serializeAst({ $type: 'Group', members: ['a', 'b', 'c'] } as never);
         expect(result).toBe('members:\n  - "a"\n  - "b"\n  - "c"');
      });
   });

   describe('async hooks', () => {
      class AsyncPrimitive extends YamlSerializer {
         protected override formatPrimitive(value: unknown): Promise<string> {
            // Simulate an async formatter override: a real adopter might consult
            // a remote schema or run a third-party async formatter.
            return Promise.resolve(JSON.stringify(value));
         }
      }

      it('awaits an async adopter override and resolves to the expected text', async () => {
         const serializer = buildYaml(AsyncPrimitive, {
            reflection: makeFakeReflection({ Person: {} }),
            propertyOrder: new Map([['Person', ['name', 'age']]]),
            unquotedProperties: new Set(),
            inlineSerializedTypes: new Set(),
            referenceWrapperTypes: new Map()
         });

         const result = await serializer.serializeAst({ $type: 'Person', name: 'Alice', age: 30 } as never);
         expect(result).toBe('name: "Alice"\nage: 30');
      });
   });

   describe('serializeTransfer default delegation', () => {
      it('delegates to serializeAst — same output for structurally equivalent input', async () => {
         const serializer = buildYaml(YamlSerializer, {
            reflection: makeFakeReflection({ Person: {} }),
            propertyOrder: new Map([['Person', ['name', 'age']]]),
            unquotedProperties: new Set(),
            inlineSerializedTypes: new Set(),
            referenceWrapperTypes: new Map()
         });

         // Transfer-shape: { readonly $type: string } — structurally compatible
         // with the walker. Default serializeTransfer delegates back to
         // serializeAst, so output matches the AST-shape call.
         const transferShape = { $type: 'Person', name: 'Alice', age: 30 } as never;
         const ast = await serializer.serializeAst(transferShape);
         const transfer = await serializer.serializeTransfer(transferShape);
         expect(transfer).toBe(ast);
         expect(transfer).toBe('name: "Alice"\nage: 30');
      });
   });

   describe('non-reference arrays', () => {
      it('serializes a primitive array as block list items', async () => {
         const serializer = buildYaml(YamlSerializer, {
            reflection: makeFakeReflection({ List: {} }),
            propertyOrder: new Map([['List', ['items']]]),
            unquotedProperties: new Set(),
            inlineSerializedTypes: new Set(),
            referenceWrapperTypes: new Map()
         });

         expect(await serializer.serializeAst({ $type: 'List', items: ['a', 'b', 'c'] } as never)).toBe(
            'items:\n  - "a"\n  - "b"\n  - "c"'
         );
      });

      it('serializes an array of nested nodes as block list items', async () => {
         const serializer = buildYaml(YamlSerializer, {
            reflection: makeFakeReflection({ Doc: {}, Item: {} }),
            propertyOrder: new Map([
               ['Doc', ['items']],
               ['Item', ['name']]
            ]),
            unquotedProperties: new Set(),
            inlineSerializedTypes: new Set(),
            referenceWrapperTypes: new Map()
         });

         const node = {
            $type: 'Doc',
            items: [
               { $type: 'Item', name: 'x' },
               { $type: 'Item', name: 'y' }
            ]
         };
         expect(await serializer.serializeAst(node as never)).toBe('items:\n  - name: "x"\n  - name: "y"');
      });
   });

   describe('optional option maps omitted', () => {
      it('serializes a nested node when inlineSerializedTypes and unquotedProperties are unset', async () => {
         // No optional maps supplied — the optional-chaining lookups on
         // inlineSerializedTypes / unquotedProperties must not throw.
         const serializer = buildYaml(YamlSerializer, { reflection: makeFakeReflection({ Root: {}, Child: {} }) });

         const node = { $type: 'Root', child: { $type: 'Child', name: 'x' } };
         expect(await serializer.serializeAst(node as never)).toBe('child:\n  name: "x"');
      });
   });

   describe('empty nested node', () => {
      it('omits a property whose nested node serializes to empty', async () => {
         const serializer = buildYaml(YamlSerializer, {
            reflection: makeFakeReflection({ Root: {}, Empty: {} }),
            propertyOrder: new Map([
               ['Root', ['child', 'name']],
               ['Empty', []]
            ]),
            unquotedProperties: new Set(),
            inlineSerializedTypes: new Set(),
            referenceWrapperTypes: new Map()
         });

         // The empty child block serializes to '' and must be dropped, not emitted as a bare `child:`.
         const node = { $type: 'Root', child: { $type: 'Empty' }, name: 'keep' };
         expect(await serializer.serializeAst(node as never)).toBe('name: "keep"');
      });
   });

   describe('nested block indentation', () => {
      it('indents each line of a multi-property nested block exactly once', async () => {
         const serializer = buildYaml(YamlSerializer, {
            reflection: makeFakeReflection({ Root: {}, C: {} }),
            propertyOrder: new Map([
               ['Root', ['child']],
               ['C', ['a', 'b']]
            ]),
            unquotedProperties: new Set(),
            inlineSerializedTypes: new Set(),
            referenceWrapperTypes: new Map()
         });

         // Only the first line carries the block indent in pushNodeLine; the rest pick it up
         // from the join. A regressed isFirst flag would double-indent line two.
         const node = { $type: 'Root', child: { $type: 'C', a: '1', b: '2' } };
         expect(await serializer.serializeAst(node as never)).toBe('child:\n  a: "1"\n  b: "2"');
      });
   });

   describe('async element handling', () => {
      class AsyncPrimitive extends YamlSerializer {
         protected override formatPrimitive(value: unknown): Promise<string> {
            return Promise.resolve(JSON.stringify(value) as string);
         }
      }
      class AsyncReference extends YamlSerializer {
         protected override formatReferenceValue(value: string): Promise<string> {
            return Promise.resolve(super.formatReferenceValue(value) as string);
         }
      }

      it('awaits async element formatting across a primitive array', async () => {
         const serializer = buildYaml(AsyncPrimitive, {
            reflection: makeFakeReflection({ List: {} }),
            propertyOrder: new Map([['List', ['items']]]),
            unquotedProperties: new Set(),
            inlineSerializedTypes: new Set(),
            referenceWrapperTypes: new Map()
         });

         expect(await serializer.serializeAst({ $type: 'List', items: ['a', 'b'] } as never)).toBe('items:\n  - "a"\n  - "b"');
      });

      it('awaits async reference formatting across a reference array', async () => {
         const serializer = buildYaml(AsyncReference, {
            reflection: makeFakeReflection({ Group: { members: { referenceType: 'Person' } } }),
            propertyOrder: new Map([['Group', ['members']]]),
            unquotedProperties: new Set(),
            inlineSerializedTypes: new Set(),
            referenceWrapperTypes: new Map()
         });

         expect(await serializer.serializeAst({ $type: 'Group', members: ['a', 'b'] } as never)).toBe('members:\n  - "a"\n  - "b"');
      });
   });
});
