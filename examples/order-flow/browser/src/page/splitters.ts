/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * Draggable dividers for the page's grid areas.
 *
 * **Pointer events and one CSS custom property per divider, which is the whole
 * mechanism.** Each `[data-splitter]` names the property it drives; the grid
 * tracks in `index.html` are written in terms of those properties, so nothing
 * here knows what it is resizing. That is what keeps this file independent of the
 * layout it serves — adding an area is a track and an attribute, not a case in a
 * switch.
 *
 * `resize: horizontal`, which an earlier version of this page used, is one
 * declaration and gives a real handle — but only on the trailing edge of one
 * element, only in one axis, and with no way to bound it or to tell anyone that
 * the drag happened. A workbench needs dividers BETWEEN areas.
 *
 * Pointer events rather than mouse events, so a touch or pen drag works and so
 * `setPointerCapture` can be used. Without the capture the drag ends the moment
 * the pointer leaves the 5px divider, which at any speed is immediately.
 */

import { requireElement } from './dom.js';

/** Elements notified after a drag, so a canvas that measures itself can re-measure. */
export type ResizeListener = () => void;

interface SplitterSpec {
   /** The custom property this divider writes, e.g. `--sidebar-width`. */
   readonly property: string;
   /** The element whose size the property governs, measured to start a drag. */
   readonly measure: string;
   readonly axis: 'x' | 'y';
   /** Whether dragging towards the origin should GROW the value. */
   readonly invert: boolean;
   readonly min: number;
   readonly max: number;
}

function readSpec(divider: HTMLElement): SplitterSpec {
   const property = divider.dataset.splitter;
   const measure = divider.dataset.measure;
   if (property === undefined || measure === undefined) {
      throw new Error('A splitter needs both a data-splitter property and a data-measure selector');
   }
   return {
      property,
      measure,
      axis: divider.dataset.axis === 'y' ? 'y' : 'x',
      invert: divider.dataset.invert !== undefined,
      min: Number(divider.dataset.min ?? 80),
      max: Number(divider.dataset.max ?? 1200)
   };
}

/**
 * The size a drag starts from, MEASURED off the governed element rather than
 * parsed out of the property.
 *
 * **The property is not always a length.** An area whose default share is written
 * as `1fr` — which is how two areas are made to split what is left evenly at any
 * window width — has no pixel value to read, and `parseFloat('1fr')` yields `1`:
 * the drag would then start from one pixel and the area would collapse on the
 * first move. Measuring is also the only reading that survives a `%` default, or
 * a `min-width` the layout imposed.
 *
 * The first move replaces the fraction with a length, and from then on the two
 * agree — so this only matters for the first drag of each divider, which is
 * precisely when getting it wrong is most visible.
 */
function currentValue(spec: SplitterSpec): number {
   const governed = document.querySelector(spec.measure);
   if (governed === null) {
      throw new Error(`A splitter measures ${spec.measure}, which is not in the document`);
   }
   const box = governed.getBoundingClientRect();
   return spec.axis === 'x' ? box.width : box.height;
}

/**
 * Wire every `[data-splitter]` in the document.
 *
 * `onResize` fires at the END of a drag and not on every move, and the
 * distinction is the diagram: sprotty re-measures its canvas on `window.resize`
 * only, so it has to be told, and telling it per pointer move would run a full
 * bounds round trip per frame.
 */
export function wireSplitters(onResize: ResizeListener): void {
   // `Array.from` rather than a spread: this project compiles against a lib where
   // `NodeListOf` is not declared iterable.
   for (const divider of Array.from(document.querySelectorAll<HTMLElement>('[data-splitter]'))) {
      const spec = readSpec(divider);
      divider.addEventListener('pointerdown', (event: PointerEvent) => {
         // Only the primary button. A middle-click drag would otherwise resize
         // while the browser is trying to autoscroll.
         if (event.button !== 0) {
            return;
         }
         const origin = spec.axis === 'x' ? event.clientX : event.clientY;
         const start = currentValue(spec);
         divider.setPointerCapture(event.pointerId);
         divider.classList.add('dragging');
         // On the ROOT rather than the divider: the pointer spends the drag over
         // whatever is beside the divider, and a cursor set on the divider alone
         // reverts the moment it leaves.
         document.documentElement.classList.add(spec.axis === 'x' ? 'resizing-x' : 'resizing-y');

         const move = (moved: PointerEvent): void => {
            const delta = (spec.axis === 'x' ? moved.clientX : moved.clientY) - origin;
            const next = start + (spec.invert ? -delta : delta);
            document.documentElement.style.setProperty(spec.property, `${Math.min(spec.max, Math.max(spec.min, next))}px`);
         };
         const end = (): void => {
            divider.removeEventListener('pointermove', move);
            divider.removeEventListener('pointerup', end);
            divider.removeEventListener('pointercancel', end);
            divider.classList.remove('dragging');
            document.documentElement.classList.remove('resizing-x', 'resizing-y');
            onResize();
         };
         divider.addEventListener('pointermove', move);
         divider.addEventListener('pointerup', end);
         // `pointercancel` too, because the browser fires it instead of `pointerup`
         // when it takes the pointer over — a touch turning into a scroll gesture,
         // or the window losing focus mid-drag. Without it the listeners stay
         // attached and the next hover over the divider resizes.
         divider.addEventListener('pointercancel', end);
         event.preventDefault();
      });
   }
}

/**
 * Reset every area to the width and height the stylesheet declares.
 *
 * The properties are written onto the root element by a drag, and an inline
 * property beats the stylesheet — so clearing them is the only way back, and a
 * page with five dividers needs one.
 */
export function resetSplitters(properties: readonly string[], onResize: ResizeListener): void {
   for (const property of properties) {
      document.documentElement.style.removeProperty(property);
   }
   onResize();
}

/** The dividers' properties, so a reset can name them. */
export const SPLITTER_PROPERTIES = [
   '--sidebar-width',
   '--selected-width',
   '--diagram-split',
   '--fixed-split',
   '--dock-height',
   '--dock-split'
] as const;

/** The button that calls {@link resetSplitters}, wired to the same listener. */
export function wireLayoutReset(onResize: ResizeListener): void {
   requireElement('reset-layout').addEventListener('click', () => resetSplitters(SPLITTER_PROPERTIES, onResize));
}
