/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { type Tracer } from '@hydranium/protocol';
import { type AstNode } from '@hydranium/langium';
import { type LogNameOptions } from '../diagnostics/logger.js';
import { type ServerLanguageServices } from '../language-module.js';
import { type ElementKeyProvider, resolveElementByScan } from './element-key-provider.js';
import { type NameProvider } from '../naming/name-provider.js';

/**
 * Name-based {@link ElementKeyProvider} — walks named ancestors stopping at the
 * semantic root, joining segments with `NameProvider.nameSeparator`.
 *
 * **The framework's default key strategy.** Optimised for interactive
 * editing workloads where reorder/insert/delete are frequent and renames
 * of intermediate ancestors are rare.
 *
 * # Stability profile
 *
 * **The bullets below hold for nodes that HAVE a name.** A node with no
 * name — and any node below one — is keyed through
 * {@link unidentifiedSegment}, which encodes `$containerIndex`; see the
 * caveat below.
 *
 * - **Stable across sibling reorder** — segments are names, not indices,
 *   so reordering siblings of a named node does not change its key.
 * - **Stable across mid-array insert / delete** — same reason: indices
 *   are not encoded.
 * - **Stable across semantic-root rename** — the predicate excludes the
 *   semantic root from the key by construction.
 * - **Flips on rename of any named segment** within the walked path.
 *
 * # Caveat: unnamed nodes are keyed positionally
 *
 * {@link unidentifiedSegment} falls back to
 * `` `${$containerProperty}@${$containerIndex}` `` for a node the
 * `NameProvider` gives no name. For grammars with unnamed element types the
 * reorder / insert / delete stability above does NOT apply to those nodes:
 * their keys move when their index moves, so a mid-array insert or delete
 * renumbers every later sibling.
 *
 * Two consequences for a caller creating such nodes programmatically
 * (a GLSP operation handler is the usual case):
 *
 * - A node appended with a bare `array.push` has no `$containerProperty` /
 *   `$containerIndex`, so `getElementKey` returns `undefined` and the node
 *   has no key at all. The containment plumbing has to be stamped.
 * - After a removal, surviving siblings need their `$containerIndex`
 *   renumbered, or a key derived afterwards addresses the wrong node.
 *
 * {@link appendChild} and {@link removeChildren} discharge both, and ship
 * beside this provider because the constraint is this provider's rather than
 * any caller's.
 *
 * Adopters that need insert / delete stability for unnamed types should
 * give those types a name in the grammar, or bind a key provider whose
 * fallback is content-derived rather than positional.
 *
 * Override {@link isSemanticRoot} if the grammar's root structure does not
 * match either shape that predicate handles.
 */
export class NameBasedKeyProvider implements ElementKeyProvider {
   protected readonly nameProvider: NameProvider;
   protected readonly tracer: Tracer;

   constructor(
      protected readonly services: ServerLanguageServices,
      options: LogNameOptions = {}
   ) {
      this.nameProvider = services.references.NameProvider;
      this.tracer = services.shared.Tracer.for(options.logName ?? this.constructor.name).trace('instantiated');
   }

   getElementKey(node?: AstNode): string | undefined {
      if (!node) {
         return undefined;
      }
      let id = this.nameProvider.getOwnName(node) ?? this.unidentifiedSegment(node);
      if (!id) {
         return undefined;
      }
      if (this.isSemanticRoot(node)) {
         return id;
      }
      const separator = this.nameProvider.nameSeparator;
      let parent = node.$container;
      while (parent && !this.isSemanticRoot(parent)) {
         const segment = this.nameProvider.getOwnName(parent) ?? this.unidentifiedSegment(parent);
         if (segment) {
            id = segment + separator + id;
         }
         parent = parent.$container;
      }
      return id;
   }

   /**
    * No structural inverse — keys are name-paths, not addressable locations —
    * so resolve by scanning `context`'s subtree for the first node whose key
    * matches. O(subtree); the GLSP index keeps its own key-to-node map, so
    * this is the canonical / testable inverse rather than a hot path. See
    * {@link ElementKeyProvider.resolveElement} for the scope and uniqueness
    * contract.
    */
   resolveElement(key: string, context: AstNode): AstNode | undefined {
      return resolveElementByScan(node => this.getElementKey(node), key, context);
   }

   /**
    * Semantic-root predicate. Default implementation matches two common
    * grammar shapes; override for non-standard structures:
    *
    * - **Document root with no container**: the root itself is the
    *   semantic root iff it has a name (covers unwrapped grammars whose
    *   named root element IS the semantic root).
    * - **Direct child of an unnamed wrapper**: the child is the semantic
    *   root (covers wrapper grammars with an unnamed root node).
    *
    * A node more than one container below the document root is never a
    * semantic root in the default heuristic.
    */
   protected isSemanticRoot(node: AstNode): boolean {
      if (!node.$container) {
         return this.nameProvider.hasName(node);
      }
      if (!node.$container.$container) {
         return !this.nameProvider.hasName(node.$container);
      }
      return false;
   }

   /**
    * Fallback segment for unnamed intermediate ancestors —
    * `containerProperty@containerIndex`. Returns `undefined` when the
    * node has no container position, which short-circuits the walk.
    */
   protected unidentifiedSegment(node: AstNode): string | undefined {
      if (node.$containerProperty === undefined || node.$containerIndex === undefined) {
         return undefined;
      }
      return `${node.$containerProperty}@${node.$containerIndex}`;
   }
}
