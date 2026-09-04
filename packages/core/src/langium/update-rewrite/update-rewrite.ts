/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { type MaybePromise, type TransferElement } from '@hydranium/protocol';
import { type AstNode } from '@hydranium/langium';
import { type RegistryItem } from '../../util/registry.js';

/**
 * A single transform applied to the incoming transfer model on the structured
 * (object) write path of `ModelService.update` / `ModelService.save`, before
 * serialisation. The RPC-update-stage sibling of `IntegrityRule` /
 * `AstExtension` / `ValidationCheck` — same id-keyed,
 * priority-ordered registry shape, but it runs on the transfer model rather
 * than the built AST, and only on structured writes (never the LSP text path).
 *
 * **Two representations.** The contract is deliberately asymmetric — `model`
 * and `previous` are NOT the same shape, and the types say so:
 *
 * - `model` (and the return) is a **transfer model**: cross-references are
 *   flattened to `$refText` strings, derived `_*` properties are folded in as
 *   *enumerable* fields, and there are no `$container` back-pointers. It is the
 *   plain JSON that arrived over RPC from the form / diagram.
 * - `previous` is a live **AST root** (`document.parseResult.value`): real
 *   `Reference` objects, `$container`, and `_*` attached *non-enumerably* by the
 *   AST-extension service. It is `undefined` for a not-yet-built document.
 *
 * A rewrite that needs to diff against the previous state owns the
 * representation reconciliation itself (text-vs-`Reference`, enumerable-vs-not).
 * The framework provides no comparison helper — comparison is grammar-specific
 * policy.
 *
 * **Ordering** is by {@link RegistryItem.priority} ascending, ties broken by
 * registration order — so a normalisation pass (low priority) reliably runs
 * before a diff-based reconciliation (higher priority).
 *
 * **Sync fast path.** `rewrite` may return a promise (mirrors
 * `IntegrityRule.enforce`) so an adopter rewrite that consults an external
 * system isn't forced sync; the service keeps purely-sync rewrites — the common
 * case — off the microtask queue.
 *
 * Generic over `<TTransfer, TAst>` so each adopter narrows to its own transfer
 * and AST root types; both default to the structural bases.
 */
export interface UpdateRewrite<TTransfer extends TransferElement = TransferElement, TAst extends AstNode = AstNode> extends RegistryItem {
   /**
    * Rewrite the incoming transfer model. Return the input unchanged when the
    * rewrite does not apply (the common no-op case).
    *
    * `previous` is the AST as it stood before this update — read-only; never
    * mutate it. It is `undefined` for a brand-new document, which a diff-based
    * rewrite should treat as "every field is new" (the maximal change case).
    */
   rewrite(model: TTransfer, previous: TAst | undefined): MaybePromise<TTransfer>;
}
