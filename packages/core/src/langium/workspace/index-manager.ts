/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { type Tracer } from '@hydranium/protocol';
import {
   type IndexManager,
   type AstNode,
   type AstNodeDescription,
   DefaultIndexManager,
   type LangiumDocument,
   type URI
} from '@hydranium/langium';
import type { CancellationToken } from 'vscode-languageserver-protocol';
import type { LogNameOptions } from '../diagnostics/logger.js';
import type { ProjectManager } from '../project/project-manager.js';
import type { ServerSharedServicesMinimal } from '../shared-services.js';

/**
 * Workspace-wide name and project lookup over indexed descriptions. A name can
 * have several descriptions for one node or for distinct documents; callers
 * that require uniqueness inspect every match.
 */
export interface HydraniumIndexManager extends IndexManager {
   /**
    * Return every exact-name match, optionally filtered by AST subtype and
    * owning language. Return an empty list on a miss.
    */
   getElementsByName(name: string, type?: string, languageId?: string): readonly AstNodeDescription[];
   /**
    * Return the first matching description, or undefined. Multiple visibility
    * tiers can describe one node; this method does not establish uniqueness
    * across documents.
    */
   getElementByName(name: string, type?: string, languageId?: string): AstNodeDescription | undefined;
   /**
    * Resolve the description through its registered document and language
    * locator. Return undefined for an absent description, document or node.
    */
   resolveElement(description?: AstNodeDescription): AstNode | undefined;
   /**
    * Resolve the first result of getElementByName; return undefined when it
    * cannot be resolved.
    */
   resolveElementByName(name: string, type?: string, languageId?: string): AstNode | undefined;
   /**
    * Return descriptions in the project’s direct member documents, optionally
    * filtered by subtype. Do not include dependency visibility; an unknown
    * project has no results.
    */
   getElementsInProject(projectId: string, type?: string): AstNodeDescription[];
   /**
    * Return the registered document’s semantic root, or undefined when it is
    * absent. Wrapper grammars may select an inner semantic node.
    */
   resolveSemanticElement(uri: URI): AstNode | undefined;
}

/**
 * Default `IndexManager` for `@hydranium/core` consumers. Layers an additional
 * **`elementsByName: name → document → descriptions`** index on top of Langium's
 * {@link DefaultIndexManager} so consumers can look up descriptions by exact
 * name without streaming the whole index. Provides the resolution helpers
 * built on that index:
 *
 * - {@link getElementsByName} — cached name lookup returning every match,
 *   optionally narrowed by reference type and owning language.
 * - {@link getElementByName} — the first-match form; callers that need
 *   to distinguish documents inspect all matches.
 * - {@link resolveElement} — turn an `AstNodeDescription` into the
 *   actual `AstNode` via `LangiumDocuments` + `AstNodeLocator`.
 * - {@link resolveElementByName} — composition of the two.
 * - {@link resolveSemanticElement} — resolve a document's root node;
 *   default returns the parse-result root, consumers with wrapper
 *   grammars override to return the inner semantic root via
 *   {@link findSemanticRoot}.
 *
 * The `elementsByName` index is maintained incrementally inside
 * Langium's `updateContent` / `removeContent` lifecycle. Subclasses
 * that add their own indexes (e.g. a reverse map from project to
 * member URIs for project-tier queries) override `updateContent` /
 * `removeContent` and chain `super`.
 */
export class DefaultHydraniumIndexManager extends DefaultIndexManager implements HydraniumIndexManager {
   /** Name → document URI → descriptions, so removing a document never scans another document's entries. */
   protected elementsByName = new Map<string, Map<string, AstNodeDescription[]>>();
   /** Materialized name matches, discarded whenever that name's contributions change. */
   protected nameMatches = new Map<string, readonly AstNodeDescription[]>();

   protected readonly sharedServices: ServerSharedServicesMinimal;
   protected readonly tracer: Tracer;

   constructor(services: ServerSharedServicesMinimal, options: LogNameOptions = {}) {
      super(services);
      this.sharedServices = services;
      this.tracer = services.Tracer.for(options.logName ?? 'IndexManager').trace('instantiated');
   }

   /**
    * Lazy access to {@link ProjectManager}. Reading it eagerly in the
    * constructor caused a DI cycle in project-aware consumers
    * (`DocumentBuilder → IndexManager → ProjectManager →
    * DocumentBuilder`); deferring the read until first use breaks the
    * cycle without splitting the bindings.
    */
   protected get projectManager(): ProjectManager {
      return this.sharedServices.workspace.ProjectManager;
   }

   // ============================================================
   // Incremental index maintenance
   // ============================================================

   override async updateContent(document: LangiumDocument, cancelToken?: CancellationToken): Promise<void> {
      const uriStr = document.uri.toString();
      this.removeFromElementsByName(uriStr);
      await super.updateContent(document, cancelToken);
      this.addToElementsByName(uriStr);
   }

   override removeContent(uri: URI): void {
      this.removeFromElementsByName(uri.toString());
      super.removeContent(uri);
   }

   /**
    * Drop all entries this URI contributed to {@link elementsByName}.
    * Reads from `symbolIndex` which still holds the old descriptions at
    * this point (we run *before* `super` clears them).
    */
   protected removeFromElementsByName(uriStr: string): void {
      const oldDescs = this.symbolIndex.get(uriStr);
      if (!oldDescs) {
         return;
      }
      for (const description of oldDescs) {
         const name = description.name;
         const entries = this.elementsByName.get(name);
         if (!entries) {
            continue;
         }
         entries.delete(uriStr);
         this.nameMatches.delete(name);
         if (entries.size === 0) {
            this.elementsByName.delete(name);
         }
      }
   }

   /**
    * Add this URI's fresh contributions to {@link elementsByName}. Reads
    * from `symbolIndex` which now holds the new descriptions (we run
    * *after* `super.updateContent` populated them).
    */
   protected addToElementsByName(uriStr: string): void {
      const newDescs = this.symbolIndex.get(uriStr);
      if (!newDescs) {
         return;
      }
      for (const desc of newDescs) {
         let byDocument = this.elementsByName.get(desc.name);
         if (!byDocument) {
            byDocument = new Map();
            this.elementsByName.set(desc.name, byDocument);
         }
         const entries = byDocument.get(uriStr);
         if (entries) {
            entries.push(desc);
         } else {
            byDocument.set(uriStr, [desc]);
         }
         this.nameMatches.delete(desc.name);
      }
   }

   // ============================================================
   // Lookup + resolution helpers
   // ============================================================

   /**
    * Cached lookup by exact name, returning EVERY match — optionally
    * narrowed by reference type (via Langium's `AstReflection.isSubtype`,
    * so grammar subtype relations are honoured) and by the owning
    * document's language. The first read after a name changes materializes
    * its document buckets. Subsequent unfiltered reads reuse that array.
    *
    * The name index spans every language in the workspace, so a name is
    * only as unique as the adopter's naming scheme makes it. Callers that
    * need one answer go through {@link getElementByName}, which returns
    * the first matching description; callers that can
    * disambiguate from context (or want to report the ambiguity) use this.
    */
   getElementsByName(name: string, type?: string, languageId?: string): readonly AstNodeDescription[] {
      let candidates = this.nameMatches.get(name);
      if (!candidates) {
         const byDocument = this.elementsByName.get(name);
         if (!byDocument) {
            return [];
         }
         candidates = [...byDocument.values()].flat();
         this.nameMatches.set(name, candidates);
      }
      const byType = type ? candidates.filter(candidate => this.astReflection.isSubtype(candidate.type, type)) : candidates;
      if (languageId === undefined) {
         return byType;
      }
      return byType.filter(candidate => this.languageIdOf(candidate.documentUri) === languageId);
   }

   /**
    * Cached lookup by exact name, returning the FIRST match — optionally
    * narrowed by reference type and owning language.
    *
    * **First-match is deliberate here, and is not a routing answer.** A real
    * workspace indexes one logical element under several descriptions: scope
    * computation emits a symbol per visibility tier, and a wrapper grammar
    * exports both its document root and its inner semantic root. So a
    * multi-match is usually one element seen several ways, and abstaining on
    * it would empty every reference dropdown that resolves a scope's source
    * by name.
    *
    * What genuinely IS ambiguous — the same name in two different DOCUMENTS —
    * cannot be told apart from that here, only by a caller that knows what it
    * is asking. {@link getElementsByName} exposes the full set for callers that
    * must distinguish; the useful test is whether the matches disagree on the
    * document, which is the only distinction language routing needs.
    */
   getElementByName(name: string, type?: string, languageId?: string): AstNodeDescription | undefined {
      return this.getElementsByName(name, type, languageId)[0];
   }

   /**
    * The language id owning a document, or `undefined` when its URI
    * matches no registered language. Non-throwing: an indexed document
    * whose URI no longer routes must not break an unrelated lookup.
    *
    * One walk of the lookup ladder, via `getServicesFor`. The obvious
    * `hasServices(uri) && getServices(uri)` pair costs two, because Langium
    * implements `hasServices` as a try/catch around `getServices` — and this
    * runs once per CANDIDATE inside {@link getElementsByName}'s language filter.
    */
   protected languageIdOf(documentUri: URI): string | undefined {
      return this.sharedServices.ServiceRegistry.getServicesFor(documentUri)?.LanguageMetaData.languageId;
   }

   /** Turn an `AstNodeDescription` into the actual `AstNode` via the language-specific `AstNodeLocator`. */
   resolveElement(description?: AstNodeDescription): AstNode | undefined {
      if (!description) {
         return undefined;
      }
      const langiumDocument = this.documents.getDocument(description.documentUri);
      if (!langiumDocument) {
         return undefined;
      }
      const languageServices = this.serviceRegistry.getServices(description.documentUri);
      return languageServices.workspace.AstNodeLocator.getAstNode(langiumDocument.parseResult.value, description.path);
   }

   /** Compose {@link getElementByName} with {@link resolveElement}. */
   resolveElementByName(name: string, type?: string, languageId?: string): AstNode | undefined {
      return this.resolveElement(this.getElementByName(name, type, languageId));
   }

   /**
    * Project-scoped element listing — all descriptions whose owning URI
    * belongs to the given project. Equivalent to Langium's
    * `allElements(type)` but filtered to one project's members.
    *
    * Returns direct members only — **no visibility transitivity is
    * applied**. For "everything visible from project X", map
    * {@link ProjectManager.getVisibleProjects} over this method and
    * flatten the result.
    *
    * Returns an empty array if the project id is unknown.
    */
   getElementsInProject(projectId: string, type?: string): AstNodeDescription[] {
      const memberUris = this.projectManager.getProjectUris(projectId);
      if (memberUris.length === 0) {
         return [];
      }
      const memberUriSet = new Set<string>();
      for (const uri of memberUris) {
         memberUriSet.add(uri.toString());
      }
      const result: AstNodeDescription[] = [];
      for (const bucket of this.elementsByName.values()) {
         for (const descriptions of bucket.values()) {
            for (const description of descriptions) {
               if (!memberUriSet.has(description.documentUri.toString())) {
                  continue;
               }
               if (type && !this.astReflection.isSubtype(description.type, type)) {
                  continue;
               }
               result.push(description);
            }
         }
      }
      return result;
   }

   /**
    * Resolve the "semantic root" of a document — the meaningful root
    * element callers expect when treating the document as a unit.
    * Default returns the parse-result root directly; consumers with a
    * wrapper grammar (a generic envelope with a single inner element)
    * override {@link findSemanticRoot} to return the inner element.
    */
   resolveSemanticElement(uri: URI): AstNode | undefined {
      const document = this.documents.getDocument(uri);
      if (!document) {
         return undefined;
      }
      return this.findSemanticRoot(document);
   }

   /**
    * Default: the document's parse-result root. Override for wrapper
    * grammars that store the meaningful root inside an envelope.
    */
   protected findSemanticRoot(document: LangiumDocument): AstNode | undefined {
      return document.parseResult.value;
   }
}
