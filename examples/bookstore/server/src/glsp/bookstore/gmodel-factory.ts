/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

// AST → GModel for the Bookstore diagram: one node per `BookstoreNode`, one
// edge per resolved `target` reference.
//
// Ids come from the index rather than being composed here, so the id strategy
// stays in one place. An id derived from a node's, for its label, its edge or an
// external node, appends a suffix starting with `-`, which the grammar's `ID`
// does not allow, so it never clashes with a node's own. Nodes are emitted
// before edges, because a GLSP edge pointing at an id that does not exist fails
// client-side with a far less obvious error than a missing edge. An unresolved
// reference is SKIPPED rather than treated as an error: a dangling reference is
// ordinary editing state, and the language already reports it as a diagnostic.
//
// A reference into another document is drawn to an external node standing for
// its target, once however many nodes reference it, so the diagram shows what
// the editor resolves. The target's own diagnostics stay with its document.
//
// The starter grammar persists no positions, so the nodes are placed in a grid:
// each one row above its target, and side by side in document order within a
// row. Without a cycle every edge spans one row; a cycle is cut where the walk
// meets a node it is still ranking, and its closing edge spans the cycle.

import { DefaultTypes, GEdge, GGraph, GLabel, type GModelFactory, GNode, ModelState } from '@eclipse-glsp/server';
import { AstUtils, UriUtils } from '@hydranium/langium';
import { BOOKSTORE_EDGE_TYPE, BOOKSTORE_EXTERNAL_NODE_TYPE, BOOKSTORE_NODE_TYPE } from '@hydranium/bookstore-protocol';
import { inject, injectable } from 'inversify';
import type { BookstoreModel, BookstoreNode } from '../../language-server/ast.js';
import type { BookstoreGlspState } from './state.js';

/** The size of one cell of the grid the nodes are placed in, a column wide and a row high. */
const CELL = { width: 200, height: 90 };

@injectable()
export class BookstoreGModelFactory implements GModelFactory {
   @inject(ModelState) protected readonly modelState!: BookstoreGlspState;

   createModel(): void {
      const root = this.modelState.sourceRoot;
      const graph = GGraph.builder().id(this.modelState.sourceUri).build();
      if (root) {
         this.buildGraph(root, graph);
      }
      this.modelState.updateRoot(graph);
   }

   protected buildGraph(root: BookstoreModel, graph: GGraph): void {
      const index = this.modelState.index;
      // A repeated name repeats the id: only its first node is drawn, with that node's edge.
      const drawn = new Map<string, BookstoreNode>();
      for (const node of root.nodes) {
         const id = index.createId(node);
         if (!drawn.has(id)) {
            drawn.set(id, node);
         }
      }
      const nodes = [...drawn].map(([id, node]) => ({ id, builder: this.createNode(id, BOOKSTORE_NODE_TYPE, node.name) }));
      const edges: GEdge[] = [];
      const targetOf = new Map<string, string>();
      // By document and id: same-named targets of two documents get separate
      // nodes, the second with a counter, not a uri in a client-visible id.
      const externalIds = new Map<string, string>();
      const externalCounts = new Map<string, number>();
      for (const [sourceId, node] of drawn) {
         const target = node.target?.ref;
         if (!target) {
            continue;
         }
         let targetId = index.createId(target);
         if (AstUtils.findRootNode(target) !== root) {
            const uri = AstUtils.getDocument(target).uri;
            const key = `${uri.toString()} ${targetId}`;
            const known = externalIds.get(key);
            if (known !== undefined) {
               targetId = known;
            } else {
               const count = (externalCounts.get(targetId) ?? 0) + 1;
               externalCounts.set(targetId, count);
               targetId = count === 1 ? `${targetId}-external` : `${targetId}-external-${count}`;
               externalIds.set(key, targetId);
               const file = UriUtils.basename(uri);
               const external = this.createNode(targetId, BOOKSTORE_EXTERNAL_NODE_TYPE, `${target.name} (${file})`);
               nodes.push({ id: targetId, builder: external.addCssClass('external') });
            }
         }
         targetOf.set(sourceId, targetId);
         edges.push(GEdge.builder().id(`${sourceId}-target`).type(BOOKSTORE_EDGE_TYPE).sourceId(sourceId).targetId(targetId).build());
      }
      const ids = nodes.map(node => node.id);
      const ranks = this.rank(targetOf, ids);
      // Loops rather than spread arguments, which overflow the stack on a large diagram.
      let lastRow = 0;
      for (const rank of ranks.values()) {
         lastRow = Math.max(lastRow, rank);
      }
      const columns = new Map<number, number>();
      const placed = nodes.map(({ id, builder }) => {
         const row = lastRow - (ranks.get(id) ?? 0);
         const column = columns.get(row) ?? 0;
         columns.set(row, column + 1);
         return builder.position(column * CELL.width, row * CELL.height).build();
      });
      for (const child of [...placed, ...edges]) {
         graph.children.push(child);
      }
   }

   /**
    * Each node's row counted up from the bottom: one more than its target's,
    * and 0, left out of the map, for a node that references nothing here. A
    * cycle is cut where the walk meets itself.
    */
   protected rank(targetOf: ReadonlyMap<string, string>, ids: readonly string[]): Map<string, number> {
      const ranks = new Map<string, number>();
      for (const start of ids) {
         // Walked in a loop, not recursively, so a long chain does not overflow the stack.
         const walk = new Set<string>();
         let id = start;
         let target = targetOf.get(id);
         while (target !== undefined && !walk.has(id) && !ranks.has(id)) {
            walk.add(id);
            id = target;
            target = targetOf.get(id);
         }
         let rank = ranks.get(id) ?? 0;
         for (const walked of [...walk].reverse()) {
            rank += 1;
            ranks.set(walked, rank);
         }
      }
      return ranks;
   }

   /** A node labelled `text`, placed and built by the caller. */
   protected createNode(id: string, type: string, text: string) {
      return (
         GNode.builder()
            .id(id)
            .type(type)
            // Sized by the client around its label, which it lays out.
            .layout('vbox')
            .addLayoutOptions({ paddingLeft: 12, paddingRight: 12, paddingTop: 8, paddingBottom: 8 })
            .add(GLabel.builder().id(`${id}-name`).text(text).type(DefaultTypes.LABEL).build())
      );
   }
}
