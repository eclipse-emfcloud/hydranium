/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { HydraniumScopeProvider } from '@hydranium/core';
import { AstUtils, EMPTY_SCOPE, type ReferenceInfo, type Scope } from '@hydranium/langium';
import { type DiagramNode, isDiagramNode, isLayoutModel } from './ast.js';

/**
 * Scope provider for the `*.layout` language, supplying the one **dependent**
 * reference the layout grammar has: `DiagramNode.flowNode`.
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
 * So `flowNode` gets exactly the candidates its file declares: the nodes of the
 * `ProcessModel` that this `LayoutModel`'s `process` reference resolved to.
 * Reading `.ref` is what drives the chain — it triggers the linker for `process`
 * so the candidate set is computed against a resolved target. The `.layout` →
 * `.process` dependency is one-way by design, which is what keeps that from
 * cycling.
 *
 * This is the same dependent-reference shape `OrderFlowProcessScopeProvider`
 * needs for `writes Order.status = PAID`, one grammar over. Worth noting the two
 * arrived at it for different reasons: there, the default scope was too WIDE in a
 * way that accepted invalid input; here, it is too wide in a way that accepts
 * input which is valid but means something else. Both are cases where a
 * cross-document reference that resolves is not the same as one that is scoped.
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

   /** The flow nodes of the process this layout file declares itself `for`. */
   protected createFlowNodeScope(node: DiagramNode): Scope {
      const process = AstUtils.getContainerOfType(node, isLayoutModel)?.process.ref;
      return process ? this.createScopeForNodes(process.nodes) : EMPTY_SCOPE;
   }
}
