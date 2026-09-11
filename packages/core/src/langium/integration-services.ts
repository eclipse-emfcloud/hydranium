/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { type DeepPartial, inject, type Module } from '@hydranium/langium';
import {
   createDefaultModule,
   createDefaultSharedModule,
   type LangiumServices,
   type LangiumSharedServices,
   type PartialLangiumServices,
   type PartialLangiumSharedServices
} from '@hydranium/langium/lsp';
import { DEFAULT_EAGER_SERVICES, bootstrapLangiumLanguages } from './bootstrap.js';
import { createServerLanguageModule } from './language-module.js';
import { createServerSharedModule, type ServerModuleContext } from './module.js';
import type { ServerSharedServicesMinimal } from './shared-services.js';

/**
 * Options accepted by {@link createIntegrationServices}. Wraps the
 * canonical Langium module-composition chain that every hydranium
 * adopter writes verbatim — `createDefaultSharedModule` →
 * grammar-generated shared module → `createServerSharedModule` →
 * optional protocol-head shared modules → adopter shared overrides;
 * symmetric on the language side. Both tiers take head modules in the
 * same `extra` position, because a head contributes to whichever tier
 * Langium declares the slot on.
 *
 * Slots that are adopter-specific and don't fit cleanly into the helper
 * — typed-`ServiceRegistry` assignments, Langium validation-check
 * registration, and any other post-bootstrap side effects — stay in the
 * adopter's `createXxxServices` function around the helper call. The
 * helper covers the *composition* boilerplate, not adopter-specific
 * lifecycle.
 */
export interface IntegrationServicesOptions<
   TContext extends ServerModuleContext,
   TShared extends LangiumSharedServices & ServerSharedServicesMinimal,
   TLanguage extends LangiumServices
> {
   /**
    * Shared module-construction context. Flows into the framework's
    * default factories (`createDefaultSharedModule`,
    * `createServerSharedModule`, `createServerLanguageModule`) and into
    * any head-language modules the adopter contributes via `extra`.
    * Adopters with custom context fields (parser worker path, integrity
    * sync mode, custom file-system providers) extend
    * {@link ServerModuleContext} and pass the wider context — the
    * framework factories ignore unknown fields.
    */
   context: TContext;

   /**
    * Shared-services module pair: the grammar's generated module and the
    * adopter's override module. Spread into the shared `inject(...)` in
    * the order:
    * - `createDefaultSharedModule(context)` (Langium baseline)
    * - `generated` (grammar metadata, AST reflection)
    * - `createServerSharedModule(context)` (framework defaults)
    * - ...`extra` (protocol heads — `createLspServerSharedModule(context)`)
    * - `adopter` (adopter overrides — later-wins)
    */
   sharedModules: {
      /**
       * Module emitted by `langium-cli` (grammar metadata, AST reflection).
       *
       * `AstReflection` is a SINGLE shared slot, so in a multi-grammar
       * composition this must be the *combined* generated shared module of
       * ONE `langium-cli` run over all grammars (one `langium-config.json`
       * with several entry grammars). Two independently generated language
       * packages each bind this one slot and the last one wins, leaving the
       * other grammar's types unknown to reflection — `isSubtype` answers
       * false, `getTypeMetaData` is empty, and indexing, reference routing
       * and the transfer encoder all silently miss those types.
       * {@link bootstrapLangiumLanguages} throws when a language's types are
       * wholly absent and warns on a partial gap, because the types cannot
       * express "these modules came from one generator run".
       */
      generated: Module<TShared, PartialLangiumSharedServices>;
      /** Adopter's override module (workspace manager, file-system provider, integrity rules, etc.). */
      adopter: Module<TShared, PartialLangiumSharedServices>;
      /**
       * Additional SHARED modules contributed by protocol heads —
       * `createLspServerSharedModule(context)` from `@hydranium/core/lsp`,
       * future heads' shared modules. Composed *after*
       * `createServerSharedModule` and *before* `adopter`, mirroring
       * `languageModules.extra`.
       *
       * A head needs this tier whenever the slot it binds is shared in
       * Langium rather than per-language — `lsp.DocumentUpdateHandler` is
       * the case that forced this option to exist: it is read off the
       * shared tree by `startLanguageServer`, so a per-language binding of
       * it is silently inert.
       */
      extra?: ReadonlyArray<Module<TShared, PartialLangiumSharedServices>>;
      /**
       * Shared modules composed LAST — after `adopter` — and partial over
       * `TShared` rather than over Langium's shared services.
       *
       * Both differences are the point, and neither is served by
       * {@link extra}. Most framework shared services are constructed with
       * no options (`ModelService: services => new DefaultModelService(services)`),
       * so rebinding the slot is the only way to boot one configured
       * differently; a caller that needs that is usually a test, and the slot
       * it needs is as often a framework ADDITION (`Clock`, `Tracer`,
       * `ProjectManager`) as a Langium one. `extra` can express neither: it
       * is typed `DeepPartial<LangiumSharedServices>`, and it loses to
       * `adopter` on every slot the adopter binds.
       *
       * Kept separate rather than widening `extra` because `extra` is the
       * protocol-head tier, and a head must NOT outrank the adopter. Widening
       * it also does not typecheck — `Module<I, T>` puts `T` in factory
       * return position, so a head module declaring Langium slot types stops
       * being assignable once `T` becomes `DeepPartial<TShared>`.
       *
       * Composing last means an override wins over everything, including the
       * adopter. That is what makes it usable for the slots an adopter binds
       * itself, and why production code should not reach for it.
       */
      overrides?: ReadonlyArray<Module<TShared, DeepPartial<TShared>>>;
   };

   /**
    * Language-services module trio: generated, adopter, and optional
    * extra protocol-head modules. Spread into the language `inject(...)`
    * in the order:
    * - `createDefaultModule({ shared })` (Langium baseline)
    * - `generated` (grammar tokens, parser, etc.)
    * - `createServerLanguageModule(context)` (framework defaults)
    * - ...`extra` (protocol heads — `createLspServerLanguageModule(context)`, future heads)
    * - `adopter`(shared) (adopter overrides — later-wins)
    *
    * The adopter slot is a factory rather than a plain module so it
    * receives the already-injected `shared` services. Adopters with
    * context-dependent slot bindings (e.g. a parser-worker path
    * conditional) close over the wider context in the factory.
    */
   languageModules: {
      /** Module emitted by `langium-cli` (parser, tokens, grammar access). */
      generated: Module<TLanguage, PartialLangiumServices>;
      /**
       * Adopter's override module, constructed against the resolved
       * shared services. Plain-module adopters with no shared-services
       * dependency at construction time write `() => MyLanguageModule`.
       */
      adopter: (shared: TShared) => Module<TLanguage, PartialLangiumServices>;
      /**
       * Additional language modules contributed by protocol heads —
       * `createLspServerLanguageModule(context)` from
       * `@hydranium/core/lsp`, future `createGlspServerLanguageModule`
       * from `@hydranium/glsp-server`, etc. Composed *after*
       * `createServerLanguageModule` and *before* `adopter` so
       * head defaults win over framework defaults but adopter overrides
       * still win over heads.
       */
      extra?: ReadonlyArray<Module<TLanguage, PartialLangiumServices>>;
      /**
       * Modules composed LAST, after `adopter`, and partial over `TLanguage`
       * rather than over Langium's per-language services. The language-tier
       * twin of {@link IntegrationServicesOptions.sharedModules}'s
       * `overrides`, and both differences carry the same weight they do
       * there.
       *
       * A per-language framework service is constructed by the framework's
       * own module with no options
       * (`IntegrityService: services => new DefaultIntegrityService(services)`),
       * so booting one configured differently means rebinding the slot.
       * {@link extra} serves neither half of that: it composes BEFORE
       * `adopter` and so loses every slot the adopter binds, and it is typed
       * `PartialLangiumServices`, which cannot express a framework ADDITION
       * like `IntegrityService` or `AstExtensionService` at all.
       */
      overrides?: ReadonlyArray<Module<TLanguage, DeepPartial<TLanguage>>>;
   };

   /**
    * Additional languages composed over the SAME shared tier — the
    * multi-grammar case. Each entry gets its own `createDefaultModule({ shared })`
    * → generated → framework-defaults → extra → adopter chain, exactly
    * like {@link languageModules}, and all of them are registered before
    * any slot validation or eager construction runs (see
    * {@link bootstrapLangiumLanguages}).
    *
    * Because the shared tier is common, the `AstDocumentManager`,
    * `IndexManager` and `DocumentBuilder` are shared across languages —
    * which is what lets cross-grammar references resolve through one
    * global index.
    *
    * {@link AdditionalLanguageModules.adopter} and
    * {@link AdditionalLanguageModules.extra} default to the primary
    * language's, so a second grammar that reuses the same service
    * overrides only supplies its own `generated` module.
    *
    * Every grammar composed here must come from ONE `langium-cli` run —
    * see the `generated` note on {@link IntegrationServicesOptions.sharedModules}.
    * The shared `AstReflection` slot cannot hold two independently
    * generated reflections, so separately generated language packages are
    * detected at bootstrap rather than supported.
    *
    * Multi-grammar adopters should also rebind `lsp.configurationRoot`
    * (it defaults to the first registered language's id) and, if they
    * pass non-URI reference sources, override
    * `DataServer.resolveReferenceServices`.
    */
   additionalLanguages?: ReadonlyArray<AdditionalLanguageModules<TShared, TLanguage>>;

   /**
    * Forwarded to {@link bootstrapLangiumLanguages}. Defaults to
    * {@link DEFAULT_EAGER_SERVICES}, which already covers every framework
    * service that must be constructed before the first build; adopters
    * with their own eager targets spread the default into their list.
    */
   eagerlyConstructedServices?: ReadonlyArray<(services: TShared) => unknown>;
}

/**
 * One additional language in a multi-grammar composition. Only
 * {@link generated} is required; the service-override slots fall back to
 * the primary language's, since a second grammar in the same adopter
 * usually reuses the same scope provider, serializer and lexer and
 * differs only in its grammar-generated module.
 */
export interface AdditionalLanguageModules<
   TShared extends LangiumSharedServices & ServerSharedServicesMinimal,
   TLanguage extends LangiumServices
> {
   /**
    * Module emitted by `langium-cli` for this grammar — from the SAME run
    * that produced the primary language's modules and the shared
    * `generated` module, not a separately generated language package.
    */
   generated: Module<TLanguage, PartialLangiumServices>;
   /** Adopter overrides for this language. Defaults to the primary language's. */
   adopter?: (shared: TShared) => Module<TLanguage, PartialLangiumServices>;
   /** Protocol-head modules for this language. Defaults to the primary language's. */
   extra?: ReadonlyArray<Module<TLanguage, PartialLangiumServices>>;
   /** Last-composed overrides for this language. Defaults to the primary language's. */
   overrides?: ReadonlyArray<Module<TLanguage, DeepPartial<TLanguage>>>;
}

/**
 * Compose the standard hydranium Langium DI tree from an adopter's
 * generated + override modules: one shared `inject(...)`, one language
 * `inject(...)` per grammar, then {@link bootstrapLangiumLanguages} — the
 * chain every adopter and every protocol head otherwise writes verbatim.
 * The value is the composition ORDER, which is later-wins throughout:
 * Langium baseline, then generated, then framework defaults, then
 * protocol heads, then adopter overrides, on both tiers.
 *
 * Returns `{ shared, language, languages }`, where `language` is the
 * primary one and `languages` also carries any
 * {@link IntegrationServicesOptions.additionalLanguages}.
 * Adopter-specific post-bootstrap hooks (typed `ServiceRegistry`
 * assignments, `registerValidationChecks(...)`, etc.) stay in the
 * adopter's wrapping `createXxxServices(context)` function around this
 * call — the helper covers composition, not bespoke lifecycle.
 */
export function createIntegrationServices<
   TContext extends ServerModuleContext,
   TShared extends LangiumSharedServices & ServerSharedServicesMinimal,
   TLanguage extends LangiumServices
>(
   options: IntegrationServicesOptions<TContext, TShared, TLanguage>
): { shared: TShared; language: TLanguage; languages: ReadonlyArray<TLanguage> } {
   const {
      context,
      sharedModules,
      languageModules,
      additionalLanguages = [],
      eagerlyConstructedServices = DEFAULT_EAGER_SERVICES
   } = options;

   // Casts on the framework-side modules unify their `Module<T, …>` type
   // parameter with the adopter-supplied `TShared` / `TLanguage`. Langium's
   // `inject(...)` requires every input module to share the same `TServices`;
   // without the casts the compiler refuses to combine
   // `Module<LangiumSharedServices, …>` (from `createDefaultSharedModule`) with
   // `Module<TShared, …>` (the adopter's generated and override modules).
   // Concrete-typed adopter factories (e.g. `createMyLangServices`) sidestep this
   // by casting the `inject(...)` result; here the helper shoulders the cast so
   // every adopter doesn't repeat it.
   const sharedModule = createServerSharedModule(context) as unknown as Module<TShared, PartialLangiumSharedServices>;
   const defaultSharedModule = createDefaultSharedModule(context) as unknown as Module<TShared, PartialLangiumSharedServices>;
   const shared = inject(
      defaultSharedModule,
      sharedModules.generated,
      sharedModule,
      ...(sharedModules.extra ?? []),
      sharedModules.adopter,
      // Last, so an override outranks the adopter too — see `overrides`.
      ...((sharedModules.overrides ?? []) as ReadonlyArray<Module<TShared, PartialLangiumSharedServices>>)
   ) as unknown as TShared;

   // Each language gets its OWN `createDefaultModule({ shared })` — the
   // baseline module is per-language state (parser, lexer, linker), so it
   // cannot be shared between the grammars even though `shared` is.
   const composeLanguage = (
      generated: Module<TLanguage, PartialLangiumServices>,
      adopter: (shared: TShared) => Module<TLanguage, PartialLangiumServices>,
      extra: ReadonlyArray<Module<TLanguage, PartialLangiumServices>>,
      overrides: ReadonlyArray<Module<TLanguage, DeepPartial<TLanguage>>>
   ): TLanguage => {
      const defaultLanguageModule = createDefaultModule({ shared }) as unknown as Module<TLanguage, PartialLangiumServices>;
      const serverLanguageModule = createServerLanguageModule(context) as unknown as Module<TLanguage, PartialLangiumServices>;
      return inject(
         defaultLanguageModule,
         generated,
         serverLanguageModule,
         ...extra,
         adopter(shared),
         // Last, so an override outranks the adopter too — see `overrides`.
         ...(overrides as ReadonlyArray<Module<TLanguage, PartialLangiumServices>>)
      ) as unknown as TLanguage;
   };

   const primaryExtra = (languageModules.extra ?? []) as ReadonlyArray<Module<TLanguage, PartialLangiumServices>>;
   const primaryOverrides = languageModules.overrides ?? [];
   const language = composeLanguage(languageModules.generated, languageModules.adopter, primaryExtra, primaryOverrides);
   const languages = [
      language,
      ...additionalLanguages.map(additional =>
         composeLanguage(
            additional.generated,
            additional.adopter ?? languageModules.adopter,
            additional.extra ?? primaryExtra,
            additional.overrides ?? primaryOverrides
         )
      )
   ];

   // Registers every language before validating slots or building the
   // eager set, so a shared service that reads the registry during
   // construction sees all languages.
   bootstrapLangiumLanguages(shared, languages, eagerlyConstructedServices);

   return { shared, language, languages };
}
