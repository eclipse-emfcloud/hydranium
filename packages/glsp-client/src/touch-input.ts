/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { type Disposable, DisposableCollection } from '@hydranium/protocol';

/**
 * Re-emit touch gestures over `mount` as the mouse events its canvas binds.
 *
 * sprotty's `MouseTool` registers `mousedown`, `mousemove` and `mouseup` and no
 * pointer or touch listener, and a browser synthesizes mouse events for a tap
 * and not for a drag, so a finger drag reaches the diagram as a complete
 * pointer stream that moves nothing, with a clean console and a full model.
 *
 * A shim on the host rather than a change to the diagram client, because the
 * gap is in which event family is bound: re-emitting the gesture as the bound
 * family needs nothing from the model, the tools or the container. Pairs with
 * `touch-action: none` on the same element, without which the browser takes the
 * drag as a pan and cancels the pointer stream before the second move.
 *
 * Mouse and pen pointers are left alone: the canvas already hears those, and
 * forwarding them would run every gesture twice. So is a second finger while
 * one drags, since the canvas knows one mouse and its press would end the drag,
 * and a press on a text field, which needs the browser's own press to take the
 * focus and the caret.
 */
export function enableTouchDragging(mount: HTMLElement): Disposable {
   /** The finger that started the drag and the element under it; every event of
    *  the drag goes to that element. */
   let drag: { readonly pointerId: number; readonly target: Element | null } | undefined;

   const dispatch = (type: 'mousedown' | 'mousemove' | 'mouseup', source: PointerEvent): void => {
      drag?.target?.dispatchEvent(
         new MouseEvent(type, {
            bubbles: true,
            cancelable: true,
            clientX: source.clientX,
            clientY: source.clientY,
            button: 0,
            buttons: type === 'mouseup' ? 0 : 1,
            view: window
         })
      );
   };

   const press = (event: PointerEvent): void => {
      if (event.pointerType !== 'touch' || drag !== undefined || isTextField(event.target)) {
         return;
      }
      // Cancelled, or the browser follows a tap with mouse events of its own and
      // the canvas hears the gesture twice; a `click` still follows.
      event.preventDefault();
      // Without the capture the stream stops when the finger leaves the element
      // it started on, which during a node drag is immediately.
      mount.setPointerCapture(event.pointerId);
      drag = { pointerId: event.pointerId, target: document.elementFromPoint(event.clientX, event.clientY) };
      // A priming move BEFORE the press, or the drag is a silent no-op: sprotty's
      // `MousePositionTracker` writes the origin the change-bounds tool reads at
      // `mousedown` on `mousemove` alone, so a pointer that never hovered leaves
      // it unset and the node is dropped at 0,0.
      dispatch('mousemove', event);
      dispatch('mousedown', event);
   };

   const move = (event: PointerEvent): void => {
      if (event.pointerId === drag?.pointerId) {
         dispatch('mousemove', event);
      }
   };

   const release = (event: PointerEvent): void => {
      if (event.pointerId !== drag?.pointerId) {
         return;
      }
      dispatch('mouseup', event);
      drag = undefined;
   };

   const listeners: ['pointerdown' | 'pointermove' | 'pointerup' | 'pointercancel', (event: PointerEvent) => void][] = [
      ['pointerdown', press],
      ['pointermove', move],
      ['pointerup', release],
      // The browser fires `pointercancel` instead of `pointerup` when it takes
      // the pointer over; without a release here the next touch resumes the
      // abandoned drag.
      ['pointercancel', release]
   ];
   const toDispose = new DisposableCollection();
   for (const [type, listener] of listeners) {
      mount.addEventListener(type, listener);
      toDispose.push({ dispose: () => mount.removeEventListener(type, listener) });
   }
   return toDispose;
}

function isTextField(target: EventTarget | null): boolean {
   return target instanceof Element && target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])') !== null;
}
