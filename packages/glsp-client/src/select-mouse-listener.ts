/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import {
   type Action,
   BringToFrontAction,
   type GModelElement,
   GRoutingHandle,
   isCtrlOrCmd,
   RankedSelectMouseListener,
   SelectAction,
   type SelectableElement
} from '@eclipse-glsp/client';
import { injectable } from 'inversify';

/**
 * GLSP's select mouse listener, with a plain click on an unselected element
 * replacing whatever is selected when its action executes.
 *
 * The listener names the elements a click deselects from each element's
 * `selected` flag, which the feedback the previous click's command queues
 * writes only when that feedback runs; a click landing before then names
 * nothing, and both elements end up selected. A plain click sends
 * `deselectAll` instead, which `SelectCommand` resolves against the selection
 * service as it executes. Reading the service from the listener would still
 * race the previous click's command, since dispatch is asynchronous.
 * Ctrl/Cmd-click keeps GLSP's add to the selection; a routing handle keeps
 * GLSP's path, since `deselectAll` cannot spare the handle's own edge.
 *
 * Bound by `createGlspClientModule` via `rebind(RankedSelectMouseListener)`.
 */
@injectable()
export class HydraniumSelectMouseListener extends RankedSelectMouseListener {
   protected override handleSelectTarget(
      selectableTarget: SelectableElement,
      deselectedElements: GModelElement[],
      event: MouseEvent
   ): (Action | Promise<Action>)[] {
      if (isCtrlOrCmd(event) || selectableTarget instanceof GRoutingHandle) {
         return super.handleSelectTarget(selectableTarget, deselectedElements, event);
      }
      return [SelectAction.setSelection([selectableTarget.id]), BringToFrontAction.create([selectableTarget.id])];
   }

   protected override handleDeselectAll(): (Action | Promise<Action>)[] {
      return [SelectAction.setSelection([])];
   }
}
