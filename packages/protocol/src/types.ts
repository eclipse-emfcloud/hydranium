/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * The keys of a type map, Langium's `<LanguageName>AstType` or the generated
 * `<LanguageId>TransferTypes`, that a node can carry as its `$type`: those
 * listed in their own type's `$type`. A union, or an abstract type whose
 * `$type` names only its subtypes, has a constant too, but building one would
 * yield a node that no guard accepts. A concrete type with subtypes lists its
 * own name beside theirs, as Langium writes it, and stays buildable.
 */
export type ConcreteTypeName<TMap> = {
   [K in keyof TMap]: K extends (TMap[K] extends { readonly $type: infer TType } ? TType : never) ? K : never;
}[keyof TMap] &
   string;

type IsUnion<T, TAll = T> = T extends unknown ? ([TAll] extends [T] ? false : true) : never;

/**
 * Intersected onto a builder's type-constant parameter, refuses a constant
 * typed by a union of type names: the init would hold only the members' common
 * fields, so either type could be built incomplete.
 */
export type SingleTypeName<TType> = true extends IsUnion<TType> ? { readonly $type: never } : unknown;
