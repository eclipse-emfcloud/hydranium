/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * Carry a touch gesture to a canvas that binds mouse events.
 *
 * **sprotty's `MouseTool` registers `mousedown` / `mousemove` / `mouseup` and no
 * pointer or touch listener**, and a browser synthesizes mouse events for a TAP
 * and not for a drag — so a finger reaches the diagram as a complete pointer
 * stream that moves nothing, with a clean console and a fully populated model.
 * That reads as a dead canvas rather than as an input gap.
 *
 * A shim on the host rather than a change to the diagram client: the gap is in
 * which event family is bound, and re-emitting the gesture as the bound family
 * needs nothing from the model, the tools or the DI container.
 */

/**
 * Re-emit touch gestures over `mount` as the mouse events its canvas binds.
 *
 * Pairs with `touch-action: none` on the same element, without which the browser
 * takes the drag as a pan and cancels the pointer stream before the second move.
 */
export function enableTouchDragging(mount: HTMLElement): void {
   /** The element the gesture started on; every event of one drag goes to it. */
   let pressed: Element | null = null;

   const dispatch = (type: 'mousedown' | 'mousemove' | 'mouseup', source: PointerEvent): void => {
      pressed?.dispatchEvent(
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

   mount.addEventListener('pointerdown', event => {
      // Mouse and pen already deliver the events the canvas binds; forwarding
      // those would run every gesture twice.
      if (event.pointerType !== 'touch') {
         return;
      }
      // Without the capture the stream stops when the finger leaves the element
      // it started on, which during a node drag is immediately.
      mount.setPointerCapture(event.pointerId);
      pressed = document.elementFromPoint(event.clientX, event.clientY);
      // **A priming move BEFORE the press, and the drag is a silent no-op
      // without it.** sprotty's `MousePositionTracker` is the only writer of the
      // origin the diagram's change-bounds tracker reads at `mousedown`, and it
      // writes on `mousemove` alone — a pointer that never hovered leaves it
      // unset, and every later move is then measured against nothing. The
      // operation still goes out, at the element's unmoved position, so the
      // symptom is a node that snaps back and a file written at 0,0, which
      // reads as a broken write path rather than as missing input.
      dispatch('mousemove', event);
      dispatch('mousedown', event);
   });

   mount.addEventListener('pointermove', event => {
      if (event.pointerType === 'touch') {
         dispatch('mousemove', event);
      }
   });

   const release = (event: PointerEvent): void => {
      if (event.pointerType !== 'touch') {
         return;
      }
      dispatch('mouseup', event);
      pressed = null;
   };
   mount.addEventListener('pointerup', release);
   // `pointercancel` too: the browser fires it instead of `pointerup` when it
   // takes the pointer over, and without a release here the next touch resumes
   // the abandoned drag.
   mount.addEventListener('pointercancel', release);
}
