// AST → GModel for the __GRAMMAR__ diagram: one node per `__NODE_RULE__`, one
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
import { __GRAMMAR_ID_CONST___EDGE_TYPE, __GRAMMAR_ID_CONST___EXTERNAL_NODE_TYPE, __GRAMMAR_ID_CONST___NODE_TYPE } from '__PROTOCOL_PACKAGE__';
import { inject, injectable } from 'inversify';
import type { __ENTRY_RULE__, __NODE_RULE__ } from '../../language-server/ast.js';
import type { __GRAMMAR__GlspState } from './state.js';

/** The size of one cell of the grid the nodes are placed in, a column wide and a row high. */
const CELL = { width: 200, height: 90 };

@injectable()
export class __GRAMMAR__GModelFactory implements GModelFactory {
   @inject(ModelState) protected readonly modelState!: __GRAMMAR__GlspState;

   createModel(): void {
      const root = this.modelState.sourceRoot;
      const graph = GGraph.builder().id(this.modelState.sourceUri).build();
      if (root) {
         this.buildGraph(root, graph);
      }
      this.modelState.updateRoot(graph);
   }

   protected buildGraph(root: __ENTRY_RULE__, graph: GGraph): void {
      const index = this.modelState.index;
      // A repeated name repeats the id: only its first node is drawn, with that node's edge.
      const drawn = new Map<string, __NODE_RULE__>();
      for (const node of root.nodes) {
         const id = index.createId(node);
         if (!drawn.has(id)) {
            drawn.set(id, node);
         }
      }
      const nodes = [...drawn].map(([id, node]) => ({ id, builder: this.createNode(id, __GRAMMAR_ID_CONST___NODE_TYPE, node.name) }));
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
               const external = this.createNode(targetId, __GRAMMAR_ID_CONST___EXTERNAL_NODE_TYPE, `${target.name} (${file})`);
               nodes.push({ id: targetId, builder: external.addCssClass('external') });
            }
         }
         targetOf.set(sourceId, targetId);
         edges.push(GEdge.builder().id(`${sourceId}-target`).type(__GRAMMAR_ID_CONST___EDGE_TYPE).sourceId(sourceId).targetId(targetId).build());
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
