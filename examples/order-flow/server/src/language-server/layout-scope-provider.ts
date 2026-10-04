/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { HydraniumScopeProvider } from '@hydranium/core';
import { AstUtils, EMPTY_SCOPE, type ReferenceInfo, type Scope, URI } from '@hydranium/langium';
import { type DiagramNode, isDiagramNode, isProcessModel } from './ast.js';
import { processUriFor } from './layout-file.js';

/**
 * Scope provider for the `*.layout` language, narrowing the one reference the
 * layout grammar has: `DiagramNode.flowNode`.
 *
 * Without this the reference still type-checks and still resolves — which is
 * exactly the trap. Langium exports a document's root node AND its direct
 * children to the global index, and `FlowNode`s are direct children of
 * `ProcessModel`, so `[FlowNode:ID]` falls back to a global lookup filtered by
 * type: every flow node in the workspace. A layout entry would then bind to a
 * same-named `task Approve` in an unrelated process and position the wrong
 * element, silently, with no diagnostic — and the happy path would still work,
 * because in a one-process workspace the accidental answer is the right one.
 *
 * So `flowNode` gets exactly the candidates of the process this layout belongs
 * to: the nodes of the `ProcessModel` in the same-named `.process` file, the
 * file the diagram pairs it with. A layout with no such file has no candidates,
 * so its entries fail to link instead of positioning nodes of some other
 * process. The `.layout` → `.process` dependency is one-way by design, which is
 * what keeps the lookup from cycling.
 *
 * `OrderFlowProcessScopeProvider` narrows `writes Order.status = PAID` for a
 * related reason: there, the default scope was too WIDE in a way that accepted
 * invalid input; here, it is too wide in a way that accepts input which is valid
 * but means something else. Both are cases where a cross-document reference that
 * resolves is not the same as one that is scoped.
 *
 * `createScopeForNodes` is the framework's re-keyed override of Langium's, so
 * entries come out under the bare segment the reference text carries. No
 * `outerScope` is passed, which is what makes a layout entry naming a node of
 * some *other* process fail to link rather than quietly find it.
 */
export class OrderFlowLayoutScopeProvider extends HydraniumScopeProvider {
   override getScope(context: ReferenceInfo): Scope {
      if (context.property === 'flowNode' && isDiagramNode(context.container)) {
         return this.createFlowNodeScope(context.container);
      }
      return super.getScope(context);
   }

   /** The flow nodes of the process in the same-named `.process` file. */
   protected createFlowNodeScope(node: DiagramNode): Scope {
      const processUri = URI.parse(processUriFor(AstUtils.getDocument(node).uri.toString()));
      const process = this.langiumDocuments.getDocument(processUri)?.parseResult.value;
      return isProcessModel(process) ? this.createScopeForNodes(process.nodes) : EMPTY_SCOPE;
   }
}
