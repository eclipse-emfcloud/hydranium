/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { HydraniumGlspRecordingCommand } from '@hydranium/glsp-server';
import { type MaybePromise } from '@eclipse-glsp/server';
import { type OrderFlowGlspState, type OrderFlowSourceModel } from './order-flow-glsp-state.js';

/**
 * order-flow's composition over the framework
 * {@link HydraniumGlspRecordingCommand}. It exists only to fix
 * `TSourceModel = OrderFlowSourceModel` and narrow `state` to
 * {@link OrderFlowGlspState}, so every operation handler constructs the same
 * command type instead of repeating the generic argument.
 *
 * **What the framework base does, so the operation handlers do not.** A handler
 * mutates the `.process` AST in its `runnable`; the base snapshots the
 * *transfer* projection either side of that mutation, derives a JSON patch
 * from the difference, and the operation it executes in writes the result
 * once when it ends, gated on the document version the operation opened at.
 * Persistence, the `ConflictError` gate and the
 * reconcile-on-conflict all live on {@link OrderFlowGlspState}'s base,
 * `ReconcilingMultiDocumentGlspState`.
 *
 * The consequence worth stating for anyone writing a new handler: **the
 * mutated AST is a vehicle, not the output.** It is the operation's copy,
 * discarded once the write is done — the document is rewritten by serializing
 * the transfer model and re-parsing. So a handler must produce a mutation that
 * the transfer encoder can see (a node reachable by containment, references
 * carrying `$refText`), and it must not rely on anything it hangs off the AST
 * surviving the update.
 */
export class OrderFlowCommand extends HydraniumGlspRecordingCommand<OrderFlowSourceModel> {
   constructor(
      state: OrderFlowGlspState,
      label: string,
      runnable: () => MaybePromise<void>,
      undoAction?: () => MaybePromise<void>,
      redoAction?: () => MaybePromise<void>
   ) {
      super(state, label, runnable, undoAction, redoAction);
   }
}
