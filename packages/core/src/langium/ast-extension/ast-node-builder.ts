/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import type { AstNode, AstReflection } from '@hydranium/langium';

/**
 * Shape of the per-type constants Langium emits alongside each
 * grammar-generated interface — a `const` of the same name whose `$type` field
 * carries the type name and whose remaining keys mirror the property names.
 *
 * The builder consumes this constant to drive `$type` at runtime; the
 * `$type`-literal type ties the constant to the AST interface at compile time.
 */
export interface AstTypeConstant<TType extends string = string> {
   readonly $type: TType;
}

/**
 * Keys of `T` whose values are array-typed. Used to mark array-valued fields
 * as optional in the init shape — the builder auto-defaults them to `[]` from
 * Langium's reflection metadata, so callers need not spell out an empty array
 * for every containment list on the type.
 */
type ArrayKeys<T> = { [K in keyof T]-?: T[K] extends ReadonlyArray<unknown> ? K : never }[keyof T];

/**
 * Init payload for {@link AstNodeBuilder}: every non-array, non-Langium field
 * of `T` is required (so TS still catches missing mandatory data); array
 * fields are optional (auto-defaulted from the grammar's reflection metadata);
 * Langium plumbing (`$container` / `$containerProperty` / `$containerIndex`)
 * and `$synthetic` are optional overrides.
 *
 * `$type` is supplied by the type constant, not the init.
 */
export type AstNodeInit<T extends AstNode> = Omit<T, keyof AstNode | ArrayKeys<T>> &
   Partial<Pick<T, ArrayKeys<T>>> &
   Partial<Pick<AstNode, '$container' | '$containerProperty' | '$containerIndex'>> & {
      $synthetic?: boolean;
   };

/**
 * Pre-bound AST-node factory. Adopters bind once at language-module load
 * (see {@link makeAstNodeBuilder}) and re-export the result so call sites can
 * `import { astNode } from '...'` without threading reflection through.
 *
 * `TMap` is the grammar's type-name → AST-interface registry. Langium emits
 * this as `<LanguageName>AstType` next to the reflection (in the grammar's
 * generated `ast.js`). Threading the map through the builder lets TS resolve
 * the AST interface from a constant's `$type` literal alone, so call sites do
 * not have to write the type name twice.
 *
 * @param typeConstant the per-type constant Langium emits (drives `$type`).
 * @param init typed fields — TS enforces mandatory non-array fields here.
 * @param extras explicitly-unchecked escape hatch for properties not declared
 *               on the AST interface. Use sparingly; lives in a separate
 *               argument so typos can't silently pass into the typed slot.
 */
export type AstNodeBuilder<TMap> = <TType extends string & keyof TMap>(
   typeConstant: AstTypeConstant<TType>,
   init: AstNodeInit<Extract<TMap[TType], AstNode>>,
   extras?: Record<string, unknown>
) => Extract<TMap[TType], AstNode>;

/**
 * Build an {@link AstNodeBuilder} pre-bound to a language's `AstReflection`
 * and its grammar `AstType` registry.
 *
 * The factory shape exists so the framework stays grammar-agnostic: each
 * adopter binds the helper once next to their language module, passing their
 * generated reflection and `AstType` registry, and exports the resulting
 * `astNode` function. The registry generic gives TS the grammar's `$type` →
 * AST-interface mapping, so call sites get full inference from the type
 * constant alone — no explicit generic parameter at every call site.
 *
 * Runtime behaviour: pre-fills every grammar-declared default (see
 * {@link withTypeDefaults}) before merging the caller's `init`, so containment
 * lists and `?=`-style boolean flags default automatically. TS-augmented fields
 * (declared via `declare module './generated/ast.js'`) are unaffected by the
 * runtime defaulting but remain typed at call sites.
 *
 * Use {@link buildAstNode} instead when the type name is only known at runtime.
 *
 * The init shape only relaxes array-typed fields to optional (via
 * {@link ArrayKeys}) — there is no equivalent structural signal for "this
 * property has a default in the metadata", so non-array defaulted fields
 * (e.g. boolean flags) still appear required in {@link AstNodeInit}. The
 * runtime defaulting is therefore a safety net for casts / partial inits
 * rather than a way to drop fields from the typed call site.
 */
export function makeAstNodeBuilder<TMap>(reflection: AstReflection): AstNodeBuilder<TMap> {
   return function astNode<TType extends string & keyof TMap>(
      typeConstant: AstTypeConstant<TType>,
      init: AstNodeInit<Extract<TMap[TType], AstNode>>,
      extras?: Record<string, unknown>
   ): Extract<TMap[TType], AstNode> {
      const result = withTypeDefaults(reflection, typeConstant.$type);
      Object.assign(result, init);
      if (extras) {
         // Extras win over init: this is the explicit escape hatch, so when a
         // call site uses it, treat that as deliberate override intent.
         Object.assign(result, extras);
      }
      return result as unknown as Extract<TMap[TType], AstNode>;
   };
}

/**
 * Build a node whose type is only known as a RUNTIME string.
 *
 * The typed {@link makeAstNodeBuilder} cannot express this: its `TMap` generic
 * resolves the AST interface from a `$type` literal, and a type name that
 * arrives over the wire — a protocol-layer reference request naming a node that
 * does not exist yet — has no literal to resolve from. Callers that DO know the
 * type at compile time want the typed builder, which checks their mandatory
 * fields; this one checks nothing beyond the reflection lookup.
 *
 * Applies the same reflection-driven defaulting, so a node built here carries
 * grammar-declared containment arrays rather than leaving them `undefined`. An
 * unknown type name yields a node with `$type` and whatever `init` supplied,
 * because reflection answers no metadata for it and refusing would turn a
 * permissive lookup into a throw at a call site that can only guess.
 *
 * **The `type` argument is authoritative: `init` cannot rebind `$type`.** The
 * typed builder gets this for free — `AstNodeInit` omits `$type`, so a call site
 * cannot reach it — but here `init` is loosely typed, and the case that needs
 * the guarantee is RETYPING: a caller spreading an existing node to produce one
 * of a different type (`{ ...source }`) carries the SOURCE's `$type` in, which
 * would silently win over the type actually requested and hand back a node of
 * the wrong type with no error anywhere.
 */
export function buildAstNode<TAst extends AstNode = AstNode>(
   reflection: AstReflection,
   type: string,
   init?: Partial<AstNode> & Record<string, unknown>
): TAst {
   const result = withTypeDefaults(reflection, type);
   if (init) {
      Object.assign(result, init);
      result.$type = type;
   }
   return result as unknown as TAst;
}

/**
 * Seed a node with `$type` plus every property the grammar declares a default
 * for. Array defaults are materialised as a fresh `[]` per call — never shared
 * with the metadata's own array instance, which downstream callers mutate —
 * while scalar defaults are copied as-is since they are immutable.
 */
function withTypeDefaults(reflection: AstReflection, type: string): Record<string, unknown> {
   const result: Record<string, unknown> = { $type: type };
   const meta = reflection.getTypeMetaData(type);
   if (meta?.properties) {
      for (const [propName, propInfo] of Object.entries(meta.properties)) {
         const defaultValue = propInfo.defaultValue;
         if (defaultValue === undefined) {
            continue;
         }
         result[propName] = Array.isArray(defaultValue) ? [...defaultValue] : defaultValue;
      }
   }
   return result;
}
