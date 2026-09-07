/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import {
   type ContainerContext,
   DiagramConfiguration,
   GLSPClientContribution,
   type GLSPDiagramManager,
   GLSPDiagramWidget,
   GLSPTheiaFrontendModule,
   registerDiagramManager
} from '@eclipse-glsp/theia-integration';
import { type GLSPDiagramLanguage } from '@eclipse-glsp/theia-integration/lib/common';
import { bindLogLevelPreference } from '@hydranium/client-theia/lib/browser';
import type { interfaces } from '@theia/core/shared/inversify';
import { HydraniumGlspDiagramWidget } from './diagram-widget';

/**
 * Sentinel returned from {@link AbstractHydraniumGlspTheiaFrontendModule.bindClientContribution}
 * to mean "this module deliberately does not bind a GLSPClientContribution"
 * — used for secondary diagram types that share a GLSP server with a
 * primary diagram type whose module already bound the contribution. The
 * override becomes a no-op rather than the framework default.
 */
export const SkipClientContribution = Symbol.for('@hydranium/glsp-client-theia#SkipClientContribution');
export type SkipClientContribution = typeof SkipClientContribution;

/**
 * `GLSPTheiaFrontendModule` subclass that factors out the method overrides
 * every adopter writes verbatim (`bindDiagramConfiguration` /
 * `bindGLSPClientContribution` / `configureDiagramManager`) into hook methods
 * reading from abstract fields.
 *
 * Adopters subclass and provide:
 *  - {@link diagramLanguage} (declared `abstract` on the base class but
 *    `readonly` on the base type — `GLSPTheiaFrontendModule` requires it)
 *  - {@link diagramConfiguration} — the adopter's `DiagramConfiguration`
 *  - {@link diagramManager} — the adopter's `GLSPDiagramManager` subclass
 *
 * Optional override hook:
 *  - {@link bindClientContribution} — return a `Newable<GLSPClientContribution>`
 *    to bind it (the common case), {@link SkipClientContribution} to
 *    bypass binding entirely (secondary diagrams), or `undefined` to
 *    defer to `super.bindGLSPClientContribution(context)`. Default
 *    returns `undefined` (framework default).
 *
 * Adopter-specific customisation that stays as `override` on the subclass:
 *  - `bindDiagramWidgetFactory` — custom `GLSPDiagramWidget` rebinds
 *  - `configure` — LibAvoid initialiser, color contribution, startup hooks
 *  - `enableLayoutCommands` / `enableMarkerNavigationCommands` — flags
 *
 * Abstract base class + adopter subclass with concrete fields, following the
 * GLSP module convention. No `Default*` concrete sibling because the abstract
 * fields have no sane defaults — every adopter must provide them.
 */
export abstract class AbstractHydraniumGlspTheiaFrontendModule extends GLSPTheiaFrontendModule {
   /** Wire-format identifiers + file routing — required by the base. */
   abstract override readonly diagramLanguage: GLSPDiagramLanguage;

   /** Adopter's `DiagramConfiguration` class. Bound via `bindDiagramConfiguration`. */
   protected abstract readonly diagramConfiguration: interfaces.Newable<DiagramConfiguration>;

   /** Adopter's `GLSPDiagramManager` class. Bound + registered via `configureDiagramManager`. */
   protected abstract readonly diagramManager: interfaces.Newable<GLSPDiagramManager>;

   /**
    * Theia preference id driving the framework log threshold, e.g.
    * `'my-language.log.level'`. When set, {@link initialize} binds
    * `LogLevelPreferenceContribution` so the level is applied at
    * application start and kept in sync on change.
    *
    * It belongs here rather than beside the channel name in
    * `createGlspClientTheiaModule`'s options because the two have different
    * scopes: the channel is per diagram container, while the threshold is a
    * process-global and must be applied once, from the frontend container.
    */
   protected readonly logLevelPreference?: string;

   /**
    * Hook returning the {@link GLSPClientContribution} class the framework
    * should bind for this diagram module:
    *  - `undefined` (default) — invoke `super.bindGLSPClientContribution(context)`
    *  - a `Newable<GLSPClientContribution>` — bind it to-self singleton + bind
    *    `GLSPClientContribution` to the service
    *  - {@link SkipClientContribution} — no-op (secondary diagrams sharing
    *    a GLSP server with a primary diagram whose module already bound
    *    the contribution)
    */
   protected bindClientContribution(): interfaces.Newable<GLSPClientContribution> | SkipClientContribution | undefined {
      return undefined;
   }

   /**
    * Adds the framework's frontend-scoped bindings on top of the base wiring.
    *
    * Overrides `initialize` — the base's own orchestrator — rather than
    * `configure`, which is documented as the *adopter's* hook: a subclass that
    * overrides `configure` and forgets `super.configure(context)` would otherwise
    * silently lose these bindings.
    */
   override initialize(context: ContainerContext): void {
      super.initialize(context);
      if (this.logLevelPreference) {
         bindLogLevelPreference(context.bind, this.logLevelPreference);
      }
   }

   override bindDiagramConfiguration(context: ContainerContext): void {
      context.bind(DiagramConfiguration).to(this.diagramConfiguration);
   }

   override bindGLSPClientContribution(context: ContainerContext): void {
      const contribution = this.bindClientContribution();
      if (contribution === SkipClientContribution) {
         return;
      }
      if (contribution === undefined) {
         super.bindGLSPClientContribution(context);
         return;
      }
      context.bind(contribution).toSelf().inSingletonScope();
      context.bind(GLSPClientContribution).toService(contribution);
   }

   override configureDiagramManager(context: ContainerContext): void {
      context.bind(this.diagramManager).toSelf().inSingletonScope();
      registerDiagramManager(context.bind, this.diagramManager, false);
   }

   /**
    * Binds the framework diagram widget on top of the base factory wiring, so
    * every hydranium head gets the loading overlay.
    *
    * `super` binds `GLSPDiagramWidget` to itself (via `lazyBind`, a no-op when
    * already bound) plus the `DiagramWidgetFactory`; the rebind then points the
    * same token at the subclass, leaving the factory untouched.
    *
    * Unconditional on purpose. {@link HydraniumGlspDiagramWidget} differs from
    * GLSP's widget only by the overlay, so there is no flag here: an adopter that
    * wants different behaviour overrides the widget (opt out of the overlay by
    * no-op'ing `showLoadingOverlay`), and one that wants its own subclass rebinds
    * this token again after calling `super`. A module-level flag gating the
    * rebind would be worse than useless: it decides which CLASS to bind, so an
    * adopter subclassing the framework widget and setting the flag to `false`
    * still gets the overlay, and the flag's name lies.
    */
   override bindDiagramWidgetFactory(context: ContainerContext): void {
      super.bindDiagramWidgetFactory(context);
      context.rebind(GLSPDiagramWidget).to(HydraniumGlspDiagramWidget);
   }
}
