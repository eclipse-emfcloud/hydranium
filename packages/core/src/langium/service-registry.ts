/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import {
   type AstNode,
   AstUtils,
   DefaultServiceRegistry,
   isAstNode,
   type LangiumCoreServices,
   type LangiumSharedCoreServices,
   type LanguageMetaData,
   type ServiceRegistry,
   URI
} from '@hydranium/langium';
import { buildLanguageTypeIndex, type LanguageTypeIndex } from './language-types.js';

/**
 * Anything that identifies the document whose language is wanted: an AST node
 * (routed by the document it lives in), a `URI`, or a URI string.
 *
 * Named because it is a concept rather than an incidental union — "the thing
 * whose own language decides this". `undefined` is deliberately NOT a member:
 * whether a given parameter is optional is a fact about that signature, not
 * about what can identify a document.
 */
export type LanguageTarget = AstNode | URI | string;

declare const ServicesTypeBrand: unique symbol;

/**
 * Phantom-branded subtype of {@link LanguageMetaData} that carries the
 * extended-services type as a compile-time tag. Construct via
 * {@link typedMetadata} from a generated `<Grammar>LanguageMetaData` constant,
 * and pass instances to {@link HydraniumServiceRegistry.getServices} for a
 * fully-inferred return type (no caller-side cast).
 *
 * The brand uses a `unique symbol` member so the type is invariant in
 * `TServices` — `TypedLanguageMetaData<A>` is NOT assignable to
 * `TypedLanguageMetaData<B>` even when `A` and `B` are structurally
 * identical. The brand is optional (`?`) so a bare `LanguageMetaData`
 * literal stays structurally assignable to the underlying interface; only
 * the `TypedLanguageMetaData` view of it has phantom-type teeth.
 */
export interface TypedLanguageMetaData<TServices extends LangiumCoreServices = LangiumCoreServices> extends LanguageMetaData {
   readonly [ServicesTypeBrand]?: TServices;
}

/**
 * Annotate a generated {@link LanguageMetaData} constant with the
 * extended-services type it indexes. Use once per grammar at module
 * scope; the resulting handle is a stable identity for typed
 * `getServices(metadata)` lookups.
 */
export function typedMetadata<TServices extends LangiumCoreServices>(metadata: LanguageMetaData): TypedLanguageMetaData<TServices> {
   return metadata as TypedLanguageMetaData<TServices>;
}

function isLanguageMetaData(arg: unknown): arg is TypedLanguageMetaData<LangiumCoreServices> {
   return typeof arg === 'object' && arg !== null && 'languageId' in arg && 'fileExtensions' in arg;
}

/**
 * Language routing shared by every head. Structural so a registry supplied by
 * an adopter need not inherit the framework implementation.
 */
export interface HydraniumServiceRegistry<TServices extends LangiumCoreServices = LangiumCoreServices> extends ServiceRegistry {
   /**
    * Count successful registrations, including replacement of an already
    * registered language. This is not the number of distinct languages.
    */
   readonly registrations: number;
   /**
    * The currently registered language services, with the same service type as
    * URI lookups.
    */
   readonly all: readonly TServices[];
   /**
    * Register or replace a language and invalidate derived routing results so
    * later lookups see it.
    */
   register(language: TServices): void;
   /**
    * Look up the metadata handle’s language id. Return undefined when that
    * language is unregistered.
    */
   getServices<TMetaServices extends LangiumCoreServices>(metadata: TypedLanguageMetaData<TMetaServices>): TMetaServices | undefined;
   /**
    * Prefer an open document’s registered language id, then file-name and
    * extension routing. Throw when no language answers.
    */
   getServices(uri: URI): TServices;
   /**
    * Route a URI, URI string or an AST node’s owning document. Return undefined
    * for an unrouteable target or a node without a document.
    */
   getServicesFor(target: LanguageTarget | undefined): TServices | undefined;
   /**
    * Return services for the declared language id, or undefined when it is
    * unregistered.
    */
   getServicesById(languageId: string): TServices | undefined;
   /**
    * Return services registered for the extension, or undefined when none
    * match.
    */
   getServicesByExtension(extension: string): LangiumCoreServices | undefined;
   /**
    * Return every registered grammar that can produce the AST type from its
    * entry rule, in registration order. A mentioned but unreachable type is not
    * a match.
    */
   getServicesByType(type: string): readonly TServices[];
   /**
    * Return the only producer of the AST type, or undefined for no producers or
    * an ambiguous result.
    */
   soleServicesByType(type: string): TServices | undefined;
   /**
    * Try the declared language id, then the target’s document, then the only
    * registered language, then the sole producer of the type. Return undefined
    * when no signal resolves.
    */
   getLanguageFor(hint: { readonly languageId?: string; readonly target?: LanguageTarget; readonly type?: string }): TServices | undefined;
}

/**
 * Routes by typed metadata, document identity or producible AST type. URI
 * lookup preserves an open document's declared language before falling back
 * to Langium's file-name and extension routing. The type index is lazy and
 * invalidated on every registration, including replacement of a language.
 */
export class DefaultHydraniumServiceRegistry<TServices extends LangiumCoreServices = LangiumCoreServices>
   extends DefaultServiceRegistry
   implements HydraniumServiceRegistry<TServices>
{
   /**
    * Shared services, held only so `workspace.TextDocuments` can be resolved
    * per lookup instead of at construction.
    */
   protected sharedServices?: LangiumSharedCoreServices;

   /** Backing field for {@link registrations}. */
   protected _registrations = 0;

   /**
    * How many times {@link register} has been called — monotonic, and the
    * cache key a consumer memoising over the registered set should use.
    *
    * `all.length` does not work for that: `register` writes into
    * `languageIdMap` keyed by language id, so RE-registering an id replaces
    * the entry and leaves the length unchanged. A consumer keyed on the count
    * would then keep a cache built from the replaced language's metadata.
    */
   get registrations(): number {
      return this._registrations;
   }

   constructor(services?: LangiumSharedCoreServices) {
      // Deliberately NOT forwarded to `super`. Langium's constructor eagerly
      // dereferences `services.workspace.TextDocuments`, which would make the
      // registry construction-time dependent on it — and that path leads
      // straight back here: TextDocuments → Tracer → Logger →
      // `Settings.value` → `lsp.configurationRoot` → `ServiceRegistry.all`.
      // Langium's injector throws on that cycle ("Cycle detected"). Holding
      // the reference and resolving TextDocuments per lookup keeps Langium's
      // languageId rung (see `getServices`) with no construction-time edge.
      // Latent rather than live for an adopter that binds
      // `lsp.configurationRoot` to a constant, which is exactly the kind of
      // accident that should not be left for the next adopter to hit.
      super();
      this.sharedServices = services;
   }

   /**
    * Supply the shared services after construction, for a registry built
    * without them. Only fills an empty reference — an explicitly constructed
    * one is never replaced. Called by `bootstrapLangiumLanguages` so the
    * languageId rung works regardless of how the adopter's `ServiceRegistry`
    * binding constructed the registry; without it, an adopter rebinding the
    * slot with a zero-argument `new MyRegistry()` would silently lose that
    * rung with nothing to indicate it.
    */
   acceptSharedServices(services: LangiumSharedCoreServices): void {
      this.sharedServices ??= services;
   }

   // Typed-handle overload: primary path, fully inferred.
   override getServices<TMetaServices extends LangiumCoreServices>(
      metadata: TypedLanguageMetaData<TMetaServices>
   ): TMetaServices | undefined;
   // URI overload: preserves Langium's inherited semantics.
   override getServices(uri: URI): TServices;
   override getServices(arg: URI | TypedLanguageMetaData<LangiumCoreServices>): TServices | LangiumCoreServices | undefined {
      if (isLanguageMetaData(arg)) {
         return this.languageIdMap.get(arg.languageId);
      }
      const languageId = this.sharedServices?.workspace.TextDocuments?.get(arg)?.languageId;
      if (languageId !== undefined) {
         const byLanguageId = this.languageIdMap.get(languageId);
         if (byLanguageId) {
            return byLanguageId as TServices;
         }
         // A declared id nothing is registered for (a stale client
         // contribution, a plain-text buffer) is not an error — fall through
         // to the file-name and extension rungs.
      }
      return super.getServices(arg) as TServices;
   }

   /**
    * Every registered language's services, typed as `TServices` like the
    * lookups here rather than as Langium's base shape, so a sweep of the whole
    * set reaches what a URI or a typed handle would have given it.
    *
    * The cast is sound because {@link register} is the only way a language
    * enters and takes `TServices`; the inherited accessor is typed to Langium's
    * base, which is the only reason one is needed.
    */
   override get all(): readonly TServices[] {
      return super.all as readonly TServices[];
   }

   /**
    * Lookup by anything that identifies a document — an AST node (routed by
    * the document it lives in), a `URI`, or a URI string. `undefined` when the
    * node has no document, or nothing routes the URI.
    *
    * **Abstains rather than throws**, unlike the inherited `getServices(uri)`.
    * Throwing is right for a build pipeline, which must have a language for
    * every document it builds, and wrong for a caller asking an optional
    * question about an arbitrary target: a foreign reference target, a
    * synthetic node, a directory URI. Same contract as
    * {@link getServicesById}.
    *
    * **The per-target lookup belongs here, not at the call sites.** The thing
    * to apply to a node is decided by the node's OWN document, and a caller
    * that captures one provider and reuses it across nodes derives names and
    * keys under the wrong grammar's `nameProperties` / `nameSeparator` the
    * moment two languages differ — silently, since the result is a
    * plausible-looking string. Hand-rolling the three steps (node to root
    * document, abstain on miss, one ladder walk not two) is what let that
    * defect recur; being a registry method makes the correct call the
    * discoverable one, and the generic `TServices` return means no call site
    * needs a cast.
    *
    * One walk of the lookup ladder: Langium implements `hasServices` as a
    * try/catch around `getServices`, so the obvious `hasServices(uri) &&
    * getServices(uri)` pair costs two walks on the happy path — and these are
    * bulk paths, once per indexed node or serialised reference.
    */
   getServicesFor(target: LanguageTarget | undefined): TServices | undefined {
      const uri = isAstNode(target) ? AstUtils.findRootNode(target).$document?.uri : target;
      if (uri === undefined) {
         return undefined;
      }
      try {
         return this.getServices(typeof uri === 'string' ? URI.parse(uri) : uri);
      } catch {
         return undefined;
      }
   }

   /**
    * Lookup by raw `languageId` string. Returns `undefined` when no
    * services have been registered for the id (vs. the URI overload's
    * inherited Langium semantics, which throws on miss). Used for
    * dynamically-routed lookups where the language id comes from
    * external input.
    *
    * The cast is sound because {@link register} is the only way a language
    * enters and takes `TServices`; `languageIdMap` is inherited and typed to
    * Langium's base, which is the only reason one is needed.
    */
   getServicesById(languageId: string): TServices | undefined {
      return this.languageIdMap.get(languageId) as TServices | undefined;
   }

   /**
    * Lookup by file extension. Returns `undefined` when no services match.
    * Useful for routing decisions that need to dispatch on file extension
    * before a URI is available.
    */
   getServicesByExtension(extension: string): LangiumCoreServices | undefined {
      return this.fileExtensionMap.get(extension);
   }

   /**
    * Every registered language whose grammar can PRODUCE `type`, in
    * registration order. Empty when none can; more than one when several do
    * (types reached through a grammar they both import).
    *
    * Returns the list rather than a single answer on purpose: "no language
    * produces this" and "four do" are different facts, and a caller needs to
    * tell them apart both to explain itself and to decide whether to fall
    * through to another signal. The registry answers the fact; the head owns
    * the policy. {@link soleServicesByType} is the shorthand for the common
    * policy.
    *
    * Attribution is *produced, not mentioned* and *reachable from the entry
    * rule, not merely present* — see `collectProducibleTypes`.
    */
   getServicesByType(type: string): readonly TServices[] {
      return this.typeIndex.languagesFor(type);
   }

   /**
    * The single language that can produce `type`, or `undefined` when none
    * can or several can. The common policy over {@link getServicesByType}:
    * an ambiguous type does not identify a language, so abstaining is the
    * honest answer rather than taking the first.
    */
   soleServicesByType(type: string): TServices | undefined {
      const owners = this.getServicesByType(type);
      return owners.length === 1 ? owners[0] : undefined;
   }

   /**
    * The language the strongest signal given names: a declared `languageId`,
    * then `target`'s document, then the only registered language, then the sole
    * producer of `type`. `undefined` when none answers, which leaves the
    * fallback to the caller, since it differs per caller.
    *
    * A declared id comes first because every later signal is inferred, and an
    * inference must not override a caller that said which grammar it means.
    */
   getLanguageFor(hint: { readonly languageId?: string; readonly target?: LanguageTarget; readonly type?: string }): TServices | undefined {
      const declared = hint.languageId === undefined ? undefined : this.getServicesById(hint.languageId);
      const located = declared ?? this.getServicesFor(hint.target);
      if (located) {
         return located;
      }
      const all = this.all;
      if (all.length === 1) {
         return all[0];
      }
      return hint.type === undefined ? undefined : this.soleServicesByType(hint.type);
   }

   /**
    * Drop the memoised type index, so a language registered after the first
    * type lookup is accounted for. The reason this index belongs on the
    * registry rather than in a consumer's private memo: the registry is the
    * one place that knows when the registered set changed.
    */
   override register(language: TServices): void {
      super.register(language);
      this._registrations++;
      this._typeIndex = undefined;
   }

   protected _typeIndex?: LanguageTypeIndex<TServices>;

   /**
    * Type → language index over the registered grammars, built on first use.
    * Lazy because a grammar walk per language is not free and most lookups
    * never need it; invalidated by {@link register}.
    */
   protected get typeIndex(): LanguageTypeIndex<TServices> {
      return (this._typeIndex ??= buildLanguageTypeIndex(this.all as readonly TServices[]));
   }
}
