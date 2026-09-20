/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * The page on an emulated PHONE — device metrics, `isMobile` and a touchscreen.
 *
 * **The only tier that exercises the viewport meta tag.** The others emulate a
 * desktop window that happens to be narrow, where the tag does nothing at all,
 * so a page that had lost it would pass every one of them and still arrive on a
 * phone as a scaled-down miniature of the desktop workbench.
 */

import { expect, type Page, test } from '@playwright/test';

const NODE_ID = 'order-flow-process-diagram_Cancel';

/** Scoped to the MOUNT: sprotty renders the model a second time into a hidden
 *  measuring copy, so a bare graph selector matches the node twice. */
const NODE = `#order-flow-process-diagram svg.sprotty-graph [id="${NODE_ID}"]`;

test.describe('the page on a phone', () => {
   test.beforeEach(async ({ page }) => {
      await page.goto('/');
      await expect(page.locator('[data-report="glsp-head"]')).toHaveAttribute('title', /^\d+ node\(s\) and \d+ edge\(s\)$/);
   });

   test('lays out at the device width instead of being scaled down', async ({ page }) => {
      // **The regression this tier exists for, and its failure is not a broken
      // layout.** One flex row that refuses to shrink floors the whole document,
      // the browser widens the layout viewport to fit it and scales the page down
      // — so everything still looks right, just unreadably small, and no
      // assertion about an element's presence can see it. Measured: an
      // unwrappable panel header and a non-shrinking button strip together held
      // the floor at 565 on a 320px device.
      const layoutWidth = await page.evaluate(() => window.innerWidth);
      expect(layoutWidth).toBe(page.viewportSize()?.width);
   });

   test('scrolls rather than fitting the workbench on one screen', async ({ page }) => {
      const geometry = await page.evaluate(() => ({
         document: document.scrollingElement?.scrollHeight ?? 0,
         viewport: window.innerHeight
      }));
      expect(geometry.document).toBeGreaterThan(geometry.viewport);
   });

   test('a node dragged with a finger reaches the layout document', async ({ page }) => {
      // The page's whole claim, on the device it was hardest to reach: the
      // gesture goes to a canvas binding mouse events, through the GLSP head,
      // into the document the diagram is a view of.
      await page.locator('#diagram-pane').scrollIntoViewIfNeeded();
      await expect(page.locator(NODE)).not.toHaveAttribute('transform', /translate\(/);

      // The shield first: the canvas takes a drag, so in one column it is a
      // region the page cannot scroll past until the reader asks for it.
      await page.locator('#diagram-pane .editor-shield').tap();
      await expect(page.locator('#diagram-pane .editor-shield')).toBeHidden();

      await touchDragNode(page, { x: 60, y: 70 });

      await expect(page.locator(NODE)).toHaveAttribute('transform', /translate\(/);
      await expect(page.locator('[data-report="layout-head"]')).toHaveAttribute('title', /; Cancel -?[\d.]+,-?[\d.]+$/);
   });
});

/**
 * Drag the node under a finger.
 *
 * Through CDP, Playwright's touchscreen offering `tap` and no drag primitive.
 * The intermediate moves are required: the diagram's change-bounds tool arms on
 * the first move after the press and only then accumulates.
 */
async function touchDragNode(page: Page, by: { x: number; y: number }): Promise<void> {
   const box = await page.locator(NODE).boundingBox();
   if (box === null) {
      throw new Error('No bounding box for the drag target');
   }
   const from = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
   const cdp = await page.context().newCDPSession(page);
   await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [from] });
   for (let step = 1; step <= 10; step++) {
      await cdp.send('Input.dispatchTouchEvent', {
         type: 'touchMove',
         touchPoints: [{ x: from.x + (by.x * step) / 10, y: from.y + (by.y * step) / 10 }]
      });
      await page.waitForTimeout(20);
   }
   await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}
