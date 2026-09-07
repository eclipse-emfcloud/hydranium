/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { type MaybePromise, type TransferElement } from '@hydranium/protocol';
import type { AstNode } from '@hydranium/langium';

/**
 * Serializes a semantic-model element back to its source-text representation.
 *
 * Implementations must round-trip: `parse(serializeAst(model))` should yield
 * the same AST shape as `model` (modulo CST-node noise that doesn't round-trip
 * cleanly).
 *
 * **Two shapes, two methods.** The framework recognises two distinct shapes for
 * a semantic-model element — both flow through the same property walker but
 * the interface keeps them on separate methods so the type system stays honest:
 *
 * - {@link serializeAst} consumes a Langium AST element — cross-references are
 *   `Reference<T>` objects with `$refText`, `ref`, etc.
 * - {@link serializeTransfer} consumes a transfer-model element —
 *   structurally equivalent to the AST but with cross-references represented
 *   as plain strings (the names that `Reference.$refText` would return).
 *
 * Adopters who only have AST inputs use {@link serializeAst} and leave the
 * default {@link serializeTransfer} (which delegates back) untouched. Adopters
 * who need shape-specific formatting override both independently.
 *
 * Neither method requires the input to be the grammar root — the walker is
 * recursive and shape-agnostic, so any element from either tree serializes
 * correctly. Callers typically pass a root (that's what
 * `ModelService.serialize`
 * and the GLSP source-model flows hand in), but sub-tree serialization works
 * for unit tests, snippet rendering, and tooling.
 */
export interface Serializer<TAst extends AstNode = AstNode, TTransfer extends TransferElement = TransferElement> {
   /**
    * Serialize a Langium AST element — cross-references are `Reference<T>`
    * objects. Typically the grammar root, but any AST node works.
    *
    * Returns {@link MaybePromise} so adopters with async needs (remote schema
    * lookup, external canonical-value resolution, third-party async formatter)
    * can return a `Promise<string>`. Sync implementations return a bare string
    * directly — the union widening is non-breaking. Callers gate with
    * `isPromiseLike` or naive `await` per the framework house
    * style (guard in hot loops, naive `await` for one-shot calls).
    */
   serializeAst(model: TAst): MaybePromise<string>;

   /**
    * Serialize a transfer-model element — cross-references are plain `string`
    * ids (the values `Reference.$refText` would return on an AST node).
    * Typically the transfer root, but any transfer element works.
    *
    * The default implementation on `AbstractSerializer`
    * delegates to {@link serializeAst} because the underlying property walker
    * is shape-agnostic — both shapes flow through the same
    * `serializePropertyValue` dispatch with the same `serializeReferenceText` read.
    * Adopters who need shape-specific formatting override this method
    * independently.
    */
   serializeTransfer(model: TTransfer): MaybePromise<string>;
}
