/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { DiagramModule } from '@eclipse-glsp/server';
import { injectable, type interfaces } from 'inversify';
import type { LanguageMetaData } from '@hydranium/langium';
import { type ServerLanguageServices, type ServerSharedServices, typedMetadata } from '@hydranium/core';
import { HydraniumTypes } from '../state/hydranium-shared-core-services.js';

/**
 * Bind {@link HydraniumTypes}.DiagramLanguage on a GLSP **session** container
 * to the services of `metadata`'s grammar.
 *
 * Exported separately from {@link AbstractHydraniumGlspDiagramModule} for adopters
 * whose diagram module already extends an intermediate base of their own and
 * cannot take the framework base class; call it from `configure` after
 * `super.configure(...)`. The base class is the preferred entry point because
 * it makes the declaration non-optional.
 *
 * **Why the session tier.** GLSP builds its app container once per process,
 * before any document exists, so a per-language service bound there can only
 * ever be one grammar's. The session container is created per open diagram
 * with its `diagramType` known, and a diagram type has exactly one grammar —
 * so the language is a static fact about the module, resolvable with no URI
 * and no ordering hazard. That last part is load-bearing: GLSP's
 * `OperationHandlerRegistryInitializer` constructs every operation handler at
 * `InitializeClientSession`, i.e. BEFORE `RequestModelAction` supplies the
 * source URI, so anything derived from `ModelState.sourceUri` at injection
 * time would throw on every diagram open.
 *
 * **The whole language, not pre-resolved providers.** There is deliberately no
 * token for an individual per-language provider; see {@link HydraniumTypes} for
 * why. Callers reach `modelState.diagramLanguage` or
 * `modelState.languageServicesFor(node)` instead, which name the choice.
 *
 * Resolution is `toDynamicValue` + `inSingletonScope` — deferred so the parent
 * container's `SharedCoreServices` is available, then resolved once per
 * session rather than per injection.
 */
export function bindDiagramLanguage(bind: interfaces.Bind, metadata: LanguageMetaData): void {
   bind(HydraniumTypes.DiagramLanguage)
      .toDynamicValue(context => resolveDiagramLanguage(context.container, metadata))
      .inSingletonScope();
}

/**
 * The registered services for `metadata`'s language, or a throw naming both
 * the declared id and the registered ones.
 *
 * Failing loudly is the point: the declared language is the one fact this
 * module states that the grammar does not, so it can drift. An unregistered id
 * means the adopter declared a language they never registered — a wiring
 * mistake whose silent form (falling back to some other grammar's providers)
 * would surface much later as references that resolve against the wrong scope.
 */
function resolveDiagramLanguage(container: interfaces.Container, metadata: LanguageMetaData): ServerLanguageServices {
   const registry = container.get<ServerSharedServices>(HydraniumTypes.SharedCoreServices).ServiceRegistry;
   const language = registry.getServices(typedMetadata<ServerLanguageServices>(metadata));
   if (!language) {
      const registered = registry.all.map(candidate => candidate.LanguageMetaData.languageId);
      throw new Error(
         `Diagram module declares language '${metadata.languageId}', which is not registered on the ServiceRegistry. ` +
            `Registered languages: ${registered.length > 0 ? registered.join(', ') : '(none)'}. ` +
            'Declare the languageId of a grammar passed to bootstrapLangiumLanguages.'
      );
   }
   return language;
}

/**
 * GLSP {@link DiagramModule} base that declares which grammar its diagram type
 * edits, and binds that language's per-language services on the session
 * container.
 *
 * Subclass instead of `DiagramModule` and implement {@link declareLanguage}
 * alongside `diagramType`; the two are the same kind of fact about a diagram
 * type, and pairing them is what lets one GLSP head serve N grammars.
 *
 * Adopter GLSP components then read the language they mean:
 * `modelState.diagramLanguage.references.CandidateProvider` for a reference
 * written on the canvas, `modelState.languageServicesFor(node).references.X`
 * for anything reached through a reference. No per-language service is bound
 * to a token of its own — see {@link bindDiagramLanguage} for why.
 */
@injectable()
export abstract class AbstractHydraniumGlspDiagramModule extends DiagramModule {
   /**
    * The `LanguageMetaData` of the grammar this diagram type edits — pass the
    * generated `<Grammar>LanguageMetaData` constant directly.
    *
    * Abstract rather than optional so a new diagram module cannot silently
    * omit it: a missing declaration is a compile error here, where the fix is
    * obvious, instead of an unbound-token failure at the first diagram open.
    *
    * NOT named `bindLanguage`: every `bindX()` on GLSP's `DiagramModule`
    * returns a `BindingTarget<T>` that GLSP's own `configure` consumes, and a
    * method in that family returning a `LanguageMetaData` invites
    * `{ service: … }`. This one states a fact; the framework does the binding.
    */
   protected abstract declareLanguage(): LanguageMetaData;

   protected override configure(
      bind: interfaces.Bind,
      unbind: interfaces.Unbind,
      isBound: interfaces.IsBound,
      rebind: interfaces.Rebind
   ): void {
      super.configure(bind, unbind, isBound, rebind);
      bindDiagramLanguage(bind, this.declareLanguage());
   }
}
