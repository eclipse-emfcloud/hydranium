/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * Theia end-to-end for the order-flow GLSP diagram.
 *
 * Separate from the properties spec on purpose. The properties panel and the
 * diagram share the language server but not their transport — the panel talks to
 * the data head, the diagram to the GLSP head — and a diagram that never
 * finishes loading would otherwise take the panel's passing assertions down with
 * it, or worse, be masked by them.
 */

import { expect } from '@playwright/test';
import { type TheiaApp, TheiaExplorerView } from '@theia/playwright';
import { loadOrderFlowApp, test } from './order-flow-app.mjs';

/** Class contract published by `@hydranium/glsp-client-theia`'s diagram widget. */
const LOADING_OVERLAY_CLASS = 'hydranium-diagram-loading';

/**
 * Watch for the loading overlay from *before* the diagram is opened.
 *
 * The overlay is transient by design, and a healthy diagram loads in well under
 * a second — polling for it after the click is a race that would flake. A
 * MutationObserver installed up front records the sighting instead, so the
 * assertion is order-independent: whether the overlay is still up or already
 * gone when we look, the flag tells us it existed.
 */
async function watchForLoadingOverlay(app: TheiaApp): Promise<void> {
   await app.page.evaluate(overlayClass => {
      const globals = window as unknown as { __hydraniumOverlaySeen?: boolean };
      globals.__hydraniumOverlaySeen = false;
      new MutationObserver(records => {
         for (const record of records) {
            for (const node of Array.from(record.addedNodes)) {
               if (node instanceof HTMLElement && node.classList.contains(overlayClass)) {
                  globals.__hydraniumOverlaySeen = true;
               }
            }
         }
      }).observe(document.body, { childList: true, subtree: true });
   }, LOADING_OVERLAY_CLASS);
}

async function loadingOverlayWasSeen(app: TheiaApp): Promise<boolean> {
   return app.page.evaluate(() => (window as unknown as { __hydraniumOverlaySeen?: boolean }).__hydraniumOverlaySeen === true);
}

test.describe.serial('Order-flow diagram in Theia', () => {
   let app: TheiaApp;

   test.beforeAll(async ({ playwright, browser }) => {
      app = await loadOrderFlowApp({ playwright, browser });
   });

   test.afterAll(async () => {
      await app.page.close();
   });

   test('opens fulfillment.process as a GLSP diagram', async () => {
      // `.process` is associated with the order-flow GLSP diagram as its default
      // opener (the Theia diagram manager claims the extension at a higher
      // priority than anything else in this app, which is why the servers-only
      // VS Code extension is the one sideloaded — the full shell would add a
      // second Open With entry). So the explorer's "Open" entry uses the diagram,
      // and a canvas that renders the process's flow nodes proves the whole
      // plugin → language server → GLSP socket → frontend client chain came up.
      const explorer = await app.openView(TheiaExplorerView);
      await explorer.waitForVisibleFileNodes();
      await watchForLoadingOverlay(app);
      await explorer.clickContextMenuItem('orders/fulfillment.process', ['Open']);

      // GLSP renders into a `.sprotty` SVG; the fixture's tasks appear as node
      // labels once the model has loaded. `Cancel` is deliberately excluded —
      // it has no `.layout` entry and renders at the origin, so asserting on it
      // would couple this test to the unpositioned-node behaviour the fixture
      // exists to show.
      const diagram = app.page.locator('.sprotty svg').first();
      await diagram.waitFor({ state: 'visible', timeout: 30_000 });
      await expect(app.page.locator('.sprotty').getByText('Pay', { exact: false }).first()).toBeVisible({ timeout: 30_000 });
      await expect(app.page.locator('.sprotty').getByText('Ship', { exact: false }).first()).toBeVisible();
   });

   test('the loading overlay covers the canvas while the model loads, then clears', async () => {
      // Two halves of one contract: the framework widget must cover a blank
      // canvas during the round trip AND get out of the way after. An overlay
      // that never comes down is the visible symptom of a GLSP client session
      // that was never initialised, so this is the assertion that distinguishes
      // "slow" from "never".
      expect(await loadingOverlayWasSeen(app)).toBe(true);
      await expect(app.page.locator(`.${LOADING_OVERLAY_CLASS}`)).toHaveCount(0);
   });

   test("GLSP's status overlay is on the page, where a server status can show", async () => {
      // It is inserted into the diagram's base div before sprotty's first render
      // replaces that div; left there, it is never on the page at all.
      await expect(app.page.locator('.sprotty-status')).toHaveCount(1);
   });
});
