/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * The process diagram under a FINGER.
 *
 * **What this covers that the mouse tier cannot.** sprotty's `MouseTool` binds
 * `mousedown` / `mousemove` / `mouseup` and no pointer or touch listener, and a
 * browser synthesizes mouse events for a TAP and not for a drag — so a touch
 * gesture reaches the canvas as a complete pointer stream that moves nothing,
 * with a clean console and a fully populated model. Every assertion here exists
 * because that failure is invisible to a mouse and silent under one.
 *
 * Its own file rather than cases added to the mouse tier, because the emulation
 * is per-PROJECT: `hasTouch` is a context option, so a touch case sharing a
 * project with the mouse cases would either run without a touchscreen or force
 * one on every case that does not want it.
 */

import { expect, type Locator, type Page, test } from '@playwright/test';

const MOUNT = '#order-flow-process-diagram';

/** Named by sprotty's own class: the palette's icons are `<svg>` in the mount too. */
const GRAPH = `${MOUNT} svg.sprotty-graph`;

const LAYOUT_EDITOR = '#layout-editor';

/** The page's graph report, once it is neither placeholder nor pending. */
const RENDERED_REPORT = /^\d+ node\(s\) and \d+ edge\(s\)$/;

/** `orders/fulfillment.layout` as seeded: four entries, and no `Cancel`. */
const SEEDED_LAYOUT = '4 entries: Pay 40,100; PaymentOk 260,90; Pick 440,200; Ship 660,200';

/**
 * The drag, in CSS pixels.
 *
 * Large enough to clear any drag threshold and to land the node somewhere no
 * seeded entry already sits, so the assertion cannot pass on a coincidence.
 */
const DRAG = { x: 300, y: 180 };

test.describe('the process diagram under touch', () => {
   test.beforeEach(async ({ page }) => {
      await page.goto('/');
   });

   test('a touch drag moves a node and writes its layout entry', async ({ page }) => {
      await expectFramedDiagram(page);

      await touchDragBy(page, nodeLocator(page, 'Cancel'), DRAG);

      // Three assertions for three things that can each hold while the next
      // fails: the canvas redrew, the store took the write, and the document the
      // store is a projection of was edited. A test stopping at the first would
      // pass against a diagram that moved a node and told nobody.
      await expect(nodeLocator(page, 'Cancel')).toHaveAttribute('transform', /translate\(/);

      const report = page.locator('[data-report="layout-head"]');
      await expect(report).toHaveAttribute(
         'title',
         new RegExp(`^5 entries: ${SEEDED_LAYOUT.slice('4 entries: '.length)}; Cancel -?[\\d.]+,-?[\\d.]+$`)
      );

      const position = await trailingPosition(report);
      await expect(page.locator(`${LAYOUT_EDITOR} .view-lines`)).toContainText(`node Cancel at ${position.x}, ${position.y}`);
   });

   test('creating a task from the palette works under a finger', async ({ page }) => {
      await expectFramedDiagram(page);

      // Two TAPS, and that is why this needs no shim: a browser synthesizes mouse
      // events for a tap, so every tap-driven tool already reaches a canvas that
      // binds them. Only a DRAG has no synthesis, which is the whole of what the
      // shim exists for — so this case marks the boundary between the two rather
      // than covering the same ground as the drag above.
      await page.locator(`${MOUNT} .tool-button`, { hasText: 'Task' }).tap();
      const mount = await page.locator(MOUNT).boundingBox();
      if (mount === null) {
         throw new Error('No bounding box for the diagram mount');
      }
      // Low and left of centre: the seeded nodes occupy the upper band and the
      // palette the upper right.
      await page.locator(MOUNT).tap({ position: { x: mount.width * 0.4, y: mount.height * 0.85 } });
      // The create handler opens an inline label editor, which would otherwise
      // swallow the keyboard for anything after this.
      await page.keyboard.press('Escape');

      await expect(page.locator(`${GRAPH} [id="order-flow-process-diagram_NewTask"]`)).toHaveCount(1);
      await expect(page.locator('[data-report="layout-head"]')).toHaveAttribute('title', /; NewTask -?[\d.]+,-?[\d.]+$/);
   });
});

/**
 * Wait until the diagram is not only rendered but FRAMED.
 *
 * Required before any gesture: the page opens the layout document through the
 * data head before it mounts the diagram, so a test gating on that report can
 * press while the fit is still pending — the press is then measured against the
 * load-time viewport and the release against the fitted one.
 */
async function expectFramedDiagram(page: Page): Promise<void> {
   await expect(page.locator('[data-report="glsp-head"]')).toHaveAttribute('title', RENDERED_REPORT);
}

/**
 * One rendered flow node, by the id the server's index assigns it.
 *
 * `Cancel` is the interesting target throughout: it has no seeded layout entry,
 * so its drag APPENDS one — the branch a fixture where everything is already
 * positioned can never reach.
 */
function nodeLocator(page: Page, name: string): Locator {
   return page.locator(`${GRAPH} [id="order-flow-process-diagram_${name}"]`);
}

/**
 * Press the centre of `target` with a finger and release it `by` pixels away.
 *
 * **Through CDP, because Playwright's touchscreen API offers `tap` and nothing
 * else** — there is no touch-drag primitive — which is what pins this tier to
 * Chromium.
 *
 * The intermediate moves are not cosmetic, for the same reason the mouse tier
 * makes them: GLSP's change-bounds tool arms on the first move after the press
 * and only then accumulates, so a single jump to the destination is consumed as
 * the arming move and the operation goes out with a zero delta.
 */
async function touchDragBy(page: Page, target: Locator, by: { x: number; y: number }): Promise<void> {
   const box = await target.boundingBox();
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
   }
   await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

/** The coordinates the layout report ends with, as the page spells them. */
async function trailingPosition(report: Locator): Promise<{ x: string; y: string }> {
   const text = await report.getAttribute('title');
   const match = /(-?[\d.]+),(-?[\d.]+)$/.exec(text ?? '');
   if (match === null) {
      throw new Error(`Layout report has no trailing position: ${text}`);
   }
   return { x: match[1], y: match[2] };
}
