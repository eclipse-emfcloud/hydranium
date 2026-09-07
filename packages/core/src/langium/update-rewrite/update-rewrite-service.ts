/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { isPromiseLike, type TransferElement, type Tracer } from '@hydranium/protocol';
import { type AstNode, interruptAndCheck } from '@hydranium/langium';
import { type CancellationToken, type Disposable } from 'vscode-languageserver';
import { type LogNameOptions } from '../diagnostics/logger.js';
import { type ServerLanguageServices } from '../language-module.js';
import { Registry } from '../../util/registry.js';
import { type UpdateRewriteRegistry } from './update-rewrite-contribution.js';
import { type UpdateRewrite } from './update-rewrite.js';

/**
 * Public contract for the per-language update-rewrite runner. Extends the
 * {@link UpdateRewriteRegistry} (the imperative `register` surface
 * contributions use) with the {@link apply} entry point
 * `ModelService.rewriteModel` calls on the structured write path, before
 * serialisation.
 *
 * Adopter overrides go through {@link DefaultUpdateRewriteService}; the
 * interface keeps the public API stable while internals (the registry) stay
 * `protected` on the default class.
 *
 * Generic over `<TTransfer, TAst>` so each consumer plugs in their own transfer
 * and AST root types; both default to the structural bases.
 */
export interface UpdateRewriteService<
   TTransfer extends TransferElement = TransferElement,
   TAst extends AstNode = AstNode
> extends UpdateRewriteRegistry<TTransfer, TAst> {
   /** Remove a rewrite by id. Returns `true` if a rewrite was removed. */
   unregister(id: string): boolean;
   /**
    * Run every registered rewrite in priority order, threading the model
    * through each, and return the rewritten transfer model. Always async (the
    * method is called once per `update`, not per node), but a synchronous
    * rewrite never adds a microtask — see {@link DefaultUpdateRewriteService.apply}.
    *
    * `cancelToken` is honoured between rewrites — material when a rewrite is
    * async (an external lookup); a preempted update aborts the chain before the
    * next rewrite rather than running it to completion against a doomed build.
    */
   apply(model: TTransfer, previous: TAst | undefined, cancelToken?: CancellationToken): Promise<TTransfer>;
}

/**
 * Construction options for {@link DefaultUpdateRewriteService}. All fields
 * optional — the defaults reproduce the framework's behaviour exactly.
 */
export type UpdateRewriteServiceOptions = LogNameOptions;

/**
 * Default {@link UpdateRewriteService} implementation. A pure ordered registry
 * of transfer-model transforms; the framework ships **zero** members (an empty
 * chain is a no-op). Adopters declare rewrites via
 * `UpdateRewriteContribution`s under the `updateRewrite.rewrites` group,
 * or register imperatively.
 *
 * **Per-language service.** Bound in the per-language module and resolved by
 * `ModelService` via `ServiceRegistry.getServices(uri)`, so multi-grammar
 * workspaces route each write to the right rewrite set.
 *
 * The framework provides no comparison helper and no previous-state accessor —
 * a diff-based rewrite owns its own representation reconciliation (see
 * {@link UpdateRewrite}).
 */
export class DefaultUpdateRewriteService<
   TTransfer extends TransferElement = TransferElement,
   TAst extends AstNode = AstNode
> implements UpdateRewriteService<TTransfer, TAst> {
   /** Registry of rewrites, keyed by id, iterated in priority order. */
   protected readonly rewrites = new Registry<UpdateRewrite<TTransfer, TAst>>();
   protected readonly tracer: Tracer;

   constructor(
      protected readonly services: ServerLanguageServices,
      options: UpdateRewriteServiceOptions = {}
   ) {
      this.tracer = services.shared.Tracer.for(options.logName ?? 'UpdateRewrite').trace('instantiated');

      // Read the language's UpdateRewriteContribution group and let each
      // contribution register one or many rewrites through this service.
      // Optional chaining tolerates incomplete test stubs; production wiring
      // always provides the slot via `createServerLanguageModule`.
      const contributions = services.updateRewrite?.rewrites ?? {};
      for (const contribution of Object.values(contributions)) {
         contribution.registerUpdateRewrites(this);
      }
   }

   register(rewrite: UpdateRewrite<TTransfer, TAst>): Disposable {
      return this.rewrites.register(rewrite);
   }

   unregister(id: string): boolean {
      return this.rewrites.unregister(id);
   }

   /**
    * Fold the model through every rewrite in priority order. Mirrors the
    * `DefaultIntegrityService.enforceIntegrity` pattern: the method is
    * `async` (one tick per `update`, which is a per-operation call, not a
    * per-node hot loop), and the per-rewrite {@link isPromiseLike} check skips
    * the `await` for synchronous rewrites — the common case — so a sync chain
    * adds no extra microtask beyond the single tick `async` already costs.
    *
    * `cancelToken` is checked before each rewrite (coarser than within a
    * rewrite, finer than per-chain) so a preempted async chain interrupts
    * cleanly — `interruptAndCheck` throws `OperationCancelled`, which aborts the
    * `update` before any text is applied.
    */
   async apply(model: TTransfer, previous: TAst | undefined, cancelToken?: CancellationToken): Promise<TTransfer> {
      let current = model;
      for (const rewrite of this.rewrites.all()) {
         if (cancelToken !== undefined) {
            await interruptAndCheck(cancelToken);
         }
         const result = rewrite.rewrite(current, previous);
         current = (isPromiseLike(result) ? await result : result) as TTransfer;
      }
      return current;
   }
}
