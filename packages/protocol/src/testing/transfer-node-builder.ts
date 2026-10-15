/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import type { TransferElement } from '../transfer-element';
import type { ConcreteTypeName, SingleTypeName } from '../types';

/**
 * The per-type constant the generated transfer model emits under each type's
 * name, as Langium does for the AST. Its `$type` literal picks the interface
 * out of the builder's type map.
 */
export interface TransferTypeConstant<TType extends string = string> {
   readonly $type: TType;
}

/**
 * What {@link makeTransferNodeBuilder} reads from a reflection: each type's
 * grammar properties and their defaults. The generated
 * `<LanguageId>TransferReflection` satisfies it without importing it, and
 * keeps the literal type of its `types` so the builder can tell which fields
 * the grammar defaults.
 */
export interface TransferReflection {
   getTypeMetaData(type: string): { readonly properties: Readonly<Record<string, { readonly defaultValue?: unknown }>> };
}

/** The properties of `TType` that `TReflection`'s literal `types` gives a `defaultValue`; none for a reflection typed only as the interface. */
type DefaultedKeys<TReflection, TType> = TReflection extends { readonly types: infer Types }
   ? TType extends keyof Types
      ? Types[TType] extends { readonly properties: infer Properties }
         ? { [K in keyof Properties]: Properties[K] extends { readonly defaultValue: unknown } ? K : never }[keyof Properties]
         : never
      : never
   : never;

/**
 * Init payload of a {@link TransferNodeBuilder}: every field of `T` as its
 * interface declares it, except that the fields named by `TDefaulted`, which
 * the grammar defaults, are optional. `$type` comes from the constant.
 */
export type TransferNodeInit<T extends TransferElement, TDefaulted extends PropertyKey = never> = Omit<T, '$type' | TDefaulted> &
   Partial<Pick<T, Extract<TDefaulted, keyof T>>>;

/**
 * Transfer-node factory bound to a grammar's type map, the transfer twin of
 * core's `AstNodeBuilder`. `TMap` is the generated `<LanguageId>TransferTypes`,
 * `TReflection` the type of the generated reflection.
 */
export interface TransferNodeBuilder<TMap, TReflection extends TransferReflection = TransferReflection> {
   /** A complete node: the grammar's defaults, then `init`. */
   <TType extends ConcreteTypeName<TMap>>(
      typeConstant: TransferTypeConstant<TType> & SingleTypeName<TType>,
      init: TransferNodeInit<Extract<TMap[TType], TransferElement>, DefaultedKeys<TReflection, TType>>
   ): Extract<TMap[TType], TransferElement>;
   /**
    * A node holding only `init`, with no defaults filled, typed as the
    * incomplete node it is.
    */
   partial<TType extends ConcreteTypeName<TMap>>(
      typeConstant: TransferTypeConstant<TType> & SingleTypeName<TType>,
      init?: Partial<Omit<Extract<TMap[TType], TransferElement>, '$type'>>
   ): Partial<Extract<TMap[TType], TransferElement>> & TransferTypeConstant<TType>;
}

/**
 * Bind a {@link TransferNodeBuilder} to a grammar's reflection, so a test names
 * only the fields it cares about and a containment field the grammar gains
 * later needs no change at the call site.
 *
 * Defaults come from the reflection's grammar metadata alone, so a derived
 * field the overlay adds is never defaulted, and stays required. An array
 * default is a fresh `[]` per node. An init field named as `undefined` keeps
 * its default, since the init type cannot refuse `undefined` for an optional
 * field and a plain assign would leave the node typed complete without it.
 *
 * The constant's `$type` is written after `init`, because the init type keeps
 * out only a `$type` written in the call: a spread of another node passes the
 * check and would otherwise hand back a node typed as one type and tagged as
 * another.
 */
export function makeTransferNodeBuilder<TMap, TReflection extends TransferReflection = TransferReflection>(
   reflection: TReflection
): TransferNodeBuilder<TMap, TReflection> {
   const build = (typeConstant: TransferTypeConstant, init: object): object => {
      const node: Record<string, unknown> = { $type: typeConstant.$type };
      for (const [name, property] of Object.entries(reflection.getTypeMetaData(typeConstant.$type).properties)) {
         if (property.defaultValue !== undefined) {
            node[name] = Array.isArray(property.defaultValue) ? [...property.defaultValue] : property.defaultValue;
         }
      }
      for (const [name, value] of Object.entries(init)) {
         if (value !== undefined || !Object.hasOwn(node, name)) {
            node[name] = value;
         }
      }
      node.$type = typeConstant.$type;
      return node;
   };
   const partial = (typeConstant: TransferTypeConstant, init: object = {}): object => ({ ...init, $type: typeConstant.$type });
   return Object.assign(build, { partial }) as TransferNodeBuilder<TMap, TReflection>;
}
