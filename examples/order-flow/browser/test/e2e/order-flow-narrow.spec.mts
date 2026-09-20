/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * The workbench in ONE COLUMN, below the 900px breakpoint.
 *
 * **What this covers that no desktop tier can.** The stacked layout puts Monaco
 * inside a page that itself scrolls, and Monaco consumes a vertical touch drag —
 * measured, the page does not move a pixel under a finger on an editor. Without
 * the shield each editor is a region a reader cannot scroll past, and since the
 * column is mostly editor that is the difference between a usable page and a
 * trapped one. The shield is invisible when it works, so only a test that drags
 * over an editor and watches the PAGE can tell the two apart.
 */

import { expect, type Locator, type Page, test } from '@playwright/test';

/** The editor whose shield is exercised; any of the three would do. */
const PROCESS_EDITOR = '#process-editor';

const PROCESS_PANE = '#process-pane';

/** How far a gesture drags, upward, so the page would scroll DOWN. */
const DRAG_BY = -250;

test.describe('the workbench in one column', () => {
   test.beforeEach(async ({ page }) => {
      await page.goto('/');
      await expect(page.locator('[data-report="glsp-head"]')).toHaveAttribute('title', /^\d+ node\(s\) and \d+ edge\(s\)$/);
   });

   test('the column is taller than the window, so the page scrolls', async ({ page }) => {
      // The premise every other case here rests on. At the desktop layout the
      // document is exactly the viewport — nothing scrolls — so this failing
      // means the stacked rules did not apply and the rest would pass vacuously.
      const geometry = await page.evaluate(() => ({
         document: document.scrollingElement?.scrollHeight ?? 0,
         viewport: window.innerHeight
      }));
      expect(geometry.document).toBeGreaterThan(geometry.viewport);
   });

   test('the dividers are gone, having no neighbour to trade width with', async ({ page }) => {
      await expect(page.locator('.splitter').first()).toBeHidden();
   });

   test('a touch drag over a shielded editor scrolls the PAGE', async ({ page }) => {
      await page.locator(PROCESS_EDITOR).scrollIntoViewIfNeeded();
      const beforePage = await pageScroll(page);
      const beforeEditor = await editorScroll(page);

      await touchDrag(page, page.locator(`${PROCESS_PANE} .editor-shield`), DRAG_BY);

      expect(await pageScroll(page)).toBeGreaterThan(beforePage);
      // The editor kept its place: the gesture was the page's, not Monaco's.
      expect(await editorScroll(page)).toBe(beforeEditor);
   });

   test('a tap hands the pane to the editor, which then takes the gesture', async ({ page }) => {
      await page.locator(PROCESS_EDITOR).scrollIntoViewIfNeeded();
      await page.locator(`${PROCESS_PANE} .editor-shield`).tap();
      await expect(page.locator(`${PROCESS_PANE} .editor-shield`)).toBeHidden();

      const beforeEditor = await editorScroll(page);
      const beforePage = await pageScroll(page);
      await touchDrag(page, page.locator(PROCESS_EDITOR), DRAG_BY);

      // The inverse of the case above, and the pair is the point: the same
      // gesture on the same pixels reaches a different consumer either side of
      // one tap. Asserting only the first would pass against a shield that never
      // goes away.
      expect(await editorScroll(page)).not.toBe(beforeEditor);
      expect(await pageScroll(page)).toBe(beforePage);
   });

   test('a panel collapses from its own header', async ({ page }) => {
      const head = page.locator('#document-panel .panel-head');
      await expect(head).toHaveAttribute('aria-expanded', 'true');
      await expect(page.locator('#document-list')).toBeVisible();

      await head.tap();

      await expect(head).toHaveAttribute('aria-expanded', 'false');
      await expect(page.locator('#document-list')).toBeHidden();
   });

   test('opening a workspace file scrolls to its editor without taking the caret', async ({ page }) => {
      // **Focus is what opens the on-screen keyboard**, and in one column the
      // pane a selection opens is well down the page — so focusing it covers an
      // unseen document with a keyboard nobody asked for. Reported from a real
      // device; no tier clicked a workspace entry in this layout at all, which
      // is why it shipped.
      const entry = page.locator('#document-list .row').first();
      const path = (await entry.textContent())?.trim() ?? '';
      await entry.tap();

      const editor = page.locator('#selected-editor');
      await expect(editor).toBeInViewport();
      // The caret stayed where the reader put it. Asserted on the document
      // rather than on the editor, because "no editor has focus" is the claim.
      const focusInsideEditor = await page.evaluate(
         () => document.activeElement?.closest('.editor') !== null && document.activeElement?.closest('.editor') !== undefined
      );
      expect(focusInsideEditor).toBe(false);
      expect(path.length).toBeGreaterThan(0);
   });

   test('the title bar keeps its controls named without their labels', async ({ page }) => {
      // Clipped rather than `display: none`, so the accessible name survives —
      // five unlabelled icons is what the cheap rule would have produced.
      await expect(page.locator('#save-workspace')).toHaveAccessibleName(/Save workspace/);
   });
});

const pageScroll = (page: Page): Promise<number> => page.evaluate(() => document.scrollingElement?.scrollTop ?? 0);

/**
 * Monaco's vertical scroll position.
 *
 * `.lines-content`'s inline `top`, because the rendered line numbers do NOT move
 * with it — Monaco over-renders past its viewport — and its `height` is parked
 * at a 2^24 sentinel that reports "scrollable" whatever the content.
 */
const editorScroll = (page: Page): Promise<string | null> =>
   page.evaluate(selector => {
      const lines = document.querySelector(`${selector} .lines-content`);
      return lines instanceof HTMLElement ? lines.style.top : null;
   }, PROCESS_EDITOR);

/**
 * Drag a finger vertically across the centre of `target`.
 *
 * Through CDP: Playwright's touchscreen offers `tap` and no drag primitive.
 * `scrollIntoViewIfNeeded` first, because CDP takes VIEWPORT coordinates while
 * `boundingBox` returns them relative to that viewport — a target below the fold
 * is otherwise pressed outside the window and the gesture reaches nothing, which
 * reads as the page having scrolled normally.
 */
async function touchDrag(page: Page, target: Locator, by: number): Promise<void> {
   await target.scrollIntoViewIfNeeded();
   const box = await target.boundingBox();
   if (box === null) {
      throw new Error('No bounding box for the drag target');
   }
   const from = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
   const cdp = await page.context().newCDPSession(page);
   await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [from] });
   for (let step = 1; step <= 12; step++) {
      await cdp.send('Input.dispatchTouchEvent', {
         type: 'touchMove',
         touchPoints: [{ x: from.x, y: from.y + (by * step) / 12 }]
      });
      await page.waitForTimeout(16);
   }
   await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
   await page.waitForTimeout(400);
}
