/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import {
   type Action,
   ActionDispatcher,
   type Command,
   type CreateNodeOperation,
   type GhostElement,
   GModelSerializer,
   GNode,
   JsonCreateNodeOperationHandler,
   type MaybePromise,
   SelectAction
} from '@eclipse-glsp/server';
import { findNextUnique } from '@hydranium/protocol';
import { inject, injectable } from 'inversify';
import { DiagramNode, type FlowNode, Gateway, Task } from '../../language-server/generated/ast.js';
import { layoutNode, processNode } from '../../language-server/order-flow-ast-builder.js';
import { OrderFlowCommand } from '../order-flow-command.js';
import { type OrderFlowGlspState } from '../order-flow-glsp-state.js';
import { PROCESS_GATEWAY_NODE_TYPE, PROCESS_TASK_NODE_TYPE } from '../order-flow-process-diagram-types.js';
import { GATEWAY_LAYOUT_OPTIONS, NODE_LAYOUT_OPTIONS } from '../order-flow-process-gmodel-factory.js';
import { appendChild } from '@hydranium/core';

/**
 * Everything creating a flow node in the `.process` root involves, minus which
 * kind of node it is.
 *
 * **The split into one handler per element type is what the palette is built
 * from.** GLSP labels one palette item per entry in `getTriggerActions()`, and
 * every one of them takes the handler's single `label` — so a handler serving
 * both element types renders as the same entry twice, with no way to tell which
 * tool creates a task. The label is per handler, therefore the handler is per
 * element type; a subclass per kind over a shared base is the shape the GLSP
 * workflow example uses for the same reason.
 *
 * **This is the example's two-document write.** Creating a node from the canvas
 * changes BOTH files: the flow node goes into the `.process` primary, and an
 * entry positioning it at the drop point goes into the `.layout` secondary. One
 * recording command, one patch spanning two documents, one submission.
 *
 * It is also why the write order matters concretely rather than abstractly. The
 * layout entry REFERENCES the new flow node, so the semantics must land first;
 * `OrderFlowGlspState.persist` inverts the framework default for exactly this
 * operation's sake. Written the other way round, the `.layout` file would
 * momentarily name a node that does not exist and report a linking error.
 *
 * A drop with no location still creates the node — position is a set, not a
 * requirement — and leaves it to client layout.
 */
@injectable()
export abstract class OrderFlowCreateFlowNodeOperationHandler extends JsonCreateNodeOperationHandler {
   declare protected modelState: OrderFlowGlspState;
   @inject(ActionDispatcher) protected readonly actionDispatcher!: ActionDispatcher;
   // `GModelOperationHandler` injects this for its subclasses; the JSON-based
   // base does not, and the ghost template has to be serialised to a schema
   // before it can travel on the trigger action.
   @inject(GModelSerializer) protected readonly serializer!: GModelSerializer;

   /** The name a new node of this kind is proposed under, before uniquifying. */
   protected abstract readonly nameStem: string;

   /** Build the AST node this handler creates, already named. */
   protected abstract createAstNode(name: string): FlowNode;

   /**
    * The size the ghost is drawn at, taken from the kind's layout FLOORS so the
    * preview matches the smallest node the drop can actually produce.
    */
   protected abstract readonly ghostSize: { readonly minWidth: number; readonly minHeight: number };

   /**
    * The outline that follows the cursor while this tool is armed.
    *
    * Without one the canvas gives no indication of what a click will produce or
    * how big it will be — the cursor changes and nothing else, so placing a node
    * next to another is guesswork until after the drop.
    *
    * **Deliberately an empty shape rather than a replica.** The template carries
    * only the element type and a size: the type is what earns it the `task` /
    * `gateway` class (sprotty derives the class from the type's subtype), so the
    * ghost is already drawn in the right colour and the right silhouette. Adding
    * the name label would mean inventing the name the drop is going to propose,
    * which is a second place for the naming rule to live and a ghost that lies
    * whenever `findNextUnique` disagrees with it.
    */
   protected override createTriggerGhostElement(elementTypeId: string): GhostElement | undefined {
      const template = GNode.builder().type(elementTypeId).size(this.ghostSize.minWidth, this.ghostSize.minHeight).build();
      return { template: this.serializer.createSchema(template) };
   }

   override createCommand(operation: CreateNodeOperation): MaybePromise<Command | undefined> {
      if (!this.elementTypeIds.includes(operation.elementTypeId)) {
         return undefined;
      }
      // `label` is the PALETTE's word for the thing, so it is a noun; an edit
      // description has to name the action instead.
      return new OrderFlowCommand(this.modelState, `Create ${this.label.toLowerCase()}`, () => this.createFlowNode(operation));
   }

   protected createFlowNode(operation: CreateNodeOperation): void {
      const root = this.modelState.sourceRoot;
      const node = this.createAstNode(this.proposeName(this.nameStem));
      appendChild(root, 'nodes', root.nodes, node);
      this.persistDropPoint(operation, node);

      // Create-then-rename: the node is committed with a proposed name, and the
      // client is asked to open its label editor so the user's first keystroke
      // renames it rather than the name being requested up front.
      const nodeId = this.modelState.index.createId(node);
      this.actionDispatcher.dispatchAfterNextUpdate({ kind: 'EditLabel', labelId: `${nodeId}_name` } as Action);
      this.actionDispatcher.dispatchAfterNextUpdate(SelectAction.create({ selectedElementsIDs: [nodeId] }));
   }

   /**
    * Record where the user dropped the node, in the layout SECONDARY.
    *
    * Skipped entirely when the operation carries no location: an entry needs a
    * position (`at` is mandatory in the grammar), and inventing `0, 0` would
    * pin the node to the origin rather than leaving it to client layout.
    *
    * The reference is built against the FLOW NODE's own language services, not
    * the layout's — the entry lives in a `.layout` document but names a node
    * owned by a `.process` one, and the two grammars may qualify names
    * differently.
    */
   protected persistDropPoint(operation: CreateNodeOperation, node: FlowNode): void {
      const location = this.getLocation(operation);
      if (!location) {
         return;
      }
      const reference = this.modelState.languageServicesFor(node)?.references.ReferenceBuilder.toOwnReference(node);
      if (!reference) {
         return;
      }
      const layout = this.modelState.layoutRoot;
      appendChild(layout, 'nodes', layout.nodes, layoutNode(DiagramNode, { flowNode: reference, x: location.x, y: location.y }));
   }

   /**
    * A name unique across **both** flow-node kinds.
    *
    * `NameProvider.findNextName` cannot be used here: it filters candidates by
    * a single `$type`, so asked about `Task` it would happily propose a name a
    * `Gateway` already holds. Tasks and gateways share one name space, because
    * a `Transition` targets `FlowNode` — the duplicate-flow-node integrity
    * rule exists precisely because that collision is reachable, and proposing
    * a name that immediately trips it would be a poor first impression of the
    * palette. Living on the BASE rather than in each subclass is what keeps
    * that one name space from quietly becoming two.
    */
   protected proposeName(stem: string): string {
      const taken = this.modelState.sourceRoot.nodes.map(node => node.name);
      return findNextUnique(stem, taken);
   }
}

/** Creates a `task` — a step that reads or writes domain state. */
@injectable()
export class OrderFlowCreateTaskOperationHandler extends OrderFlowCreateFlowNodeOperationHandler {
   override readonly label = 'Task';
   elementTypeIds = [PROCESS_TASK_NODE_TYPE];

   protected readonly nameStem = 'NewTask';
   protected readonly ghostSize = NODE_LAYOUT_OPTIONS;

   protected createAstNode(name: string): FlowNode {
      return processNode(Task, { name });
   }
}

/** Creates a `gateway` — a branch point. */
@injectable()
export class OrderFlowCreateGatewayOperationHandler extends OrderFlowCreateFlowNodeOperationHandler {
   override readonly label = 'Gateway';
   elementTypeIds = [PROCESS_GATEWAY_NODE_TYPE];

   protected readonly nameStem = 'NewGateway';
   protected readonly ghostSize = GATEWAY_LAYOUT_OPTIONS;

   protected createAstNode(name: string): FlowNode {
      return processNode(Gateway, { name });
   }
}
