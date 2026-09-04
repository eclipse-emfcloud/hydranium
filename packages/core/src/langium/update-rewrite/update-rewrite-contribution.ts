/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { type Disposable } from 'vscode-languageserver';
import { type AstNode } from '@hydranium/langium';
import { type TransferElement } from '@hydranium/protocol';
import { type UpdateRewrite } from './update-rewrite.js';

/**
 * Registry handed to an {@link UpdateRewriteContribution}. Implemented by the
 * update-rewrite service; a contribution receives it and registers one or many
 * rewrites. Doubles as the low-level imperative API for the rare
 * runtime-dynamic registration case.
 *
 * Generic over `<TTransfer, TAst>` for the same reason {@link UpdateRewrite} and
 * `UpdateRewriteService` are: an adopter that narrows to its own root types gets
 * a `rewrite` callback whose `model` and `previous` are already its types, so a
 * registration needs no cast at all. Both default to the structural bases, so
 * every existing call site keeps compiling unchanged.
 */
export interface UpdateRewriteRegistry<TTransfer extends TransferElement = TransferElement, TAst extends AstNode = AstNode> {
   register(rewrite: UpdateRewrite<TTransfer, TAst>): Disposable;
}

/**
 * Declarative registration of update rewrites. Bound under the module's
 * `updateRewrite.rewrites` contribution group (a
 * `Record<string, UpdateRewriteContribution>`); the update-rewrite service
 * reads its own group at construction and calls this method, handing itself in
 * as the registry.
 *
 * The domain-qualified method name lets a single cross-cutting class implement
 * several contribution interfaces (e.g. also `IntegrityRuleContribution`)
 * without method collision — bind it once and reference it from each group.
 */
export interface UpdateRewriteContribution<TTransfer extends TransferElement = TransferElement, TAst extends AstNode = AstNode> {
   registerUpdateRewrites(registry: UpdateRewriteRegistry<TTransfer, TAst>): void;
}
