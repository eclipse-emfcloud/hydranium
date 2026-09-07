/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { type GModelElementConstructor } from '@eclipse-glsp/graph';
import {
   type DiagramConfiguration,
   type EdgeTypeHint,
   ServerLayoutKind,
   type ShapeTypeHint,
   getDefaultMapping
} from '@eclipse-glsp/server';
import { injectable } from 'inversify';
import {
   PROCESS_BRANCH_EDGE_TYPE,
   PROCESS_EFFECT_COMPARTMENT_TYPE,
   PROCESS_EFFECT_TYPE,
   PROCESS_GATEWAY_NODE_TYPE,
   PROCESS_TASK_NODE_TYPE,
   PROCESS_TRANSITION_EDGE_TYPE
} from './order-flow-process-diagram-types.js';

/**
 * Diagram configuration for the editable `.process` diagram.
 *
 * **Each hint is set to exactly what a handler backs.** The type hints are what
 * the client uses to decide which tools to offer, so a capability declared here
 * without a matching operation handler produces a palette entry whose operation
 * the server rejects — a worse failure than the tool being absent.
 *
 * `repositionable` and `resizable` are `true` on the two flow-node types, backed
 * by `OrderFlowChangeBoundsOperationHandler` and by the `DiagramNode` rule of the
 * `.layout` grammar. Both halves are required: the hint without the handler
 * yields a palette gesture the server rejects, and the handler without somewhere
 * in a grammar to write bounds drops the move on the next reload. This is NOT
 * what the framework's computed-bounds handler provides — that applies the
 * client's measured bounds to the server-side GModel transiently, and GLSP's own
 * base documents them as not persisted to the source model.
 *
 * `needsClientLayout` is `true` even though bounds are persisted. The client
 * still has to measure: `size` is optional on a `DiagramNode` and a `.process`
 * file need have no `.layout` beside it at all, so persisted bounds are an
 * overlay on client layout rather than a replacement for it.
 *
 * `routable` is `false` on both edge types, and that is a grammar fact.
 * Routing points are a different operation (`ChangeRoutingPointsOperation`, not
 * `ChangeBoundsOperation`) and persisting them needs a handle on an edge —
 * transitions and branches are unnamed, so the candidates are their endpoints,
 * which the grammar permits two transitions to share, or a name added to
 * `Transition` purely to serve layout. Both are worse than the gap.
 */
@injectable()
export class OrderFlowProcessDiagramConfiguration implements DiagramConfiguration {
   readonly layoutKind: ServerLayoutKind = ServerLayoutKind.NONE;
   readonly needsClientLayout: boolean = true;
   readonly animatedUpdate: boolean = false;

   readonly typeMapping: Map<string, GModelElementConstructor> = getDefaultMapping();

   readonly shapeTypeHints: ShapeTypeHint[] = [
      {
         elementTypeId: PROCESS_TASK_NODE_TYPE,
         deletable: true,
         // A task is only ever a direct child of the process root, so there is
         // no second container to reparent it into.
         reparentable: false,
         repositionable: true,
         resizable: true,
         // An effect is created INTO a task, which is what makes the task a
         // container as far as the palette is concerned.
         containableElementTypeIds: [PROCESS_EFFECT_TYPE]
      },
      {
         elementTypeId: PROCESS_GATEWAY_NODE_TYPE,
         deletable: true,
         reparentable: false,
         repositionable: true,
         resizable: true
      },
      {
         // Slaved to its parent task's layout: the compartment is a rendering
         // container, not an element of the language. Its effects are
         // separately deletable, it is not.
         elementTypeId: PROCESS_EFFECT_COMPARTMENT_TYPE,
         deletable: false,
         reparentable: false,
         repositionable: false,
         resizable: false,
         containableElementTypeIds: [PROCESS_EFFECT_TYPE]
      },
      {
         // One `reads` / `writes` line. Deletable, and creatable into a task,
         // but not in-place editable — changing an effect's target means
         // rewriting three chained references, which stays a text affordance.
         elementTypeId: PROCESS_EFFECT_TYPE,
         deletable: true,
         reparentable: false,
         repositionable: false,
         resizable: false
      }
   ];

   readonly edgeTypeHints: EdgeTypeHint[] = [
      {
         elementTypeId: PROCESS_TRANSITION_EDGE_TYPE,
         deletable: true,
         repositionable: false,
         routable: false,
         // Both ends are flow nodes, so a transition may join any two of them.
         sourceElementTypeIds: [PROCESS_TASK_NODE_TYPE, PROCESS_GATEWAY_NODE_TYPE],
         targetElementTypeIds: [PROCESS_TASK_NODE_TYPE, PROCESS_GATEWAY_NODE_TYPE],
         // Element TYPES are not the whole rule: a transition may not return to
         // its own source, and the pair must not already exist. Both depend on
         // the other endpoint and on what the document already says, which a
         // static list cannot express — so the client asks per hover and
         // `OrderFlowEdgeCreationChecker` answers, turning the refusal into
         // cursor feedback instead of a silently dropped operation.
         dynamic: true
      },
      {
         // Deletable but NOT creatable: a `Branch` carries a label that is part
         // of its syntax (`yes -> Restock`), which an edge tool would have to
         // invent. Creating one stays a text affordance; removing one does not
         // need the label.
         elementTypeId: PROCESS_BRANCH_EDGE_TYPE,
         deletable: true,
         repositionable: false,
         routable: false,
         // Asymmetric, unlike a transition: a branch only ever leaves a gateway.
         sourceElementTypeIds: [PROCESS_GATEWAY_NODE_TYPE],
         targetElementTypeIds: [PROCESS_TASK_NODE_TYPE, PROCESS_GATEWAY_NODE_TYPE]
      }
   ];
}
