// AST → GModel for the __GRAMMAR__ diagram: one node per `__NODE_RULE__`, one
// edge per resolved `target` reference.
//
// Ids come from the index rather than being composed here, so the id strategy
// stays in one place. Nodes are emitted before edges, because a GLSP edge
// pointing at an id that does not exist fails client-side with a far less
// obvious error than a missing edge. An unresolved reference is SKIPPED rather
// than treated as an error: a dangling reference is ordinary editing state, and
// the language already reports it as a diagnostic. A reference into another
// document is skipped for the same reason: the graph holds only this
// document's nodes, so its target has no id here.
//
// The starter grammar persists no positions, so the nodes are placed in a row
// in document order; at the origin each would be drawn over the one before.

import { DefaultTypes, GEdge, GGraph, GLabel, type GModelFactory, GNode, ModelState } from '@eclipse-glsp/server';
import { AstUtils } from '@hydranium/langium';
import { __GRAMMAR_ID_CONST___EDGE_TYPE, __GRAMMAR_ID_CONST___NODE_TYPE } from '__PROTOCOL_PACKAGE__';
import { inject, injectable } from 'inversify';
import type { __ENTRY_RULE__ } from '../../language-server/ast.js';
import type { __GRAMMAR__GlspState } from './state.js';

/** The distance between two nodes' left edges in the row. */
const NODE_SPACING = 160;

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
      for (const [index, node] of root.nodes.entries()) {
         const id = this.modelState.index.createId(node);
         graph.children.push(
            GNode.builder()
               .id(id)
               .type(__GRAMMAR_ID_CONST___NODE_TYPE)
               .position(index * NODE_SPACING, 0)
               // Sized by the client around its label, which it lays out.
               .layout('vbox')
               .addLayoutOptions({ paddingLeft: 12, paddingRight: 12, paddingTop: 8, paddingBottom: 8 })
               .add(GLabel.builder().id(`${id}_name`).text(node.name).type(DefaultTypes.LABEL).build())
               .build()
         );
      }
      for (const node of root.nodes) {
         const target = node.target?.ref;
         if (!target || AstUtils.findRootNode(target) !== root) {
            continue;
         }
         const sourceId = this.modelState.index.createId(node);
         graph.children.push(
            GEdge.builder()
               .id(`${sourceId}_target`)
               .type(__GRAMMAR_ID_CONST___EDGE_TYPE)
               .sourceId(sourceId)
               .targetId(this.modelState.index.createId(target))
               .build()
         );
      }
   }
}
