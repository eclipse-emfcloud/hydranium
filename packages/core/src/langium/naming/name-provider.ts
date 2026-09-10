/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { findNextUnique, identity, UNQUALIFIED_PROJECT_REFERENCE } from '@hydranium/protocol';
import {
   type AstNode,
   AstUtils,
   type CstNode,
   DocumentCache,
   GrammarUtils,
   type NameProvider as LangiumNameProvider,
   type URI
} from '@hydranium/langium';
import type { HydraniumLanguageServices } from '../language-module.js';

/**
 * Per-call options for the workspace-scoped `findNext*` name proposals
 * ({@link NameProvider.findNextDocumentQualifiedName} /
 * {@link NameProvider.findNextProjectQualifiedName}).
 */
export interface NextNameOptions {
   /**
    * Ignore elements indexed under this document URI when collecting taken
    * names — the self-exclusion a rename or a provisional-id confirmation
    * needs. The proposal is being made FOR this document, so its own
    * already-indexed entry is not a genuine collision; counting it would
    * append a uniqueness suffix to a name the document already legitimately
    * owns.
    *
    * Compared by canonical URI string, so callers may pass either form.
    */
   readonly excludeDocumentUri?: URI | string;
}

/**
 * Construction-time options for {@link DefaultNameProvider}.
 *
 * Adopters whose reference syntax uses a different separator than the
 * framework default (`'.'`) pass `nameSeparator` here. The two-sided contract:
 * the parser/AST treats this character as reserved (validated via
 * `nameSeparatorCheck`), and the joiner produces qualified names with the
 * same character so the linker's lookups against
 * {@link NameProvider.getName} match the syntactic reference form.
 */
export interface NameProviderOptions {
   /** Separator used to join name segments into a qualified name. Default `'.'`. */
   readonly nameSeparator?: string;
   /**
    * Property names checked, in order, when reading a node's own name.
    * Default `['name']` — matches Langium's upstream
    * `DefaultNameProvider.getName(node)` which reads `node.name`. Adopters
    * whose grammar carries the identifier on a different property (e.g.
    * an `id` field) override explicitly; the explicit override at
    * the adopter side documents the grammar's convention rather than
    * burying it in a framework default.
    *
    * **The override is not optional where `name` is a display LABEL rather
    * than an identifier**, and getting it wrong is quiet at first and then
    * loud. A `name=STRING` holding `"Order.Line"` is legitimate content, but
    * the default reads it as the identifier: `getName` composes a qualified
    * name whose segments cannot be told apart from the label's own dots, and
    * `nameSeparatorCheck` reports `hydranium/core/separator-in-name` on every
    * such node. That diagnostic then names the wrong remedy — it asks for a
    * different character, when the fix is to point this option at the property
    * that really is the identifier.
    */
   readonly nameProperties?: readonly string[];
}

/**
 * A node's name together with the property it was read from — the pair
 * {@link NameProvider.getOwnName} and {@link NameProvider.getNameProperty}
 * each project one half of.
 *
 * They are returned together because they must agree: with several configured
 * {@link NameProviderOptions.nameProperties}, answering "what is the name"
 * and "which property holds it" in two independent walks is how the two
 * answers drift apart.
 */
export interface ResolvedName {
   /** The property key the name was read from, e.g. `'name'` or `'id'`. */
   readonly property: string;
   /** The name value at that property. */
   readonly value: string;
}

/**
 * Naming service — **the canonical naming surface in this framework.**
 * Extends Langium's `NameProvider` with the three **qualification levels**
 * of qualified name the framework uses for scope construction:
 *
 * ("Qualification level", never "tier" — `tier` is reserved for the
 * visibility axis (`local` / `project` / `public` / `universal`), which is a
 * different question with confusingly similar member names.)
 *
 * - {@link getOwnName} — the bare segment a user typed next to the node's
 *   declaration. Used for: label edits, UI display, search-box typing,
 *   references within the same container — `HydraniumScopeComputation`
 *   keys the per-document local-symbols map by this level, overriding
 *   Langium's default of keying it by `getName`.
 * - {@link getDocumentQualifiedName} — joins every named ancestor inside
 *   the document. Used for the name written when referencing across
 *   documents or containers within the same project — emitted as the
 *   `tier: 'project'` global-index entry by `HydraniumScopeComputation`.
 * - {@link getProjectQualifiedName} — prepends the owning project's
 *   `Project.referenceName` to the document-qualified name. Used
 *   for cross-project references — emitted as the `tier: 'public'`
 *   global-index entry when the project qualifies its names. When the
 *   owning project's `referenceName` is `UNQUALIFIED_PROJECT_REFERENCE`,
 *   collapses to {@link getDocumentQualifiedName} (single-emit path in
 *   `HydraniumScopeComputation`).
 *
 * `getName` (Langium contract) defaults to {@link getProjectQualifiedName}
 * — the workspace-unique form by construction. Adopters whose grammar
 * uses a different lookup scheme override `getName` to return a different
 * qualification level; grammars with bare-name cross-references stick with
 * the framework default and rely on the local-symbols pass for the
 * in-document case.
 *
 * # Relationship to `ElementKeyProvider`
 *
 * `NameProvider` and `ElementKeyProvider` are two distinct services:
 * - `NameProvider` produces user-facing names used in reference syntax,
 *   completion, and search — non-unique and rename-sensitive.
 * - `ElementKeyProvider` produces a string *handle* that round-trips to a
 *   node within a document — used for GModel ids and UI selection. A key is
 *   a lookup token, not a unique id; under the default name-based strategy
 *   it is non-unique and flips on rename (the positional strategy is unique
 *   and rename-stable instead).
 *
 * The split is deliberate: a single `Id`-suffixed surface conflated the name
 * axis, the key axis, and the label axis. Adopters override the one they
 * need.
 */
export interface NameProvider extends LangiumNameProvider {
   /**
    * Separator used to join name segments into a qualified name. Read
    * polymorphically by the framework's separator-in-id validation rule
    * (`nameSeparatorCheck`) so it works against any conforming
    * implementation.
    *
    * **Two-sided contract.** Adopters that change the separator must
    * (1) configure their grammar's reference syntax to use the same
    * character, and (2) ensure name-typed property values do not
    * contain that character — the framework's separator validation
    * rule enforces (2) automatically when registered.
    */
   readonly nameSeparator: string;

   /**
    * Produce a qualified name by joining segments with
    * {@link nameSeparator}, dropping empty segments. The dual of the
    * qualification-level getters: it composes the form they decompose.
    *
    * Use at adopter callsites that have already computed segments and
    * need to compose them into a qualified name — typically when the
    * segments come from a mix of node walks, project lookups, and
    * adopter-specific suffixes. Replaces manual
    * `segment + nameProvider.nameSeparator + segment` concatenation,
    * which silently breaks for adopters that change the separator.
    *
    * Drops empty segments so callers can pass a qualification-level output
    * that may legitimately be empty (an unqualified project reference name)
    * without producing a leading or doubled separator.
    */
   qualify(...segments: string[]): string;

   /**
    * The node's bare segment — what the user typed next to the node's
    * declaration, with no ancestor qualification. Used for label edits,
    * UI display, search typing, and the per-document local-symbols pass.
    */
   getOwnName(node?: AstNode): string | undefined;

   /**
    * Predicate form of {@link getOwnName} — true iff this NameProvider
    * can read a name from `node` via the configured
    * {@link NameProviderOptions.nameProperties}. Equivalent to
    * `getOwnName(node) !== undefined`, exposed under a readable name for
    * sites that only need the existence check (not the value).
    *
    * Distinct from Langium's `isNamed(node): node is NamedAstNode`
    * upstream typeguard, which checks `node.name` specifically and
    * narrows the static type. `hasName` is adopter-polymorphic
    * (respects `nameProperties` — an `id`-based grammar
    * passes `hasName` even though Langium's `isNamed` would return
    * false), but cannot narrow at the type level because
    * `nameProperties` is a runtime configuration.
    */
   hasName(node?: AstNode): boolean;

   /**
    * The property KEY {@link getOwnName} read the name from — `'name'` for
    * a conventional grammar, `'id'` for an `id`-keyed one. Returns
    * `undefined` when no configured name property holds a string, i.e.
    * exactly when {@link hasName} is false.
    *
    * The companion of {@link getOwnName}: that returns the value, this
    * returns where it came from. Callers that must address the name's
    * source rather than read it need the key — an LSP semantic-token or
    * document-symbol acceptor takes `{ node, property }` and resolves the
    * CST range itself, so handing it the value would be useless.
    */
   getNameProperty(node?: AstNode): string | undefined;

   /**
    * Document-qualified name — joins every named ancestor's own-name
    * within the document using {@link nameSeparator}. Used as the name
    * written when referencing across documents or containers within the
    * same project; emitted as the `tier: 'project'` global-index entry by
    * `HydraniumScopeComputation`.
    *
    * Unnamed ancestors (containers without their own name) contribute
    * nothing to the qualified form — the walk skips them silently. The
    * walk traverses through the document root: if the root has its own
    * name, that name IS part of the qualified form. Adopters who want a
    * different boundary override this method.
    */
   getDocumentQualifiedName(node?: AstNode): string | undefined;

   /**
    * Project-qualified name — prepends the owning project's
    * `referenceName` (via {@link getProjectReferenceName}) to the
    * document-qualified name. Used as the name for cross-project
    * references — emitted as the `tier: 'public'` global-index entry by
    * `HydraniumScopeComputation` when the project qualifies its names.
    *
    * Collapses to {@link getDocumentQualifiedName} when the owning
    * project's reference name is `UNQUALIFIED_PROJECT_REFERENCE` (empty
    * string) or no project owns the URI — in those cases project-
    * qualified equals document-qualified, and
    * `HydraniumScopeComputation` skips the multi-tier emit.
    */
   getProjectQualifiedName(node?: AstNode): string | undefined;

   /**
    * Resolve the user-facing reference prefix for the project owning
    * `uri`. Default: reads `Project.referenceName` from the shared
    * `ProjectManager`. Override when project ownership comes from a
    * service other than `ProjectManager`.
    *
    * Returns `undefined` if no project owns the URI; returns the empty
    * `UNQUALIFIED_PROJECT_REFERENCE` sentinel when the project is
    * intentionally unqualified.
    */
   getProjectReferenceName(uri: URI): string | undefined;

   /**
    * Find a unique name for a new node within `container`, using `base`
    * as a stem. Walks the AST subtree rooted at `container` and avoids
    * names already used by `$type === type` nodes there. Default
    * generates `${base}1`, `${base}2`, ... until an unused value is
    * found. Used by create-element operation handlers when the
    * uniqueness scope is one AST subtree.
    */
   findNextName(type: string, base: string, container: AstNode): string;

   /**
    * Find a name whose document-qualified form is unique within the
    * given project. Walks `IndexManager.allElements(type)` and filters
    * to the project identified by `projectId`. Used by create-element
    * operation handlers when the uniqueness scope is one project: the
    * result becomes the new element's bare own-name, whose document-
    * qualified form must be unique within that project.
    *
    * Workspace-walk-with-filter — O(N) per call where N is the total
    * element count of `type` workspace-wide. Adopters with a project-
    * tier element index override for O(1) lookup.
    *
    * Pass {@link NextNameOptions.excludeDocumentUri} when the caller is
    * proposing a name FOR an already-indexed document — a rename, or a
    * client confirming a provisional id it already flushed. Without it the
    * document collides with its own index entry and the proposal takes a
    * spurious uniqueness suffix.
    */
   findNextDocumentQualifiedName(type: string, base: string, projectId: string, options?: NextNameOptions): string;

   /**
    * Find a name whose project-qualified form is unique across the
    * workspace. Walks `IndexManager.allElements(type)` workspace-wide.
    * Used by create-element operation handlers when the uniqueness
    * scope is the entire workspace — generating a name that must not
    * collide with any element of `type` in any project.
    *
    * Takes the same {@link NextNameOptions.excludeDocumentUri} self-exclusion
    * as {@link findNextDocumentQualifiedName}, for the same reason.
    */
   findNextProjectQualifiedName(type: string, base: string, options?: NextNameOptions): string;
}

/**
 * Default {@link NameProvider}. Resolves a node's own name from the
 * configured {@link NameProviderOptions.nameProperties}, which defaults to
 * `['name']` (the Langium-conventional `node.name`). Adopters whose grammar
 * carries an explicit identifier property configure it at construction.
 *
 * Designed for subclassing: each qualification-level method is overridable
 * so adopters can adjust the convention without re-implementing the whole
 * class.
 */
export class DefaultNameProvider implements NameProvider {
   protected readonly nameProperties: readonly string[];
   readonly nameSeparator: string;
   /**
    * Per-document memo for {@link getDocumentQualifiedName} results.
    * Eliminates the redundant container-chain walk that arises when
    * {@link getProjectQualifiedName} (and other consumers) repeatedly
    * query the document-qualified name for the same node within a
    * document's lifetime. Evicted automatically when Langium rebuilds
    * the document.
    *
    * Only cached when the computed result is a defined string — `undefined`
    * results re-evaluate on each call (cheap path: `getOwnName` returns
    * undefined for unnamed nodes, no chain walk needed).
    */
   protected readonly documentQualifiedNameCache: DocumentCache<AstNode, string>;
   /**
    * Per-document memo for {@link getProjectQualifiedName} results.
    * Sibling of {@link documentQualifiedNameCache}; covers the additional
    * project-reference-name lookup the project-qualified variant performs.
    *
    * **Project-rename caveat.** If `Project.referenceName` mutates without
    * a corresponding document rebuild, cached entries become stale. Adopters
    * renaming projects at runtime should clear the cache explicitly; the
    * default workspace lifecycle (descriptor file edits trigger
    * `DocumentBuilder.onUpdate` → `DocumentCache` evicts) covers the
    * common case.
    */
   protected readonly projectQualifiedNameCache: DocumentCache<AstNode, string>;

   constructor(
      protected readonly services: HydraniumLanguageServices,
      options: NameProviderOptions = {}
   ) {
      this.nameSeparator = options.nameSeparator ?? '.';
      this.nameProperties = options.nameProperties ?? ['name'];
      this.documentQualifiedNameCache = new DocumentCache(services.shared);
      this.projectQualifiedNameCache = new DocumentCache(services.shared);
   }

   /**
    * Join name segments with {@link nameSeparator}, dropping empty segments.
    * Subclasses whose joining policy depends on the segment's position or
    * kind, rather than on a single separator, override.
    */
   qualify(...segments: string[]): string {
      return segments.filter(segment => segment.length > 0).join(this.nameSeparator);
   }

   getOwnName(node?: AstNode): string | undefined {
      return this.findNameProperty(node)?.value;
   }

   hasName(node?: AstNode): boolean {
      return this.findNameProperty(node) !== undefined;
   }

   getNameProperty(node?: AstNode): string | undefined {
      return this.findNameProperty(node)?.property;
   }

   /**
    * The single walk over {@link nameProperties} the three public name-reading
    * members share — first configured property holding a string wins, so key
    * and value can never disagree about which one that was.
    */
   protected findNameProperty(node?: AstNode): ResolvedName | undefined {
      if (!node) {
         return undefined;
      }
      const indexed = node as unknown as Record<string, unknown>;
      for (const property of this.nameProperties) {
         const value = indexed[property];
         if (typeof value === 'string') {
            return { property, value };
         }
      }
      return undefined;
   }

   getDocumentQualifiedName(node?: AstNode): string | undefined {
      if (!node) {
         return undefined;
      }
      const document = AstUtils.findRootNode(node).$document;
      if (!document) {
         return this.computeDocumentQualifiedName(node);
      }
      const cached = this.documentQualifiedNameCache.get(document.uri, node);
      if (cached !== undefined) {
         return cached;
      }
      const computed = this.computeDocumentQualifiedName(node);
      if (computed !== undefined) {
         this.documentQualifiedNameCache.set(document.uri, node, computed);
      }
      return computed;
   }

   protected computeDocumentQualifiedName(node: AstNode): string | undefined {
      let name = this.getOwnName(node);
      if (!name) {
         return undefined;
      }
      let parent = node.$container;
      while (parent) {
         const segment = this.getOwnName(parent);
         if (segment) {
            name = this.qualify(segment, name);
         }
         parent = parent.$container;
      }
      return name;
   }

   getProjectQualifiedName(node?: AstNode): string | undefined {
      if (!node) {
         return undefined;
      }
      const document = AstUtils.findRootNode(node).$document;
      if (!document) {
         return this.getDocumentQualifiedName(node);
      }
      const cached = this.projectQualifiedNameCache.get(document.uri, node);
      if (cached !== undefined) {
         return cached;
      }
      const documentName = this.getDocumentQualifiedName(node);
      if (!documentName) {
         return undefined;
      }
      const referenceName = this.getProjectReferenceName(document.uri);
      const computed =
         !referenceName || referenceName === UNQUALIFIED_PROJECT_REFERENCE ? documentName : this.qualify(referenceName, documentName);
      this.projectQualifiedNameCache.set(document.uri, node, computed);
      return computed;
   }

   getProjectReferenceName(uri: URI): string | undefined {
      const project = this.services.shared.workspace.ProjectManager.getProject(uri);
      return project?.referenceName;
   }

   /**
    * Langium contract — the canonical name used by the linker for cross-
    * reference resolution.
    *
    * **Default: {@link getProjectQualifiedName}** (workspace-unique by
    * construction — a project's `referenceName` is unique within the
    * workspace, and qualifying with it lifts any name into a workspace-
    * unique key). This is the form the cross-document global-scope
    * index uses for cross-project references; LSP UI surfaces (document
    * symbols, completion, hover) also see this form and display
    * qualified names.
    *
    * **Within-document references stay keyed by bare names** via
    * `HydraniumScopeComputation.addLocalSymbol`, which explicitly calls
    * {@link getOwnName} when populating the local-symbols map (bypassing
    * Langium's default that goes through this `getName`). The
    * separation lets `getName` carry the workspace-unique form for the
    * linker without forcing qualified names into the per-document
    * symbol map.
    *
    * Adopters whose grammar uses a different lookup level override here
    * — bare names ({@link getOwnName}) for grammars without a
    * qualified-name syntax, document-qualified ({@link getDocumentQualifiedName})
    * for grammars whose linker resolves within a project.
    */
   getName(node: AstNode): string | undefined {
      return this.getProjectQualifiedName(node);
   }

   getNameNode(node: AstNode): CstNode | undefined {
      // Read-side CST rehydration. Target-range navigation
      // (go-to-definition / declaration / implementation / type & call hierarchy)
      // reaches the target node's name through `getNameNode` but does NOT run a
      // build, so a target in a closed (CST-shed) document would otherwise have no
      // CST to read. Restore it on demand — a no-op when the CST is resident
      // (every parsed node has a `$cstNode`), so this is behaviour-neutral unless
      // a residency policy has shed the document.
      this.services.shared.workspace.CstResidencyService.rehydrateNode(node);
      for (const property of this.nameProperties) {
         const cstNode = GrammarUtils.findNodeForProperty(node.$cstNode, property);
         if (cstNode) {
            return cstNode;
         }
      }
      return undefined;
   }

   findNextName(type: string, base: string, container: AstNode): string {
      const proposal = base.replaceAll(this.nameSeparator, '_');
      const knownNames = AstUtils.streamAst(container)
         .filter(node => node.$type === type)
         .map(node => this.getOwnName(node))
         .nonNullable()
         .toArray();
      return findNextUnique(proposal, knownNames, identity);
   }

   findNextDocumentQualifiedName(type: string, base: string, projectId: string, options?: NextNameOptions): string {
      const proposal = base.replaceAll(this.nameSeparator, '_');
      const shared = this.services.shared.workspace;
      const isSelf = this.selfDocumentFilter(options);
      const knownNames = shared.IndexManager.allElements(type)
         .filter(description => shared.ProjectManager.getProject(description.documentUri)?.id === projectId)
         .filter(description => !isSelf(description.documentUri))
         .map(description => description.name)
         .toArray();
      return findNextUnique(proposal, knownNames, identity);
   }

   findNextProjectQualifiedName(type: string, base: string, options?: NextNameOptions): string {
      const proposal = base.replaceAll(this.nameSeparator, '_');
      const isSelf = this.selfDocumentFilter(options);
      const knownNames = this.services.shared.workspace.IndexManager.allElements(type)
         .filter(description => !isSelf(description.documentUri))
         .map(description => description.name)
         .toArray();
      return findNextUnique(proposal, knownNames, identity);
   }

   /**
    * Predicate matching the document a `findNext*` proposal is being made FOR,
    * so its own indexed entries can be dropped from the taken-name set. Returns
    * a never-matching predicate when no exclusion was requested, which keeps the
    * default behaviour byte-identical for existing callers.
    */
   protected selfDocumentFilter(options?: NextNameOptions): (documentUri: URI) => boolean {
      const excluded = options?.excludeDocumentUri;
      if (excluded === undefined) {
         return () => false;
      }
      const target = this.services.shared.workspace.DocumentUriPolicy.canonicalUri(excluded.toString());
      return documentUri => this.services.shared.workspace.DocumentUriPolicy.canonicalUri(documentUri.toString()) === target;
   }
}
