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
   /**
    * Whether dragging towards the origin should GROW the value.
    *
    * It also says which side of the divider the governed element is on, and the
    * two cannot disagree: growing on a drag towards the origin is what a divider
    * placed BEFORE its element does. {@link farSibling} reads it for that.
    */
   readonly invert: boolean;
   /**
    * The smallest either side of the divider may become.
    *
    * One value for both sides, because a divider's job is symmetric — the side
    * being dragged stops at it, and the drag stops when the OTHER side reaches
    * it. Two attributes would let the pair disagree for no reason a reader of
    * the layout could reconstruct.
    */
   readonly min: number;
   /**
    * An absolute ceiling, `Infinity` when the divider has none.
    *
    * **Only meaningful on a divider whose default is a LENGTH.** A default
    * written as a share of the container grows with the window, so a fixed
    * ceiling is eventually smaller than the default and the divider starts life
    * outside its own permitted range; the far side supplies the only bound such
    * a divider can honour. The layout declares one accordingly.
    */
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
      // Absent means unbounded rather than some number, so a divider that has
      // no honest absolute ceiling is not given an arbitrary one — the far pane
      // bounds it, and a default that stands in for a decision is the shape that
      // goes wrong silently once the window is wider than whoever chose it.
      max: divider.dataset.max === undefined ? Number.POSITIVE_INFINITY : Number(divider.dataset.max)
   };
}

function extentOf(element: Element, axis: 'x' | 'y'): number {
   const box = element.getBoundingClientRect();
   return axis === 'x' ? box.width : box.height;
}

/** The pane on the other side of the divider from the one it governs. */
function farSibling(divider: HTMLElement, spec: SplitterSpec): Element | null {
   return spec.invert ? divider.previousElementSibling : divider.nextElementSibling;
}

/**
 * How far the property may grow before the pane on the FAR side of the divider
 * reaches {@link SplitterSpec.min}.
 *
 * Measured off that pane rather than off the container, because a container with
 * three tracks gives the divider no way to attribute the space it is not moving
 * — and the two panes a divider sits between are the only ones it moves.
 * Approximate where the other tracks are fractional, since those shrink together
 * and the neighbour then stands in for all of them; it errs towards stopping
 * early, which costs some travel and cannot collapse a pane.
 *
 * **Never below `start`, and that clause is the whole point.** A bound that
 * resolves under the value a drag began at does not limit the drag, it REVERSES
 * it: the first move jumps the divider backwards onto the bound and every
 * further move is clamped to the same number, so the pane can be shrunk and
 * never regrown. The states that produce one are ordinary rather than exotic —
 * a ceiling the window has outgrown, or a far pane already under its minimum.
 */
function upperBound(divider: HTMLElement, spec: SplitterSpec, start: number): number {
   const far = farSibling(divider, spec);
   const headroom = far === null ? 0 : Math.max(0, extentOf(far, spec.axis) - spec.min);
   return Math.max(start, Math.min(spec.max, start + headroom));
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
   return extentOf(governed, spec.axis);
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
         // Resolved once per drag, not per move: the far pane's extent changes as
         // the divider moves, so reading it again would let the bound chase the
         // pointer and the minimum would never be reached.
         const limit = upperBound(divider, spec, start);
         divider.setPointerCapture(event.pointerId);
         divider.classList.add('dragging');
         // On the ROOT rather than the divider: the pointer spends the drag over
         // whatever is beside the divider, and a cursor set on the divider alone
         // reverts the moment it leaves.
         document.documentElement.classList.add(spec.axis === 'x' ? 'resizing-x' : 'resizing-y');

         const move = (moved: PointerEvent): void => {
            const delta = (spec.axis === 'x' ? moved.clientX : moved.clientY) - origin;
            const next = start + (spec.invert ? -delta : delta);
            // `min` OUTERMOST, so it wins when the container cannot honour both
            // sides: the pane being dragged keeps its minimum and the far one
            // gives up the rest, which is what the grid's `minmax(0, 1fr)` far
            // track is written to allow. The other order clamps the dragged pane
            // BELOW its own minimum whenever the bound falls under it.
            document.documentElement.style.setProperty(spec.property, `${Math.max(spec.min, Math.min(limit, next))}px`);
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
