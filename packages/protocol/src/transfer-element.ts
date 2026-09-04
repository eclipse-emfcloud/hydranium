/********************************************************************************
 * Copyright (c) 2023-2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * Base shapes for the transfer-model overlay generated per consumer language.
 *
 * Every node in a generated transfer model extends {@link TransferElement} and
 * cross-references between nodes serialise as plain strings. These types carry no
 * language-specific knowledge — language-specific types live in the consumer's
 * generated `transfer-model.ts` overlay, emitted by the code generator from
 * the consumer's grammar.
 */

/** Base type of every transfer-model node — carries the AST type discriminator. */
export interface TransferElement {
   readonly $type: string;
}

/**
 * Type-level lookup: given an AST node type `T` (with a string-literal
 * `$type` discriminator from Langium's generated AST) and a per-grammar
 * `TTransferMap` overlay keyed by those `$type` strings, resolve to the
 * declared wire shape — or fall back to the structural base
 * {@link TransferElement} when no entry is declared.
 *
 * Adopters declare the overlay by interface merging or by generating an
 * interface keyed on those `$type` strings. Types not in the overlay resolve to
 * `TransferElement` — the framework default behaves correctly without an
 * overlay (no autocomplete, but no compile error either).
 *
 * The lookup is compile-time only; no runtime cost.
 */
export type TransferTypeFor<TAst extends { readonly $type: string }, TTransferMap> = TAst['$type'] extends keyof TTransferMap
   ? TTransferMap[TAst['$type']] extends TransferElement
      ? TTransferMap[TAst['$type']]
      : TransferElement
   : TransferElement;
