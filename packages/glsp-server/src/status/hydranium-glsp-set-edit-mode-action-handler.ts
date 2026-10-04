/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { type Action, ClientAction, EditMode, ModelState, type SetEditModeAction, SetEditModeActionHandler } from '@eclipse-glsp/server';
import { type AstNode } from '@hydranium/langium';
import { inject, injectable } from 'inversify';
import { type AbstractHydraniumGlspState } from '../state/abstract-hydranium-glsp-state.js';
import { DiagramStatus } from '../state/diagram-status.js';
import { DiagramStatusReporter } from './diagram-status-reporter.js';

/**
 * Records a client's request for a read-only diagram as
 * {@link DiagramStatus.CLIENT_REQUEST}, instead of assigning the edit mode
 * over every other status that holds it.
 *
 * Only an action the client sent counts. GLSP also runs this handler for the
 * edit mode the server itself sends, and recording that as a request would
 * keep the diagram read-only after its own reason has gone.
 */
@injectable()
export class HydraniumGlspSetEditModeActionHandler extends SetEditModeActionHandler {
   @inject(ModelState) declare protected modelState: AbstractHydraniumGlspState<AstNode, unknown>;
   @inject(DiagramStatusReporter) protected readonly reporter!: DiagramStatusReporter;

   override async execute(action: SetEditModeAction): Promise<Action[]> {
      if (ClientAction.is(action)) {
         this.modelState.setStatus(DiagramStatus.CLIENT_REQUEST, action.editMode === EditMode.READONLY ? { readonly: true } : undefined);
         this.reporter.clientEditModeChanged(action.editMode);
      }
      return [];
   }
}
