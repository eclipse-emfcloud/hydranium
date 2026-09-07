/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { ApplyLabelEditOperation, type Command, JsonOperationHandler, type MaybePromise } from '@eclipse-glsp/server';
import type { Mutable } from '@hydranium/protocol';
import type { Reference } from '@hydranium/langium';
import { injectable } from 'inversify';
import {
   type Branch,
   type DiagramNode,
   type FlowNode,
   type Transition,
   isBranch,
   isFlowNode,
   isGateway
} from '../../language-server/ast.js';
import { OrderFlowCommand } from '../order-flow-command.js';
import { type OrderFlowGlspState } from '../order-flow-glsp-state.js';

/**
 * Renames a flow node, or relabels a gateway branch, from an inline label edit.
 *
 * **Renaming a flow node has to rewrite the references to it, in the same
 * command.** `.process` cross-references are by name (`transition Pick ->
 * Ship`, `yes -> Restock`) and the serializer writes reference *text*, not
 * resolved targets — deliberately, so a broken model round-trips without
 * losing what the author typed. The consequence here is that renaming `Ship`
 * while leaving `$refText: 'Ship'` on its transitions emits
 * `transition Pick -> Ship` against a node now called something else: the
 * rename would silently break every edge into the renamed node. So the
 * referring `$refText`s are updated alongside the name.
 *
 * That sweep is bounded to this process and its `.layout` file, which is sound
 * for these grammars rather than a shortcut: `FlowNode` is not in the global
 * index — nothing outside a `.process` file or the `.layout` file scoped to it
 * can target a task — so the referring set is exactly this document's transitions
 * and gateway branches, plus the secondary's `DiagramNode` entries. That makes a
 * rename a two-document write. A `.domain` rename is a different problem and
 * belongs to LSP rename, not to a diagram operation.
 *
 * **The enumeration above is the fragile part of this handler.** Listing "every
 * property that refers to a flow node" asserts something about the whole grammar,
 * so it silently becomes false the next time a reference to `FlowNode` is added
 * anywhere — including in a grammar this file does not import. The symptom is
 * quiet: the rename succeeds and the missed reference is left spelling the old
 * name, which then fails to link. Adding a referring property means revisiting
 * {@link OrderFlowApplyLabelEditOperationHandler.renameFlowNode}.
 *
 * The empty-name case is rejected rather than repaired. An empty `name=ID`
 * does not parse, so accepting it would produce a document that fails to
 * re-parse on write-back; the client keeps the old label.
 */
@injectable()
export class OrderFlowApplyLabelEditOperationHandler extends JsonOperationHandler {
   readonly operationType = ApplyLabelEditOperation.KIND;

   declare protected modelState: OrderFlowGlspState;

   override createCommand(operation: ApplyLabelEditOperation): MaybePromise<Command | undefined> {
      const text = operation.text.trim();
      if (text.length === 0) {
         return undefined;
      }
      const target = this.resolveTarget(operation.labelId);
      if (!target) {
         return undefined;
      }
      if (isBranch(target)) {
         return target.label === text
            ? undefined
            : new OrderFlowCommand(this.modelState, 'Relabel branch', () => this.relabelBranch(target, text));
      }
      return target.name === text
         ? undefined
         : new OrderFlowCommand(this.modelState, 'Rename flow node', () => this.renameFlowNode(target, text));
   }

   protected relabelBranch(branch: Branch, label: string): void {
      (branch as Mutable<Branch>).label = label;
   }

   /**
    * Rename the node, then repoint every reference that named it.
    *
    * **Each referring property gets a freshly built reference; the existing
    * reference object is never mutated.** Langium's linker exposes
    * `Reference.ref` as a getter backed by a private `_ref`, so
    * `reference.ref = node` throws at runtime rather than merely failing to
    * link. Replacing the property also keeps `$refText` and the resolved target
    * consistent, since `ReferenceBuilder` derives the text from the node.
    */
   protected renameFlowNode(node: FlowNode, name: string): void {
      const previous = node.name;
      const root = this.modelState.sourceRoot;
      const replacement = this.modelState.languageServicesFor(root)?.references.ReferenceBuilder;
      (node as Mutable<FlowNode>).name = name;
      const fresh = replacement?.toOwnReference(node);
      if (previous === undefined || !fresh) {
         return;
      }
      for (const transition of root.transitions) {
         const mutable = transition as Mutable<Transition>;
         if (this.pointsAt(transition.source, previous, node)) {
            mutable.source = fresh;
         }
         if (this.pointsAt(transition.target, previous, node)) {
            mutable.target = fresh;
         }
      }
      for (const flowNode of root.nodes) {
         if (!isGateway(flowNode)) {
            continue;
         }
         for (const branch of flowNode.branches) {
            if (this.pointsAt(branch.target, previous, node)) {
               (branch as Mutable<Branch>).target = fresh;
            }
         }
      }
      // The layout reference lives in the `.layout` secondary, so a rename is a
      // two-document write: without this the entry would still spell the old name
      // and fail to link, losing the node's position on the next load.
      for (const layout of this.modelState.layoutRoot.nodes) {
         if (this.pointsAt(layout.flowNode, previous, node)) {
            (layout as Mutable<DiagramNode>).flowNode = fresh;
         }
      }
   }

   /**
    * Whether one reference should follow the renamed node.
    *
    * Matched on the resolved target first and on the old reference text only as
    * a fallback, so a reference that had already linked follows the node
    * regardless of text, and an as-yet-unresolved reference that spelled the
    * old name is carried along too.
    */
   protected pointsAt(reference: Reference<FlowNode> | undefined, previousName: string, node: FlowNode): boolean {
      return reference !== undefined && (reference.ref === node || reference.$refText === previousName);
   }

   /**
    * Resolve the edited label back to its owning element. Label ids are the
    * owner's element id with a suffix (`_name` for a flow node's own label),
    * and a branch edge's label carries the branch's id plus `_label`, so the
    * suffix is stripped before the index lookup.
    */
   protected resolveTarget(labelId: string): FlowNode | Branch | undefined {
      for (const suffix of ['_name', '_label']) {
         if (labelId.endsWith(suffix)) {
            const ownerId = labelId.slice(0, -suffix.length);
            const owner = this.modelState.index.findSemanticElement(ownerId, isRenameable);
            if (owner) {
               return owner;
            }
         }
      }
      return this.modelState.index.findSemanticElement(labelId, isRenameable);
   }
}

/** Elements whose displayed label is editable in place. */
function isRenameable(item: unknown): item is FlowNode | Branch {
   return isFlowNode(item) || isBranch(item);
}
