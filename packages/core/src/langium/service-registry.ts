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

/**
 * `DefaultServiceRegistry` whose `register` / `getServices` methods are typed
 * with a consumer-specific extended-services type.
 *
 * Langium's stock `ServiceRegistry` returns the base `LangiumCoreServices`,
 * which forces consumers to cast every time they reach for an extended
 * service. By parameterising the registry with the consumer's full service
 * type, the type narrowing happens at the registry boundary instead of every
 * call site.
 */
export class HydraniumServiceRegistry<TServices extends LangiumCoreServices = LangiumCoreServices> extends DefaultServiceRegistry {
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

   override register(language: TServices): void {
      super.register(language);
      this._registrations++;
   }

   /**
    * Langium's lookup ladder: an open document's declared `languageId`, then
    * its file name, then its extension, then a throw. Because `super` was
    * never given the services it reads `textDocuments` from, its own
    * languageId rung is inert — so this supplies that rung and delegates
    * every rung below it (and the throw) to `super`, rather than restating
    * the ladder.
    *
    * The declared-id rung is what lets an `untitled:` or extensionless
    * document route at all, and what gives an OPEN buffer's declared id
    * precedence over its file extension.
    *
    * It does NOT make two languages that share a file extension workable, and
    * `assertDistinctFileRouting` fails the boot on that configuration: only an
    * open buffer has a declared id, while indexing, scope computation and
    * validation route every CLOSED file in the workspace by extension, where
    * Langium's last-registered-wins would silently hand half the workspace to
    * the wrong grammar.
    */
   override getServices(uri: URI): TServices {
      const languageId = this.sharedServices?.workspace.TextDocuments?.get(uri)?.languageId;
      if (languageId !== undefined) {
         const byLanguageId = this.languageIdMap.get(languageId);
         if (byLanguageId) {
            return byLanguageId as TServices;
         }
         // A declared id nothing is registered for (a stale client
         // contribution, a plain-text buffer) is not an error — fall through
         // to the file-name and extension rungs.
      }
      return super.getServices(uri) as TServices;
   }
}

declare const ServicesTypeBrand: unique symbol;

/**
 * Phantom-branded subtype of {@link LanguageMetaData} that carries the
 * extended-services type as a compile-time tag. Construct via
 * {@link typedMetadata} from a generated `<Grammar>LanguageMetaData` constant,
 * and pass instances to {@link ExtendedServiceRegistry.getServices} for a
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
 * Extended {@link HydraniumServiceRegistry}, adding the lookups the inherited
 * URI-keyed `getServices(uri)` cannot answer:
 *
 * - **Typed metadata handle** — `getServices(metadata: TypedLanguageMetaData<T>)`
 *   returns the registered services typed as `T | undefined`. The primary
 *   path: callers hold a typed handle per grammar (constructed once via
 *   {@link typedMetadata}) and resolve services without any caller-side cast.
 * - **Anything that identifies a document** — {@link getServicesFor} takes an
 *   AST node, a `URI` or a URI string, and abstains instead of throwing.
 * - **String id escape hatch** — {@link getServicesById}, for a language id
 *   derived dynamically (from a wire envelope) where the typed handle isn't
 *   reachable at the call site.
 * - **File extension escape hatch** — {@link getServicesByExtension}, for
 *   file-routing logic that has no URI yet.
 * - **Producible AST type** — {@link getServicesByType} returns every language
 *   whose grammar can produce a `$type`, and {@link soleServicesByType}
 *   narrows that to the unambiguous case. It is the only routing signal a
 *   request that names no document carries at all.
 *
 * Two overload signatures on `getServices` discriminate at compile time
 * — passing a `URI` keeps the inherited `TServices` return shape; passing a
 * `TypedLanguageMetaData<T>` returns `T | undefined`.
 *
 * Langium's base `ServiceRegistry` type stays unchanged. The framework narrows
 * its own `ServiceRegistry` slot to this class instead, so the extended lookups
 * are reachable from the shared-services shapes without a cast.
 */
export class ExtendedServiceRegistry<
   TServices extends LangiumCoreServices = LangiumCoreServices
> extends HydraniumServiceRegistry<TServices> {
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
      return super.getServices(arg);
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
    */
   getServicesById(languageId: string): LangiumCoreServices | undefined {
      return this.languageIdMap.get(languageId);
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
    * Drop the memoised type index, so a language registered after the first
    * type lookup is accounted for. The reason this index belongs on the
    * registry rather than in a consumer's private memo: the registry is the
    * one place that knows when the registered set changed.
    */
   override register(language: TServices): void {
      super.register(language);
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
