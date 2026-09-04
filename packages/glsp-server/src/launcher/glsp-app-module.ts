/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { GLSPModule } from '@eclipse-glsp/server';
import type { BindingContext } from '@eclipse-glsp/protocol/lib/di/inversify-util.js';
import type { ServerSharedServices } from '@hydranium/core';
import { type ConflictResolver, ReconcilingConflictResolver } from '@hydranium/protocol';
import { injectable, type interfaces } from 'inversify';
import { HydraniumTypes } from '../state/hydranium-shared-core-services.js';

/**
 * Configuration accepted by {@link HydraniumGlspAppModule}. Bundles the
 * framework-defined Inversify bindings every adopter wires verbatim in their
 * GLSP server app-module (the `appModules` argument to `startGlspServer`).
 *
 * **App tier only, so nothing per-language belongs here.** This module is
 * loaded into the one-per-process app container, built before any document
 * exists — it cannot know which grammar a request concerns. Per-language
 * services are declared per diagram type instead; see
 * `AbstractHydraniumGlspDiagramModule`.
 */
export interface HydraniumGlspAppModuleOptions<TShared extends ServerSharedServices = ServerSharedServices> {
   /**
    * The framework's Langium-style shared services tree. Bound to the
    * `HydraniumTypes.SharedCoreServices` symbol that framework state /
    * index classes (`AbstractHydraniumGlspState`, `HydraniumGlspIndex`) `@inject`.
    *
    * Generic over `TShared` so adopters with their own narrower
    * shared-services type (an adopter-specific type extending
    * `ServerSharedServices` with extra slots) preserve that
    * type at `this.options.shared` inside subclass methods without an
    * explicit cast. The Inversify symbol binding still types `@inject`
    * sites as the wider `ServerSharedServices`; specialise the binding
    * with an adopter-specific symbol where injected components want the
    * narrower view.
    */
   readonly shared: TShared;

   /**
    * Optional {@link ConflictResolver} policy bound to the
    * `HydraniumTypes.ConflictResolver` symbol that `AbstractHydraniumGlspState`
    * injects. Omit to get the framework default
    * ({@link ReconcilingConflictResolver} — field-level three-way merge);
    * pass a `ForceConflictResolver` for
    * last-writer-wins, or a custom resolver. Applies uniformly to every
    * conflict site (forward-write, undo, redo, save).
    */
   readonly conflictResolver?: ConflictResolver;
}

/**
 * DI module that provides the framework-level Inversify bindings every
 * `@hydranium/glsp-server` adopter needs. Pass instances (or instances of
 * subclasses with additional bindings) into `startGlspServer`'s
 * `appModules` array.
 *
 * Bindings provided:
 *  - `HydraniumTypes.SharedCoreServices` (constant value)
 *  - `HydraniumTypes.ConflictResolver` (constant value — `options.conflictResolver` or a default {@link ReconcilingConflictResolver})
 *
 * Both are language-independent, which is what makes them app-tier. The
 * per-language providers (`ScopeProvider`, `CandidateProvider`) are bound one
 * tier down by `AbstractHydraniumGlspDiagramModule`, from the grammar each
 * diagram type declares.
 *
 * Concrete and usable as-is: adopters that need no extra bindings
 * instantiate {@link HydraniumGlspAppModule} directly. Adopters that do
 * subclass it and override {@link configureAdditionalBindings} to add their
 * own service-identifier carriers.
 *
 * A conventional GLSP module (cf. `@eclipse-glsp/server`'s `GLSPModule`
 * subclasses); the empty `configureAdditionalBindings` hook is the single
 * extension point, so no separate abstract base is needed.
 */
@injectable()
export class HydraniumGlspAppModule<TShared extends ServerSharedServices = ServerSharedServices> extends GLSPModule {
   constructor(protected readonly options: HydraniumGlspAppModuleOptions<TShared>) {
      super();
   }

   protected override configure(
      bind: interfaces.Bind,
      unbind: interfaces.Unbind,
      isBound: interfaces.IsBound,
      rebind: interfaces.Rebind
   ): void {
      bind(HydraniumTypes.SharedCoreServices).toConstantValue(this.options.shared);
      bind(HydraniumTypes.ConflictResolver).toConstantValue(this.options.conflictResolver ?? new ReconcilingConflictResolver());
      this.configureAdditionalBindings({ bind, unbind, isBound, rebind });
   }

   /**
    * Extension point for adopter-specific bindings (service-identifier
    * carriers for the adopter's own language services).
    * Default implementation is empty.
    */
   protected configureAdditionalBindings(_context: BindingContext): void {
      // empty by default
   }
}
