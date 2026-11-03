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
   type GModelElement,
   type SelectableElement,
   RankedSelectMouseListener,
   SelectAction,
   findParentByFeature,
   isSelectable
} from '@eclipse-glsp/client';
import { PROCESS_EFFECT_TYPE, PROCESS_TASK_NODE_TYPE } from '@hydranium/example-order-flow-protocol';
import { injectable } from 'inversify';

/** A press arms the task for dragging; a click selects the effect for editing. */
@injectable()
export class OrderFlowProcessSelectMouseListener extends RankedSelectMouseListener {
   protected pressedEffect?: GModelElement;

   override mouseDown(target: GModelElement, event: MouseEvent): (Action | Promise<Action>)[] {
      this.pressedEffect = undefined;
      if (event.button === 0 && !event.ctrlKey && !event.metaKey && target.type === PROCESS_EFFECT_TYPE) {
         const task = findParentByFeature(
            target,
            (element): element is SelectableElement => isSelectable(element) && element.type === PROCESS_TASK_NODE_TYPE
         );
         if (task) {
            this.pressedEffect = target;
            return super.mouseDown(task, event);
         }
      }
      return super.mouseDown(target, event);
   }

   override mouseUp(target: GModelElement, event: MouseEvent): (Action | Promise<Action>)[] {
      const effect = this.pressedEffect;
      this.pressedEffect = undefined;
      if (effect && event.button === 0 && !this.hasDragged && target.id === effect.id) {
         this.isMouseDown = false;
         this.hasDragged = false;
         return [
            SelectAction.create({
               selectedElementsIDs: [effect.id],
               deselectedElementsIDs: this.collectElementsToDeselect(target, undefined).map(element => element.id)
            })
         ];
      }
      return super.mouseUp(target, event);
   }
}
