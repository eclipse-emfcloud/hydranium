/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { type AstNode, AstUtils, type LangiumDocument } from '@hydranium/langium';
import { type Disposable } from 'vscode-languageserver';
import { Format, Logger, type ProfileRecord, type ProfileSession, type Tracer } from '@hydranium/protocol';
import { type LogNameOptions } from '../diagnostics/logger.js';
import { type ServerLanguageServices } from '../language-module.js';
import { Registry, type RegistryItem } from '../../util/registry.js';
import { type HydraniumAstNodeDescriptionProvider } from './ast-node-description-provider.js';
import { type ScopeExtensionRegistry } from './scope-extension-contribution.js';
import { type TieredAstNodeDescription } from './scoped-ast-node-description.js';

/**
 * Acceptor passed to {@link ScopeExtension.addDescriptions}. Mirrors the
 * `ValidationAcceptor` pattern: a single parameter that hides both the
 * description factory and the result accumulator.
 *
 * Scope extensions are **query-time, per-context contributors** rebuilt on
 * every `getScope` call from the live reference context. Only two visibility
 * tiers are coherent for such contributors:
 * - `local(...)` — document-only symbol; layered above the project chain
 *   but below document-local. Most extension-scope descriptions.
 * - `universal(...)` — visible everywhere unconditionally; layered at the
 *   bottom of the chain (synthetic / stdlib content).
 *
 * **Why no `project` / `public` tiers**: `public` ("visible from dependent
 * projects") is undeliverable from a per-context contributor — a
 * contribution made while resolving a reference in document D is never
 * indexed, so a dependent project's query never sees it. Genuine
 * cross-project synthetic symbols go through the AST-extension / export
 * path (which IS indexed + tiered). `project` collapses into `local` —
 * since the extension is already scoped to this one query, "project
 * visibility" adds no real visibility over `local`. Use `createOwnProjectScope`
 * / `createDependencyScope` hooks on `HydraniumScopeProvider` for genuine
 * tier-weaving needs.
 */
export interface ScopeDescriptionAcceptor {
   local(options: { node: AstNode; name: string; document: LangiumDocument }): void;
   universal(options: { node: AstNode; name: string; document: LangiumDocument }): void;
   /**
    * Push a pre-built {@link TieredAstNodeDescription} directly — use when
    * descriptions are constructed ahead of time, to avoid per-query
    * allocation. The pushed description's `tier` must be `'local'` or
    * `'universal'`; a description of any other tier is silently dropped,
    * because {@link ScopeExtensionDescriptions} holds only those two.
    */
   push(description: TieredAstNodeDescription): void;
}

/** Build a {@link ScopeDescriptionAcceptor} that synthesises typed descriptions via `descriptions` and accumulates them into `into`. */
function createScopeDescriptionAcceptor(
   into: TieredAstNodeDescription[],
   descriptions: HydraniumAstNodeDescriptionProvider
): ScopeDescriptionAcceptor {
   return {
      local: options => into.push(descriptions.createLocal(options)),
      universal: options => into.push(descriptions.createUniversal(options)),
      push: description => into.push(description)
   };
}

/**
 * A registration that contributes additional descriptions to the scope
 * computed by `getScope` for specific reference types. Contributed descriptions
 * layer at their declared tier (local above the project chain but below
 * document-local; universal at the bottom).
 */
export interface ScopeExtension extends RegistryItem {
   /** Reference types this extension applies to, as `$type` strings. */
   readonly referenceTypes: string[];
   /**
    * Contribute scope descriptions for the given context via `accept`.
    * If the extension does not apply, call nothing.
    *
    * Sync-only by Langium contract: invoked from `ScopeProvider.getScope`,
    * which Langium defines as synchronous. Adopters needing async work must
    * build the data up-front and hand a sync acceptor here.
    */
   addDescriptions(context: AstNode, referenceType: string, document: LangiumDocument, accept: ScopeDescriptionAcceptor): void;
}

/** The scope-extension descriptions for one reference, split by tier. */
export interface ScopeExtensionDescriptions {
   readonly local: readonly TieredAstNodeDescription[];
   readonly universal: readonly TieredAstNodeDescription[];
}

/**
 * Public contract for the per-language scope-extension service. Extends
 * the {@link ScopeExtensionRegistry} (the imperative `register` surface
 * contributions use) with the query `HydraniumScopeProvider` builds its
 * extension tiers from.
 */
export interface ScopeExtensionService extends ScopeExtensionRegistry {
   /**
    * Run every extension registered for `referenceType` once against
    * `context`, and answer its descriptions by tier. A caller that needs
    * both tiers takes them from one call: a call per tier runs every
    * extension twice.
    */
   getDescriptions(referenceType: string, context: AstNode): ScopeExtensionDescriptions;
}

export type ScopeExtensionServiceOptions = LogNameOptions;

const NO_DESCRIPTIONS: ScopeExtensionDescriptions = { local: [], universal: [] };

/**
 * Default {@link ScopeExtensionService} implementation. Per-language
 * registry for dynamic scope contributions: extra resolvable descriptions
 * layered at their declared tier within the scope `getScope` computes for
 * specific reference types. Split out of `DefaultAstExtensionService` so
 * the build-phase AST enrichment concern (which mutates nodes) is
 * separate from the query-time scope-resolution concern (which only reads).
 *
 * Lives in the per-language `references` group alongside `ScopeProvider`,
 * which consumes {@link getDescriptions}. Designed as a base class; adopters
 * extend it and call `register` in their constructor.
 *
 * At `debug`, each extension's calls and self-time go into one profile
 * session, reported when a build starts and when it ends. A report thus
 * covers one build, validation included, or the calls made between two
 * builds, such as a reference picker's.
 */
export class DefaultScopeExtensionService implements ScopeExtensionService {
   protected readonly scopeExtensions = new Registry<ScopeExtension>();
   protected readonly tracer: Tracer;
   /** Open from the first profiled call until {@link reportProfile}. */
   protected profileSession?: ProfileSession;

   constructor(
      protected readonly services: ServerLanguageServices,
      options: ScopeExtensionServiceOptions = {}
   ) {
      this.tracer = services.shared.Tracer.for(options.logName ?? 'ScopeExtension').trace('instantiated');

      // Read the language's ScopeExtensionContribution group and let each
      // contribution register one or many scope extensions through this service.
      // Optional chaining tolerates incomplete test stubs; production
      // wiring always provides the slot via `createServerLanguageModule`.
      const contributions = services.references?.scopes ?? {};
      for (const contribution of Object.values(contributions)) {
         contribution.registerScopeExtensions(this);
      }
      // Optional for the same reason: a stub tree may carry no builder.
      const builder = services.shared.workspace.DocumentBuilder;
      builder?.onUpdate(() => this.reportProfile());
      builder?.onBuildEnded(() => this.reportProfile());
   }

   /**
    * Register a single scope extension. Doubles as the imperative low-level
    * API and as the {@link ScopeExtensionRegistry} entry point that
    * `ScopeExtensionContribution.registerScopeExtensions` hands to
    * contributions. Throws on duplicate id.
    */
   register(extension: ScopeExtension): Disposable {
      return this.scopeExtensions.register(extension);
   }

   /**
    * Holds the profile wrap, which an override would have to copy; to change
    * which extensions run, override {@link extensionsFor}.
    */
   getDescriptions(referenceType: string, context: AstNode): ScopeExtensionDescriptions {
      const extensionsForType = this.extensionsFor(referenceType, context);
      if (extensionsForType.length === 0) {
         return NO_DESCRIPTIONS;
      }
      const document = AstUtils.getDocument(context);
      const collected: TieredAstNodeDescription[] = [];
      const accept = createScopeDescriptionAcceptor(collected, this.services.workspace.AstNodeDescriptionProvider);
      const session = Logger.isLevelEnabled('debug') ? (this.profileSession ??= this.tracer.profile('scope-extension')) : undefined;
      for (const extension of extensionsForType) {
         if (session) {
            session.scope(extension.id, () => extension.addDescriptions(context, referenceType, document, accept));
         } else {
            extension.addDescriptions(context, referenceType, document, accept);
         }
      }
      return {
         local: collected.filter(description => description.tier === 'local'),
         universal: collected.filter(description => description.tier === 'universal')
      };
   }

   /** The extensions that run for one reference: by default, those registered for `referenceType`. */
   protected extensionsFor(referenceType: string, _context: AstNode): ScopeExtension[] {
      return this.scopeExtensions.all().filter(extension => extension.referenceTypes.includes(referenceType));
   }

   /**
    * Report the profile session, if one is open, and start the next one fresh:
    * one line per extension, its calls and self-time. Not a share of the
    * session's time, which runs from the first call to the report and so takes
    * in whatever happened between the calls.
    */
   protected reportProfile(): void {
      const session = this.profileSession;
      this.profileSession = undefined;
      for (const record of session?.records() ?? []) {
         this.tracer.debug(this.formatProfileRecord(record));
      }
   }

   /**
    * The log line of one extension's {@link reportProfile} entry. It names the
    * language: each has its own session, and an extension id is unique only
    * within its language.
    */
   protected formatProfileRecord(record: ProfileRecord): string {
      const language = this.services.LanguageMetaData.languageId;
      return `[profile scope-extension ${language}] ${record.id} ×${record.count} ${Format.elapsed(record.selfMs)}`;
   }
}
