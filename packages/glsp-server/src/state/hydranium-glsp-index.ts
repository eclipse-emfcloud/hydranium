/********************************************************************************
 * Copyright (c) 2023-2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { type GModelElement, GModelIndex } from '@eclipse-glsp/server';
import { inject, injectable, optional } from 'inversify';
import { type AstNode, AstUtils, type URI } from '@hydranium/langium';
import * as uuid from 'uuid';
import { type ElementKeyProvider, type ServerLanguageServices, type ServerSharedServices } from '@hydranium/core';
import { HydraniumTypes } from './hydranium-shared-core-services.js';

/**
 * GLSP model index extended with an AST-node ↔ id map so adopters can
 * resolve diagram elements back to their source-language nodes during
 * action handling, layout, validation, and submission.
 *
 * Indexing strategy is hookable via {@link doFindId}: the framework default
 * uses {@link ElementKeyProvider.getElementKey} — a document-scoped lookup
 * token built from the node's named ancestors, falling back to positional
 * segments for unnamed nodes. Under the bound default that key is name-based,
 * so a GModel id survives an edit that does not rename the node or an ancestor
 * and changes when one does; the positional strategy is the rename-stable
 * alternative. Adopters with a different stability boundary override
 * {@link doFindId}.
 *
 * **Duplicate-id degrade.** A GModel tree must have unique element ids. Two
 * AST nodes that collide on their stable id — exactly the state the diagram is
 * meant to *mark* — project to two GModel elements with the same id. The GLSP
 * client's sprotty `SGraphIndex.add` throws on such a duplicate inside
 * `SModelFactory.initializeRoot`, aborting the build and blanking the WHOLE
 * diagram. {@link indexRoot} prunes the colliding element(s) from the tree —
 * the same object `ModelSubmissionHandler`
 * submits — so the wire payload stays well-formed for every client and the
 * surviving (first, document-order) element still carries the diagnostic
 * marker. {@link doIndex} keeps a log-and-skip guard for any path that
 * re-indexes a subtree without going through {@link indexRoot}.
 */
@injectable()
export class HydraniumGlspIndex extends GModelIndex {
   @inject(HydraniumTypes.SharedCoreServices) protected readonly sharedServices!: ServerSharedServices;

   protected idToSemanticNode = new Map<string, AstNode>();

   /**
    * The language services of the diagram's OWN document, captured from the
    * source root in {@link indexSourceRoot}. Used only as the fallback for a
    * node that routes nowhere — a synthetic or freshly-built node with no
    * `$document` yet, which a GModel factory legitimately hands us mid-edit.
    *
    * Captured rather than injected because it is the language the loaded
    * document ACTUALLY routes to, which is not necessarily the one the diagram
    * module declared — precisely the drift
    * `AbstractHydraniumGlspState.checkDeclaredLanguage` warns about. (Not
    * a cost argument: {@link HydraniumTypes}.DiagramLanguage is bound
    * `inSingletonScope`, so injecting it would resolve once per session too.)
    */
   protected diagramLanguage?: ServerLanguageServices;

   /**
    * The grammar the diagram module declared, as the last resort behind
    * {@link diagramLanguage}.
    *
    * Order-independent where the captured one is not: GLSP builds every
    * operation handler at `InitializeClientSession`, so a document-less node
    * can reach {@link createId} before the first {@link indexSourceRoot} — and
    * with no language at all that mints an unstable `fallback_<uuid>` where a
    * stable positional key was available. `@optional()` so a harness that binds
    * no diagram module still resolves.
    */
   @inject(HydraniumTypes.DiagramLanguage) @optional() protected readonly declaredLanguage?: ServerLanguageServices;

   /**
    * Reverse map: the *stable id* of the AST element a GModel element
    * represents → the GModel id(s) that render it. Multi-valued because one
    * element can be drawn as several GModel nodes — placed twice on the same
    * canvas, or projected by several referencing nodes.
    * Populated explicitly by adopters via {@link registerElementId} (the forward
    * {@link idToSemanticNode} keys by GModel id and can't express the same
    * element rendering more than once). Consumed by diagnostic→marker mapping to
    * find every node to mark for a given element.
    *
    * Keyed by the element's stable id (a string), NOT the `AstNode` itself, so
    * it never retains AST node references across rebuilds. Cleared with the
    * forward index in {@link indexSourceRoot}; re-registration each GModel
    * rebuild is idempotent (a Set), and any id no longer drawn is filtered by
    * the consumer's rendered-check, so stale entries are harmless.
    */
   protected elementToIds = new Map<string, Set<string>>();

   /**
    * The uris of the documents whose elements can map to a marker on this
    * diagram: the diagram's own document (seeded in {@link indexSourceRoot})
    * plus every document reached through a reference projection (added in
    * {@link registerElementId}). Lets the diagnostic→marker validator resolve
    * only the documents that actually contribute rendered elements rather than
    * every loaded document. Self-maintaining: every {@link registerElementId}
    * caller auto-includes its document.
    */
   protected renderedDocUris = new Set<string>();

   /**
    * Return the GModel id assigned to `node`, or — when no id is found and
    * a `fallback` is supplied — the value of `fallback()`. The two-overload
    * shape preserves the caller's narrowing: with a `() => string` fallback
    * the return is `string`; with a `() => string | undefined` (or no
    * fallback) the return is `string | undefined`.
    *
    * A convenience over {@link doFindId}, NOT the id-strategy hook. Framework
    * internals call `doFindId` directly (see {@link indexSourceRoot}), so an
    * override here changes only what external callers of this method see —
    * override `doFindId` to change how nodes are keyed.
    */
   findId(node: AstNode | undefined, fallback: () => string): string;
   findId(node: AstNode | undefined, fallback?: () => string | undefined): string | undefined;
   findId(node: AstNode | undefined, fallback: () => string | undefined = () => undefined): string | undefined {
      return this.doFindId(node) ?? fallback();
   }

   /**
    * Hook for the adopter id-assignment strategy. Framework default reads
    * {@link ElementKeyProvider.getElementKey} from the language owning `node`,
    * which under the bound default is name-based and falls back to positional
    * segments for unnamed nodes.
    *
    * `keyProvider` is an optional hint: the provider for THIS node, already
    * resolved by the caller. {@link indexSourceRoot} passes it because every
    * node in a containment walk belongs to the root's document by
    * construction, so the per-node lookup would re-derive one known answer N
    * times. An override that ignores the parameter stays correct, at the cost
    * of that lookup.
    */
   protected doFindId(node?: AstNode, keyProvider?: ElementKeyProvider): string | undefined {
      return (keyProvider ?? this.elementKeyProviderFor(node))?.getElementKey(node);
   }

   /**
    * The {@link ElementKeyProvider} of the language owning `node`'s document,
    * falling back to the language the diagram document routes to and then to
    * the one its module declared, for a node that routes nowhere.
    *
    * **Resolved per node on the cross-document entry points.** This index is
    * deliberately cross-document — {@link registerElementId} and
    * {@link findElementIds} key elements reached through a reference, and
    * {@link renderedDocUris} exists precisely because those live in other
    * documents. A single captured provider therefore keys foreign nodes under
    * the wrong grammar as soon as two registered languages differ in their key
    * strategy: a plausible-looking id that matches nothing, so selection,
    * marker mapping and element lookup silently miss. Those entry points are a
    * bounded set the adopter calls explicitly; the full-document walk in
    * {@link indexSourceRoot} needs no per-node lookup and does not pay for one.
    */
   protected elementKeyProviderFor(node?: AstNode): ElementKeyProvider | undefined {
      const language = this.sharedServices.ServiceRegistry.getServicesFor(node) ?? this.diagramLanguage ?? this.declaredLanguage;
      return language?.references.ElementKeyProvider;
   }

   /** Return the GModel id assigned to `node`, falling back to a fresh `fallback_<uuid>`. */
   createId(node?: AstNode): string {
      return this.findId(node, () => 'fallback_' + uuid.v4());
   }

   /**
    * Return the GModel id assigned to `node` or throw if none is available.
    *
    * The failure names the node's type and position rather than its source
    * text. Interpolating `$cstNode.text` would put the user's own model content
    * into a string that reaches a log, a client toast and an adopter's
    * telemetry alike, so the exposure does not depend on which surface
    * receives it. Type and position identify the node for whoever is debugging
    * without carrying any of it, and positions are 1-based so they match what
    * an editor shows.
    */
   assertId(node?: AstNode): string {
      const id = this.findId(node);
      if (!id) {
         const start = node?.$cstNode?.range.start;
         const at = start === undefined ? '' : ` at ${start.line + 1}:${start.character + 1}`;
         throw new Error(`Could not create ID for ${node?.$type ?? 'an absent node'}${at}`);
      }
      return id;
   }

   /**
    * Walk the source root and index every reachable AST node with a resolvable
    * id.
    *
    * `uri` is the diagram document's URI, supplied by
    * `AbstractHydraniumGlspState.setSourceRoot`, and is used only to
    * resolve the diagram's language when `root` carries no `$document` —
    * always the case for a synthesised root, and the more authoritative signal
    * either way since it is what the caller declared it was loading.
    *
    * The walk resolves the key provider ONCE and threads it: `streamAllContents`
    * is containment-only, so every node it yields has `root` as its root node
    * and therefore the language just resolved. Looking it up per node would
    * walk the container chain and Langium's whole lookup ladder — declared
    * languageId, file name, extension — for an answer already in hand, on every
    * diagram open and every source-root refresh.
    */
   indexSourceRoot(root: AstNode, uri?: URI | string): void {
      this.idToSemanticNode.clear();
      this.elementToIds.clear();
      this.renderedDocUris.clear();
      const registry = this.sharedServices.ServiceRegistry;
      this.diagramLanguage = registry.getServicesFor(root) ?? registry.getServicesFor(uri);
      this.addRenderedDocUri(root);
      const keyProvider = this.elementKeyProviderFor(root);
      AstUtils.streamAllContents(root).forEach(node => this.indexAstNode(node, keyProvider));
   }

   /**
    * Register that the GModel element `id` renders `element` — the reverse of
    * the GModel-id keying. Adopters call this when a GModel element represents
    * an AST element that is *not* keyed by its own id — most importantly a
    * diagram node keyed by its own id while visually standing for the element
    * it references. Additive: registering the same `element` under several ids
    * records every occurrence.
    */
   registerElementId(element: AstNode, id: string): void {
      const key = this.doFindId(element);
      if (key === undefined) {
         return;
      }
      const ids = this.elementToIds.get(key);
      if (ids) {
         ids.add(id);
      } else {
         this.elementToIds.set(key, new Set([id]));
      }
      this.addRenderedDocUri(element);
   }

   /** The uris of the documents that contribute elements rendered on this diagram. */
   renderedDocumentUris(): readonly string[] {
      return [...this.renderedDocUris];
   }

   /** Record `node`'s document uri (if it has one) as contributing rendered elements. */
   protected addRenderedDocUri(node: AstNode): void {
      const uri = AstUtils.findRootNode(node).$document?.uri.toString();
      if (uri !== undefined) {
         this.renderedDocUris.add(uri);
      }
   }

   /** The GModel ids registered (via {@link registerElementId}) as rendering `element`; empty if none. */
   findElementIds(element?: AstNode): readonly string[] {
      const key = element ? this.doFindId(element) : undefined;
      const ids = key !== undefined ? this.elementToIds.get(key) : undefined;
      return ids ? [...ids] : [];
   }

   /** `keyProvider` is {@link doFindId}'s already-resolved hint; see {@link indexSourceRoot}. */
   protected indexAstNode(node: AstNode, keyProvider?: ElementKeyProvider): void {
      const id = this.doFindId(node, keyProvider);
      if (id) {
         this.indexSemanticElement(id, node);
      }
   }

   /** Insert an AST node under `id` directly — for adopters that need to seed entries outside the standard walk. */
   indexSemanticElement<T extends AstNode>(id: string, element: T): void {
      this.idToSemanticNode.set(id, element);
   }

   /** Look up the AST node previously indexed under `id`. */
   findSemanticElement(id: string): AstNode | undefined;
   findSemanticElement<T extends AstNode>(id: string, guard: (item: unknown) => item is T): T | undefined;
   findSemanticElement<T extends AstNode>(id: string, guard?: (item: unknown) => item is T): T | AstNode | undefined {
      const semanticNode = this.idToSemanticNode.get(id);
      if (guard) {
         return guard(semanticNode) ? semanticNode : undefined;
      }
      return semanticNode;
   }

   /**
    * Prune duplicate-id elements from the GModel tree, then index it.
    *
    * {@link GModelIndex.indexRoot} runs on the exact object the submission
    * handler later serializes (`DefaultModelState.updateRoot` assigns
    * `this.root = newRoot` immediately before `this.index.indexRoot(newRoot)`),
    * so removing duplicates here also removes them from the submitted payload —
    * the only place the fix protects every client rather than one tolerant one.
    */
   override indexRoot(root: GModelElement): void {
      this.pruneDuplicateIds(root);
      super.indexRoot(root);
   }

   /**
    * Remove every element whose id was already seen earlier in a depth-first
    * walk; the first occurrence (document order) wins and a dropped element
    * takes its whole subtree with it. Splices in place so the parent's
    * `children` array identity is preserved; logs each drop via the bound
    * logger. The root itself is the first id seen and can never be a duplicate.
    */
   protected pruneDuplicateIds(root: GModelElement): void {
      const seen = new Set<string>([root.id]);
      const visit = (element: GModelElement): void => {
         const children = element.children;
         let index = 0;
         while (index < children.length) {
            const child = children[index];
            if (seen.has(child.id)) {
               this.sharedServices.Logger.for('Index').warn('Dropping duplicate element id from submitted graph: ' + child.id);
               children.splice(index, 1); // drop child + subtree; do not advance — the next child shifts into `index`
            } else {
               seen.add(child.id);
               visit(child);
               index++;
            }
         }
      };
      visit(root);
   }

   /**
    * Log-and-skip guard for duplicate GModel ids. {@link indexRoot}'s prune
    * already removes duplicates from the tree before this runs, so in the
    * normal flow this never fires; it stays as a last line of defence for any
    * path that re-indexes a subtree directly (where {@link GModelIndex.doIndex}
    * would otherwise throw).
    */
   protected override doIndex(element: GModelElement): void {
      if (this.idToElement.has(element.id)) {
         this.sharedServices.Logger.for('Index').error('Duplicate element id in graph: ' + element.id);
         return;
      }
      super.doIndex(element);
   }
}
