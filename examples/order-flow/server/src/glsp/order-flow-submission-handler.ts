/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { ModelState } from '@eclipse-glsp/server';
import { HydraniumGlspSubmissionHandler } from '@hydranium/glsp-server';
import { inject, injectable } from 'inversify';
import type { ProcessModel } from '../language-server/ast.js';
import type { OrderFlowGlspState, OrderFlowSourceModel } from './order-flow-glsp-state.js';

/**
 * Thin submission handler for the `.process` diagram.
 *
 * Inherits the framework's `readyEvent = IntegrityService.SettledState`, which
 * is load-bearing here rather than incidental: the GModel factory resolves
 * `transition.source.ref`, `branch.target.ref` and the cross-grammar
 * `effect.entity.ref` / `.field.ref`, so it needs a fully-linked AST with
 * cross-DOCUMENT references resolved. Without the gate those reads would fire
 * mid-build and warn about resolution before `ComputedScopes`.
 *
 * Only `formatSourceRoot` is overridden, so the submit log names the process
 * and its topology counts instead of a bare `$type`.
 */
@injectable()
export class OrderFlowSubmissionHandler extends HydraniumGlspSubmissionHandler<ProcessModel, OrderFlowSourceModel> {
   @inject(ModelState) declare protected modelState: OrderFlowGlspState;

   protected override formatSourceRoot(root: ProcessModel | undefined): string {
      if (!root) {
         return 'none';
      }
      return `ProcessModel name=${root.name} nodes=${root.nodes.length} transitions=${root.transitions.length}`;
   }
}
