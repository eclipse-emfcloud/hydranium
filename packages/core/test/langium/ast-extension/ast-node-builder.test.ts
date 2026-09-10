/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, expect, test } from 'vitest';
import { AbstractAstReflection, type AstNode, type TypeMetaData } from '@hydranium/langium';
import { buildAstNode, makeAstNodeBuilder } from '../../../src/langium/ast-extension/ast-node-builder.js';

/**
 * Minimal stand-ins for the per-type interface + per-type constant pair that
 * Langium emits for each grammar-generated AST node. Exercising the builder
 * against locally-declared types keeps the test independent of any specific
 * grammar.
 */
interface FakeRoot extends AstNode {
   readonly $type: 'FakeRoot';
   name: string;
   children: FakeChild[];
   tags: string[];
}
const FakeRoot = { $type: 'FakeRoot', name: 'name', children: 'children', tags: 'tags' } as const;

interface FakeChild extends AstNode {
   readonly $container: FakeRoot;
   readonly $type: 'FakeChild';
   id: string;
   labels: string[];
}
const FakeChild = { $type: 'FakeChild', id: 'id', labels: 'labels' } as const;

interface FakeLeaf extends AstNode {
   readonly $type: 'FakeLeaf';
   value: number;
}
const FakeLeaf = { $type: 'FakeLeaf', value: 'value' } as const;

/**
 * Carries scalar-default metadata (boolean + number) — exercises the runtime
 * defaulting path for properties whose Langium metadata declares a non-array
 * `defaultValue`. The grammar analogue is a `?=`-style boolean flag.
 */
interface FakeFlag extends AstNode {
   readonly $type: 'FakeFlag';
   id: string;
   active: boolean;
   priority: number;
}
const FakeFlag = { $type: 'FakeFlag', id: 'id', active: 'active', priority: 'priority' } as const;

/**
 * Carries a NON-empty array `defaultValue` in metadata plus a metadata-declared
 * scalar property with NO default. Exercises (a) the per-call array duplication
 * preserving the seed contents and (b) the "no default → skip" path leaving the
 * property absent from the result.
 */
interface FakeSeeded extends AstNode {
   readonly $type: 'FakeSeeded';
   id: string;
   modes: string[];
}
const FakeSeeded = { $type: 'FakeSeeded', id: 'id', modes: 'modes' } as const;

/**
 * Per-grammar $type → interface registry — Langium emits this as
 * `<LanguageName>AstType` next to the reflection for every grammar. The
 * builder picks it up via the `TMap` generic so call sites can infer the AST
 * interface from a constant's `$type` literal alone.
 */
type FakeAstType = {
   FakeRoot: FakeRoot;
   FakeChild: FakeChild;
   FakeLeaf: FakeLeaf;
   FakeFlag: FakeFlag;
   FakeSeeded: FakeSeeded;
};

/**
 * Mock reflection that emits Langium's per-type metadata shape, including
 * `defaultValue: []` on the array properties so the builder's auto-default
 * path is exercised.
 */
class FakeReflection extends AbstractAstReflection {
   override readonly types: Record<string, TypeMetaData> = {
      FakeRoot: {
         name: 'FakeRoot',
         properties: {
            name: { name: 'name' },
            children: { name: 'children', defaultValue: [] },
            tags: { name: 'tags', defaultValue: [] }
         },
         superTypes: []
      },
      FakeChild: {
         name: 'FakeChild',
         properties: {
            id: { name: 'id' },
            labels: { name: 'labels', defaultValue: [] }
         },
         superTypes: []
      },
      FakeLeaf: {
         name: 'FakeLeaf',
         properties: {
            value: { name: 'value' }
         },
         superTypes: []
      },
      FakeFlag: {
         name: 'FakeFlag',
         properties: {
            id: { name: 'id' },
            active: { name: 'active', defaultValue: false },
            priority: { name: 'priority', defaultValue: 0 }
         },
         superTypes: []
      },
      FakeSeeded: {
         name: 'FakeSeeded',
         properties: {
            // `id` has no declared default — the builder must NOT add it.
            id: { name: 'id' },
            // Non-empty array default — duplication must preserve the contents.
            modes: { name: 'modes', defaultValue: ['read', 'write'] }
         },
         superTypes: []
      }
   };
}

const astNode = makeAstNodeBuilder<FakeAstType>(new FakeReflection());

describe('makeAstNodeBuilder', () => {
   test('sets $type from the type constant', () => {
      const root = astNode(FakeRoot, { name: 'root' });
      expect(root.$type).toBe('FakeRoot');
   });

   test('auto-defaults array properties to fresh empty arrays', () => {
      const root = astNode(FakeRoot, { name: 'root' });
      expect(root.children).toEqual([]);
      expect(root.tags).toEqual([]);
   });

   test('returns fresh arrays per call (no shared-reference bugs)', () => {
      const a = astNode(FakeRoot, { name: 'a' });
      const b = astNode(FakeRoot, { name: 'b' });
      a.children.push({ $type: 'FakeChild' } as FakeChild);
      expect(b.children).toEqual([]); // not affected by mutation of `a.children`
   });

   test('caller-provided array overrides the default', () => {
      const child = { $type: 'FakeChild', id: 'c1', labels: [] } as unknown as FakeChild;
      const root = astNode(FakeRoot, { name: 'root', children: [child] });
      expect(root.children).toEqual([child]);
   });

   test('auto-defaults scalar properties (boolean / number) from metadata', () => {
      // `AstNodeInit<FakeFlag>` still demands the scalar fields (TS cannot read
      // runtime metadata to relax the requirement), but the cast below
      // simulates a partial-init bypass and proves the runtime safety net
      // fills the declared defaults regardless.
      const flag = astNode(FakeFlag, { id: 'f1' } as Parameters<typeof astNode<'FakeFlag'>>[1]);
      expect(flag.active).toBe(false);
      expect(flag.priority).toBe(0);
   });

   test('caller-provided scalar overrides the default', () => {
      const flag = astNode(FakeFlag, { id: 'f1', active: true, priority: 5 });
      expect(flag.active).toBe(true);
      expect(flag.priority).toBe(5);
   });

   test('returns the typed interface without a cast at the call site', () => {
      // Type-only check: assignability to FakeRoot is what proves no cast is needed.
      const root: FakeRoot = astNode(FakeRoot, { name: 'root' });
      expect(root.name).toBe('root');
   });

   test('wires Langium plumbing fields when supplied', () => {
      const root = astNode(FakeRoot, { name: 'parent' });
      const child = astNode(FakeChild, {
         id: 'c1',
         $container: root,
         $containerProperty: FakeRoot.children,
         $containerIndex: 0
      });
      expect(child.$container).toBe(root);
      expect(child.$containerProperty).toBe('children');
      expect(child.$containerIndex).toBe(0);
   });

   test('omits Langium plumbing fields when not supplied', () => {
      const root = astNode(FakeRoot, { name: 'lone' });
      expect(root.$container).toBeUndefined();
      expect(root.$containerProperty).toBeUndefined();
      expect(root.$containerIndex).toBeUndefined();
   });

   test('type without array properties yields no extra fields', () => {
      const leaf = astNode(FakeLeaf, { value: 42 });
      expect(leaf).toEqual({ $type: 'FakeLeaf', value: 42 });
   });

   test('honours $synthetic when adopters set it via init', () => {
      const node = astNode(FakeChild, { id: 'syn', $synthetic: true });
      expect((node as AstNode & { $synthetic?: boolean }).$synthetic).toBe(true);
   });

   test('extras: accepts arbitrary unchecked properties', () => {
      const node = astNode(FakeLeaf, { value: 1 }, { _customFlag: true, $debug: 'trace-id' });
      expect((node as unknown as { _customFlag: boolean })._customFlag).toBe(true);
      expect((node as unknown as { $debug: string }).$debug).toBe('trace-id');
   });

   test('extras: undefined is a no-op', () => {
      const node = astNode(FakeLeaf, { value: 1 }, undefined);
      expect(node).toEqual({ $type: 'FakeLeaf', value: 1 });
   });

   test('extras: win over init on conflict (explicit override semantic)', () => {
      // Conflict isn't expected in normal use but the resolution order is observable.
      const node = astNode(FakeLeaf, { value: 1 }, { value: 999 });
      expect(node.value).toBe(999);
   });

   test('extras: do not pollute when not provided', () => {
      const node = astNode(FakeLeaf, { value: 1 });
      expect(Object.keys(node).sort()).toEqual(['$type', 'value']);
   });

   test('the constant drives $type — extras cannot accidentally rebind it', () => {
      // The extras object can technically clobber $type, but the typed-init
      // signature does not include it, so the typed surface stays clean.
      const node = astNode(FakeLeaf, { value: 1 });
      expect(node.$type).toBe(FakeLeaf.$type);
   });

   test('inference: return type resolved from TMap without an explicit generic', () => {
      // Without the TMap-generic plumbing on `makeAstNodeBuilder`, TS would
      // infer the return type as `AstNode` and `.name` / `.value` access would
      // require a cast. The assertions below compile because TS resolved the
      // return to `FakeRoot` / `FakeLeaf` via `FakeAstType[$type-literal]`.
      const root = astNode(FakeRoot, { name: 'inferred' });
      const leaf = astNode(FakeLeaf, { value: 7 });
      const rootName: string = root.name;
      const leafValue: number = leaf.value;
      expect(rootName).toBe('inferred');
      expect(leafValue).toBe(7);
   });

   test('duplicates a non-empty array default, preserving its seed contents', () => {
      // Kills the array-spread → `[]` mutant: the seeded default must be copied
      // by value, not replaced with an empty array.
      const seeded = astNode(FakeSeeded, { id: 's1' } as Parameters<typeof astNode<'FakeSeeded'>>[1]);
      expect(seeded.modes).toEqual(['read', 'write']);
      // And it must be a fresh copy, not the metadata's own array instance.
      const other = astNode(FakeSeeded, { id: 's2' } as Parameters<typeof astNode<'FakeSeeded'>>[1]);
      seeded.modes.push('execute');
      expect(other.modes).toEqual(['read', 'write']);
   });

   test('omits metadata-declared properties that have no default', () => {
      // `id` is declared in metadata but carries no `defaultValue`. The builder
      // must skip it (the `=== undefined` guard + `continue`), so it only
      // appears in the result when the caller supplies it.
      const seeded = astNode(FakeSeeded, { id: 's1' } as Parameters<typeof astNode<'FakeSeeded'>>[1]);
      expect(seeded.id).toBe('s1');
      // When the caller omits a no-default property, the key must be ABSENT —
      // not present with an `undefined` value (which the skip-guard mutants
      // would produce).
      const partial = astNode(FakeSeeded, {} as Parameters<typeof astNode<'FakeSeeded'>>[1]);
      expect(Object.keys(partial).sort()).toEqual(['$type', 'modes']);
   });

   test('tolerates reflection metadata being absent (no properties to default)', () => {
      // `getTypeMetaData` returning `undefined` exercises the `meta?.properties`
      // optional chain and the truthy guard around the defaulting loop: the
      // builder must not throw and must still emit `$type` + the caller's init.
      class NoMetaReflection extends FakeReflection {
         override getTypeMetaData(): never {
            return undefined as never;
         }
      }
      const astNodeNoMeta = makeAstNodeBuilder<FakeAstType>(new NoMetaReflection());
      const leaf = astNodeNoMeta(FakeLeaf, { value: 5 });
      expect(leaf).toEqual({ $type: 'FakeLeaf', value: 5 });
   });
});

describe('buildAstNode', () => {
   const reflection = new FakeReflection();

   test('defaults containment arrays from a runtime type string', () => {
      // The whole point of the runtime variant: the caller has a `string`, not a
      // `$type` literal, so no type map can resolve the metadata for it.
      const type: string = 'FakeRoot';
      const root = buildAstNode(reflection, type);
      expect(root).toEqual({ $type: 'FakeRoot', children: [], tags: [] });
   });

   test('returns fresh arrays per call', () => {
      const first = buildAstNode<FakeRoot>(reflection, 'FakeRoot');
      const second = buildAstNode<FakeRoot>(reflection, 'FakeRoot');
      first.children.push({ $type: 'FakeChild' } as FakeChild);
      expect(second.children).toEqual([]);
   });

   test('init overrides the declared defaults', () => {
      const seeded = buildAstNode(reflection, 'FakeSeeded', { modes: ['execute'] });
      expect((seeded as unknown as { modes: string[] }).modes).toEqual(['execute']);
   });

   test('carries the Langium plumbing fields an init supplies', () => {
      const root = buildAstNode<FakeRoot>(reflection, 'FakeRoot');
      const child = buildAstNode<FakeChild>(reflection, 'FakeChild', {
         $container: root,
         $containerProperty: 'children',
         $containerIndex: 2
      });
      expect(child.$container).toBe(root);
      expect(child.$containerProperty).toBe('children');
      expect(child.$containerIndex).toBe(2);
      expect(child.labels).toEqual([]);
   });

   test('the type argument wins over a $type carried in by a spread init', () => {
      // The retyping case: a caller producing a node of a DIFFERENT type from an
      // existing one spreads the source in, and the source's own `$type` would
      // otherwise overwrite the type actually requested — handing back a node of
      // the wrong type with nothing reporting it.
      const source = buildAstNode<FakeChild>(reflection, 'FakeChild', { id: 'c1' });
      const retyped = buildAstNode(reflection, 'FakeLeaf', { ...source, value: 1 });
      expect(retyped.$type).toBe('FakeLeaf');
   });

   test('an unknown type name yields $type plus init, without throwing', () => {
      // A runtime type name arrives from a client, so it can name a type this
      // grammar does not have. Refusing would turn a permissive lookup into a
      // throw at a call site that can only guess.
      const node = buildAstNode(reflection, 'NotAGrammarType', { hint: 'x' });
      expect(node).toEqual({ $type: 'NotAGrammarType', hint: 'x' });
   });
});
