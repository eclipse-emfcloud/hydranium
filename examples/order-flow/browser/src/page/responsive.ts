/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * What the narrow-viewport layout needs that a stylesheet cannot express: state
 * that survives crossing the breakpoint, and controls that answer a gesture.
 *
 * The rules themselves live with the rest of the page's chrome; a media query
 * there and a listener here are two halves of one layout, and either alone is a
 * defect rather than a partial feature.
 */

import { requireElement } from './dom.js';
import { SPLITTER_PROPERTIES, type ResizeListener } from './splitters.js';

/**
 * **Must match the `@media` query in `index.html`.**
 *
 * Two declarations of one number, which is a real hazard and the alternative is
 * worse: driving the stylesheet from script would mean the page has no layout
 * until the bundle runs, and the workbench would visibly reflow on every load.
 */
const NARROW_VIEWPORT = '(max-width: 900px)';

/**
 * Whether the single-column layout is in force.
 *
 * Exported so the one breakpoint stays in one place: a second module deciding
 * "are we narrow" by its own number would drift from the stylesheet silently,
 * and the symptom would be one behaviour switching at a width the layout does
 * not.
 */
export function isNarrowViewport(): boolean {
   return window.matchMedia(NARROW_VIEWPORT).matches;
}

/**
 * Every region worth folding away to reach another one.
 *
 * The editors and the canvas are here precisely because they are the tallest
 * things in the column: a list of panels alone left the four regions a reader
 * most wants to get past as the four they could not collapse.
 */
const COLLAPSIBLE = [
   'document-panel',
   'properties-panel',
   'log-panel',
   'problem-panel',
   'selected-pane',
   'diagram-pane',
   'process-pane',
   'layout-pane'
];

/**
 * Wire the layout to the viewport.
 *
 * `onLayoutChange` is the same listener the dividers use: Monaco measures its
 * container and has to be told, while the diagram re-measures itself.
 */
export function wireResponsiveLayout(onLayoutChange: ResizeListener): void {
   const narrow = window.matchMedia(NARROW_VIEWPORT);
   wireEditorShields();
   wireCollapsibleRegions();
   apply(narrow.matches, onLayoutChange);
   narrow.addEventListener('change', event => apply(event.matches, onLayoutChange));
}

/**
 * The dragged track sizes, held while the narrow layout is in force.
 *
 * **Saved and restored rather than cleared.** An inline custom property beats
 * the stylesheet, so the stacked rules cannot take effect while one is set and
 * the properties have to go — but a reader who has arranged the workbench and
 * then narrows the window would otherwise find it reset when they widen it
 * again, which is a loss the resize never warned them about.
 */
let draggedSizes: ReadonlyArray<readonly [string, string]> = [];

function apply(isNarrow: boolean, onLayoutChange: ResizeListener): void {
   const root = document.documentElement;
   if (isNarrow) {
      draggedSizes = SPLITTER_PROPERTIES.map(property => [property, root.style.getPropertyValue(property)] as const).filter(
         ([, value]) => value !== ''
      );
      for (const [property] of draggedSizes) {
         root.style.removeProperty(property);
      }
   } else {
      for (const [property, value] of draggedSizes) {
         root.style.setProperty(property, value);
      }
      draggedSizes = [];
      // Every pane opens shielded again the next time the column returns, so the
      // trap cannot come back unannounced on a device that rotates.
      for (const pane of Array.from(document.querySelectorAll('.pane[data-entered]'))) {
         pane.removeAttribute('data-entered');
      }
   }
   for (const id of COLLAPSIBLE) {
      const region = document.getElementById(id);
      region?.removeAttribute('data-collapsed');
      // Left on, a desktop header is a focus stop announced as a button whose
      // only effect lives inside the media query.
      if (isNarrow) {
         region?.setAttribute('data-collapsible', '');
      } else {
         region?.removeAttribute('data-collapsible');
      }
      const head = headOf(region);
      if (head === null) {
         continue;
      }
      if (isNarrow) {
         head.setAttribute('role', 'button');
         head.setAttribute('tabindex', '0');
         head.setAttribute('aria-expanded', 'true');
      } else {
         head.removeAttribute('role');
         head.removeAttribute('tabindex');
         head.removeAttribute('aria-expanded');
      }
   }
   onLayoutChange();
}

/** A region's own header, whichever of the two kinds it is. */
function headOf(region: HTMLElement | null): Element | null {
   return region?.querySelector(':scope > .panel-head, :scope > .pane-head') ?? null;
}

/** One tap hands a pane over to Monaco for as long as the column lasts. */
function wireEditorShields(): void {
   for (const shield of Array.from(document.querySelectorAll('.editor-shield'))) {
      shield.addEventListener('click', () => {
         shield.closest('.pane')?.setAttribute('data-entered', '');
      });
   }
}

/**
 * Collapse from the header itself, whose heading is already its name.
 *
 * The HEAD becomes the control rather than gaining one, which is what lets this
 * add no label: its accessible name is the heading already inside it, so nothing
 * new has to be written or translated. The cost is that focusability and key
 * handling are ours, and they are granted with the rest of the affordance when
 * the column takes over.
 */
function wireCollapsibleRegions(): void {
   for (const id of COLLAPSIBLE) {
      const region = requireElement(id);
      const head = headOf(region);
      if (head === null) {
         continue;
      }
      const toggle = (): void => {
         const collapsed = region.hasAttribute('data-collapsed');
         region.toggleAttribute('data-collapsed', !collapsed);
         head.setAttribute('aria-expanded', String(collapsed));
      };
      head.addEventListener('click', event => {
         // Wired once and gated here rather than bound and unbound on every
         // crossing: a listener that outlives its affordance would collapse a
         // desktop region whose rules cannot show the result.
         if (!isNarrowViewport()) {
            return;
         }
         // A control inside the header — the log's filter box, its clear button —
         // is not a request to collapse the region it sits in.
         if (event.target instanceof Element && event.target.closest('button, input, select, a') !== null) {
            return;
         }
         toggle();
      });
      head.addEventListener('keydown', event => {
         if (!isNarrowViewport() || !(event instanceof KeyboardEvent) || (event.key !== 'Enter' && event.key !== ' ')) {
            return;
         }
         event.preventDefault();
         toggle();
      });
   }
}
