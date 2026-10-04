/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import type { ValidationCheckContribution, ValidationCheckRegistry } from '@hydranium/core';
import { acceptMessage } from '@hydranium/core/messages';
import type { ValidationAcceptor } from '@hydranium/langium';
import { defineMessage } from '@hydranium/protocol';
import type { DiagramNode, FlowNode, LayoutModel, OrderFlowAstType } from './ast.js';

export const OVERRIDDEN_LAYOUT_ENTRY = defineMessage(
   'order-flow/layout/overridden-entry',
   "'{node}' is positioned again further down; this entry is ignored."
);

/**
 * Validation for the `.layout` grammar: an entry a later entry for the same
 * flow node overrides.
 *
 * **A warning, where the process checks are errors.** The file still means
 * something: the diagram draws the LAST entry for a node, and a drag rewrites
 * that one and removes the rest. The earlier entries are dead text a reader
 * would take for the node's position, which is worth saying but not worth
 * refusing the file over.
 *
 * Reported on every entry but the last, because those are the ones that do
 * nothing. Reporting the last would blame the entry that is in force.
 */
export class OrderFlowLayoutValidationContribution implements ValidationCheckContribution {
   registerValidationChecks(registry: ValidationCheckRegistry): void {
      registry.register<OrderFlowAstType>({ LayoutModel: this.checkOverriddenEntries }, this);
   }

   protected checkOverriddenEntries(layout: LayoutModel, accept: ValidationAcceptor): void {
      const last = new Map<FlowNode, DiagramNode>();
      for (const entry of layout.nodes) {
         // An entry that does not resolve already reports as a linking error.
         const flowNode = entry.flowNode?.ref;
         if (flowNode) {
            last.set(flowNode, entry);
         }
      }
      for (const entry of layout.nodes) {
         const flowNode = entry.flowNode?.ref;
         if (flowNode && last.get(flowNode) !== entry) {
            acceptMessage(accept, 'warning', OVERRIDDEN_LAYOUT_ENTRY, { node: entry, property: 'flowNode' }, { node: flowNode.name });
         }
      }
   }
}
