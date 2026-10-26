/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, expect, it } from 'vitest';
import { formatLogArg } from '../src/format-log-arg';

describe('formatLogArg', () => {
   it('renders a string as it is and an object as JSON', () => {
      expect(formatLogArg('text')).toBe('text');
      expect(formatLogArg({ name: 'One', items: [1, 2] })).toBe('{"name":"One","items":[1,2]}');
   });

   it('marks a reference back to an ancestor and keeps the other fields', () => {
      const root: Record<string, unknown> = { name: 'Root' };
      root.child = { name: 'Child', container: root };
      expect(formatLogArg(root)).toBe('{"name":"Root","child":{"name":"Child","container":"[Circular]"}}');
   });

   it('renders an object shared by siblings each time, since it is no cycle', () => {
      const shared = { id: 1 };
      expect(formatLogArg({ first: shared, second: shared })).toBe('{"first":{"id":1},"second":{"id":1}}');
   });

   it('cuts an object or array nested deeper than two levels', () => {
      expect(formatLogArg({ one: { two: { three: { four: 4 }, list: [[1]] } } })).toBe(
         '{"one":{"two":{"three":"[Object]","list":"[Array]"}}}'
      );
      expect(formatLogArg([{ one: { two: { three: 3 } } }])).toBe('[{"one":{"two":"[Object]"}}]');
   });

   it('cuts a long array, a wide object and a long string', () => {
      const array = JSON.parse(formatLogArg({ list: Array.from({ length: 150 }, (_, i) => i) })) as { list: unknown[] };
      expect(array.list).toHaveLength(101);
      expect(array.list[100]).toBe('... 50 more items');

      const wide = JSON.parse(formatLogArg(Object.fromEntries(Array.from({ length: 120 }, (_, i) => [`key${i}`, i])))) as Record<
         string,
         unknown
      >;
      expect(Object.keys(wide)).toHaveLength(101);
      expect(wide['... 20 more keys']).toBe('...');

      const text = JSON.parse(formatLogArg({ text: 'x'.repeat(10_005) })) as { text: string };
      expect(text.text).toBe(`${'x'.repeat(10_000)}... 5 more characters`);
   });

   it('keeps every kept entry when a cut key or the note equals another key', () => {
      const wide = Object.fromEntries([['... 1 more keys', 'own'], ...Array.from({ length: 100 }, (_, i) => [`key${i}`, i])]);
      const rendered = JSON.parse(formatLogArg(wide)) as Record<string, unknown>;
      expect(rendered['... 1 more keys']).toBe('own');
      expect(rendered['... 1 more keys (2)']).toBe('...');

      const prefix = 'k'.repeat(10_000);
      const long = JSON.parse(formatLogArg({ [`${prefix}a`]: 1, [`${prefix}b`]: 2 })) as Record<string, unknown>;
      expect(Object.values(long)).toEqual([1, 2]);
   });

   it('keeps a __proto__ key of an object it copies', () => {
      const wide = Object.fromEntries([['__proto__', 'own'], ...Array.from({ length: 120 }, (_, i) => [`key${i}`, i])]);
      expect(formatLogArg(wide)).toContain('"__proto__":"own"');
   });

   it('cuts the whole argument once its limits multiply past the total', () => {
      const text = 'x'.repeat(10_000);
      const level = (child: unknown): Record<string, unknown> =>
         Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`key${i}`, child]));
      const rendered = formatLogArg(level(level(level(text))));
      expect(rendered.length).toBeLessThan(110_000);
      expect(rendered.match(/"\.\.\."/g)).toHaveLength(1);
   });

   it('counts numbers, null items, punctuation and indent against the total', () => {
      const level = (child: unknown): Record<string, unknown> =>
         Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`key${i}`, child]));
      const graph = level(level(level(-1.234567890123456e-300)));
      expect(formatLogArg(graph).length).toBeLessThan(110_000);
      expect(formatLogArg(graph, { indent: 4 }).length).toBeLessThan(110_000);
      expect(formatLogArg(Array.from({ length: 10 }, () => '\0'.repeat(10_000))).length).toBeLessThan(110_000);
      const items = (child: unknown): unknown[] => Array.from({ length: 100 }, () => child);
      expect(formatLogArg(items(items(items(undefined)))).length).toBeLessThan(110_000);
   });

   it('charges nothing for an entry JSON leaves out of an object', () => {
      const methods = Object.fromEntries(Array.from({ length: 99 }, (_, i) => [`${'k'.repeat(2_000)}${i}`, () => i]));
      expect(formatLogArg({ ...methods, last: 1 })).toBe('{"last":1}');
   });

   it('cuts a long key and a long boxed string as it cuts a string', () => {
      expect(formatLogArg({ ['k'.repeat(300_000)]: 1 }).length).toBeLessThan(10_100);
      expect(formatLogArg({ text: new String('x'.repeat(300_000)) }).length).toBeLessThan(10_100);
   });

   it('cuts a typed array as an array, without listing its keys', () => {
      const rendered = JSON.parse(formatLogArg({ bytes: new Uint8Array(1_000) })) as { bytes: unknown[] };
      expect(rendered.bytes).toHaveLength(101);
      expect(rendered.bytes[100]).toBe('... 900 more items');
   });

   it('renders a boxed primitive as its value', () => {
      expect(formatLogArg({ one: { two: { text: new String('y'.repeat(120)) } } })).toBe(`{"one":{"two":{"text":"${'y'.repeat(120)}"}}}`);
   });

   it('marks a reference back to an object it cut', () => {
      const wide: Record<string, unknown> = Object.fromEntries(Array.from({ length: 120 }, (_, i) => [`key${i}`, i]));
      wide.key0 = { container: wide };
      expect(formatLogArg(wide)).toContain('"key0":{"container":"[Circular]"}');
   });

   it('indents when asked', () => {
      expect(formatLogArg({ kind: 'One' }, { indent: 4 })).toBe('{\n    "kind": "One"\n}');
   });

   it('describes what JSON cannot render rather than dropping it', () => {
      expect(formatLogArg(10n)).toBe('10');
      expect(formatLogArg({ toJSON: () => undefined })).toBe('[object Object]');
   });

   it('renders a nested BigInt, boxed or not, by its digits rather than losing the object', () => {
      expect(formatLogArg({ id: 'x', size: 10n })).toBe('{"id":"x","size":"10"}');
      expect(formatLogArg({ boxed: Object(10n) })).toBe('{"boxed":"10"}');
   });
});
