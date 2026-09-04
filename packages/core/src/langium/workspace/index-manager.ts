/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { type Tracer } from '@hydranium/protocol';
import { type AstNode, type AstNodeDescription, DefaultIndexManager, type LangiumDocument, type URI } from '@hydranium/langium';
import type { CancellationToken } from 'vscode-languageserver-protocol';
import type { LogNameOptions } from '../diagnostics/logger.js';
import type { ProjectManager } from '../project/project-manager.js';
import type { ServerSharedServicesMinimal } from '../shared-services.js';

/**
 * Default `IndexManager` for `@hydranium/core` consumers. Layers an
 * additional **`elementsByName: name → descriptions`** index on top of
 * Langium's {@link DefaultIndexManager} so consumers can look up
 * descriptions by exact name in O(1) instead of streaming the whole
 * index. Provides the resolution helpers built on that index:
 *
 * - {@link getElementsByName} — O(1) name lookup returning every match,
 *   optionally narrowed by reference type and owning language.
 * - {@link getElementByName} — the single-answer form, abstaining when the
 *   name does not identify exactly one element.
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
export class HydraniumIndexManager extends DefaultIndexManager {
   /** Maps `description.name` → list of descriptions with that name. Used for O(1) `getElementByName`. */
   protected elementsByName = new Map<string, AstNodeDescription[]>();

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
      for (const desc of oldDescs) {
         const entries = this.elementsByName.get(desc.name);
         if (!entries) {
            continue;
         }
         const filtered = entries.filter(entry => entry.documentUri.toString() !== uriStr);
         if (filtered.length === 0) {
            this.elementsByName.delete(desc.name);
         } else {
            this.elementsByName.set(desc.name, filtered);
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
         const entries = this.elementsByName.get(desc.name);
         if (entries) {
            entries.push(desc);
         } else {
            this.elementsByName.set(desc.name, [desc]);
         }
      }
   }

   // ============================================================
   // Lookup + resolution helpers
   // ============================================================

   /**
    * O(1) lookup by exact name, returning EVERY match — optionally
    * narrowed by reference type (via Langium's `AstReflection.isSubtype`,
    * so grammar subtype relations are honoured) and by the owning
    * document's language.
    *
    * The name index spans every language in the workspace, so a name is
    * only as unique as the adopter's naming scheme makes it. Callers that
    * need one answer go through {@link getElementByName}, which abstains
    * when the name does not identify a single element; callers that can
    * disambiguate from context (or want to report the ambiguity) use this.
    */
   getElementsByName(name: string, type?: string, languageId?: string): readonly AstNodeDescription[] {
      const candidates = this.elementsByName.get(name);
      if (!candidates || candidates.length === 0) {
         return [];
      }
      const byType = type ? candidates.filter(candidate => this.astReflection.isSubtype(candidate.type, type)) : candidates;
      if (languageId === undefined) {
         return byType;
      }
      return byType.filter(candidate => this.languageIdOf(candidate.documentUri) === languageId);
   }

   /**
    * O(1) lookup by exact name, returning the FIRST match — optionally
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
         for (const description of bucket) {
            if (!memberUriSet.has(description.documentUri.toString())) {
               continue;
            }
            if (type && !this.astReflection.isSubtype(description.type, type)) {
               continue;
            }
            result.push(description);
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
