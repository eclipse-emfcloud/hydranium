/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { type Tracer } from '@hydranium/protocol';
import { type AstNode, type Reference } from '@hydranium/langium';
import { type LogNameOptions } from '../diagnostics/logger.js';
import { type HydraniumLanguageServices } from '../language-module.js';
import { type NameProvider } from '../naming/name-provider.js';

/**
 * Reference-construction service — turns a (target, source) pair into the
 * `$refText` an author would type, or a full Langium {@link Reference}.
 *
 * Split off {@link NameProvider} because reference *construction* is more than
 * naming: it composes a name *tier* (own / document- / project-qualified) with
 * **project visibility policy** (`ProjectManager.isVisible` / `getProjectForNode`)
 * and adopter-specific `$refText` encoding. The visibility coupling is a
 * different dependency axis from "what is this node's name", so it lives here
 * — the construction dual of the resolution-side candidate / scope providers.
 *
 * Reads names from {@link NameProvider}; resolves project ownership +
 * visibility from the shared `ProjectManager`. Adopters override
 * `encodeRefText` for grammar-specific `$refText` escaping.
 */
export interface ReferenceBuilder {
   /**
    * The **reference name** targeting `target` from `source`'s context. Picks
    * document-qualified or project-qualified form based on whether source
    * and target share a project (via `ProjectManager`), gates cross-project
    * references through `ProjectManager.isVisible`, and passes the result
    * through {@link DefaultReferenceBuilder.encodeRefText} for adopter-specific
    * character escaping.
    *
    * Returns `undefined` when no reference can be formed: target is
    * undefined, target has no nameable form, or cross-project visibility
    * forbids the reference.
    *
    * Source-aware sibling of {@link NameProvider.getProjectQualifiedName} /
    * {@link NameProvider.getDocumentQualifiedName}: callers pass the containing
    * node and get back the form that the source-text writer would type.
    *
    * A reference name is **not a fourth qualification level** — it is a policy
    * *over* the levels (document-qualified within a project, project-qualified
    * across one) plus escaping.
    */
   getReferenceName(target?: AstNode, source?: AstNode): string | undefined;

   /**
    * Reference shape constructor for an own-scope (bare) reference.
    * Returns `undefined` when {@link NameProvider.getOwnName} returns
    * `undefined` — surfaces real "node has no name" failures synchronously
    * instead of producing an invalid `$refText: ''` that fails at link time
    * with lost context.
    */
   toOwnReference<T extends AstNode>(target: T | undefined): Reference<T> | undefined;

   /** Document-qualified sibling of {@link toOwnReference}. */
   toDocumentReference<T extends AstNode>(target: T | undefined): Reference<T> | undefined;

   /** Project-qualified sibling of {@link toOwnReference}. */
   toProjectReference<T extends AstNode>(target: T | undefined): Reference<T> | undefined;

   /**
    * Visibility-aware reference constructor — uses {@link getReferenceName}
    * to pick document- vs project-qualified form based on the source /
    * target relationship and to gate forbidden cross-project references.
    * Returns `undefined` when no reference can be formed.
    */
   toReference<T extends AstNode>(target: T | undefined, source?: AstNode): Reference<T> | undefined;
}

/**
 * Default {@link ReferenceBuilder}. Reads names from the bound
 * {@link NameProvider} and project ownership / visibility from the shared
 * `ProjectManager`. Each `to*Reference` constructor is virtual and routes its
 * `$refText` through {@link encodeRefText}, so an adopter that needs
 * grammar-specific escaping overrides that one hook and every constructor
 * (plus {@link getReferenceName}) picks it up.
 */
export class DefaultReferenceBuilder implements ReferenceBuilder {
   protected readonly nameProvider: NameProvider;
   protected readonly tracer: Tracer;

   constructor(
      protected readonly services: HydraniumLanguageServices,
      options: LogNameOptions = {}
   ) {
      this.nameProvider = services.references.NameProvider;
      this.tracer = services.shared.Tracer.for(options.logName ?? 'ReferenceBuilder').trace('instantiated');
   }

   /**
    * Override hook for adopter-specific `$refText` encoding (escape rules,
    * delimiter handling, etc.). Default: identity — the qualified name
    * goes into `$refText` unchanged.
    *
    * Deliberately the SOURCE language's concern, unlike name derivation
    * below: escaping makes the text safe to write into the source document's
    * syntax, so it follows the grammar doing the writing.
    */
   protected encodeRefText(name: string): string {
      return name;
   }

   /**
    * The `NameProvider` of the language that owns `target`'s document.
    *
    * **Name derivation follows the TARGET, not the source.** A name is a fact
    * about the element being named — which properties carry it, how segments
    * are joined — and both are per-language (`nameProperties`,
    * `nameSeparator`). Deriving a cross-grammar target's name with the source
    * language's provider yields `undefined` or an unmatchable `$refText`
    * whenever the two differ, and the result is a permanently dangling
    * reference with no diagnostic: the text is written, it just never
    * resolves.
    *
    * Falls back to the source's provider when the target's document is
    * unroutable — a synthetic node with no document, a URI matching no
    * registered language, or a services tree with no registry at all (the
    * minimal trees unit tests build). That is the best available guess, not a
    * decision.
    *
    * Mirrored by `DefaultReferenceCandidateProvider.nameProviderFor` for the
    * candidate side; both go through `ServiceRegistry.getServicesFor`, which
    * owns the node-to-document step and the abstain-instead-of-throw.
    */
   protected nameProviderFor(target: AstNode): NameProvider {
      return this.services.shared.ServiceRegistry?.getServicesFor(target)?.references.NameProvider ?? this.nameProvider;
   }

   /** Resolve the project id owning `node`, or `undefined` if outside any project. */
   protected getProjectIdFor(node?: AstNode): string | undefined {
      return node ? this.services.shared.workspace.ProjectManager.getProjectForNode(node)?.id : undefined;
   }

   getReferenceName(target?: AstNode, source?: AstNode): string | undefined {
      if (!target) {
         return undefined;
      }
      const sourceProjectId = this.getProjectIdFor(source);
      const targetProjectId = this.getProjectIdFor(target);
      if (sourceProjectId && targetProjectId) {
         const projectManager = this.services.shared.workspace.ProjectManager;
         // selfVisible: a project references its own elements.
         if (!projectManager.isVisible(sourceProjectId, targetProjectId, true)) {
            return undefined;
         }
      }
      const nameProvider = this.nameProviderFor(target);
      const name =
         sourceProjectId && sourceProjectId === targetProjectId
            ? nameProvider.getDocumentQualifiedName(target)
            : nameProvider.getProjectQualifiedName(target);
      return name ? this.encodeRefText(name) : undefined;
   }

   toOwnReference<T extends AstNode>(target: T | undefined): Reference<T> | undefined {
      if (!target) {
         return undefined;
      }
      const name = this.nameProviderFor(target).getOwnName(target);
      return name ? { ref: target, $refText: this.encodeRefText(name) } : undefined;
   }

   toDocumentReference<T extends AstNode>(target: T | undefined): Reference<T> | undefined {
      if (!target) {
         return undefined;
      }
      const name = this.nameProviderFor(target).getDocumentQualifiedName(target);
      return name ? { ref: target, $refText: this.encodeRefText(name) } : undefined;
   }

   toProjectReference<T extends AstNode>(target: T | undefined): Reference<T> | undefined {
      if (!target) {
         return undefined;
      }
      const name = this.nameProviderFor(target).getProjectQualifiedName(target);
      return name ? { ref: target, $refText: this.encodeRefText(name) } : undefined;
   }

   toReference<T extends AstNode>(target: T | undefined, source?: AstNode): Reference<T> | undefined {
      if (!target) {
         return undefined;
      }
      const refText = this.getReferenceName(target, source);
      return refText ? { ref: target, $refText: refText } : undefined;
   }
}
