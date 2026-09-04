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
 * Runtime behaviour: reads `reflection.getTypeMetaData(type).properties` and,
 * for every property whose metadata carries a `defaultValue`, pre-fills the
 * result before merging the caller's `init`. Array defaults are materialised
 * as a fresh `[]` per call (never shared with the metadata's array instance,
 * which downstream callers mutate); scalar defaults (`false`, `0`, `''`, …)
 * are copied as-is since they're immutable. Grammar-generated containment
 * lists and `?=`-style boolean flags therefore default automatically;
 * TS-augmented fields (declared via `declare module './generated/ast.js'`)
 * are unaffected by the runtime defaulting but remain typed at call sites.
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
      const meta = reflection.getTypeMetaData(typeConstant.$type);
      const result: Record<string, unknown> = { $type: typeConstant.$type };
      if (meta?.properties) {
         for (const [propName, propInfo] of Object.entries(meta.properties)) {
            const defaultValue = propInfo.defaultValue;
            if (defaultValue === undefined) {
               continue;
            }
            // Arrays are duplicated so each node carries its own mutable instance;
            // scalars are immutable and safe to copy by reference.
            result[propName] = Array.isArray(defaultValue) ? [...defaultValue] : defaultValue;
         }
      }
      Object.assign(result, init);
      if (extras) {
         // Extras win over init: this is the explicit escape hatch, so when a
         // call site uses it, treat that as deliberate override intent.
         Object.assign(result, extras);
      }
      return result as unknown as Extract<TMap[TType], AstNode>;
   };
}
