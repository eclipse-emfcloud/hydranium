// AST → GModel for the __GRAMMAR__ diagram: one node per `__NODE_RULE__`, one
// edge per resolved `target` reference.
//
// Ids come from the index rather than being composed here, so the id strategy
// stays in one place. Nodes are emitted before edges, because a GLSP edge
// pointing at an id that does not exist fails client-side with a far less
// obvious error than a missing edge. An unresolved reference is SKIPPED rather
// than treated as an error: a dangling reference is ordinary editing state, and
// the LSP head already reports it as a diagnostic.

import { DefaultTypes, GEdge, GGraph, GLabel, type GModelFactory, GNode, ModelState } from '@eclipse-glsp/server';
import { inject, injectable } from 'inversify';
import type { __ENTRY_RULE__ } from '../../language-server/ast.js';
import { __GRAMMAR_ID_CONST___EDGE_TYPE, __GRAMMAR_ID_CONST___NODE_TYPE } from './types.js';
import type { __GRAMMAR__GlspState } from './state.js';

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
      for (const node of root.nodes) {
         const id = this.modelState.index.createId(node);
         graph.children.push(
            GNode.builder()
               .id(id)
               .type(__GRAMMAR_ID_CONST___NODE_TYPE)
               .add(GLabel.builder().id(`${id}_name`).text(node.name).type(DefaultTypes.LABEL).build())
               .build()
         );
      }
      for (const node of root.nodes) {
         const target = node.target?.ref;
         if (!target) {
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
