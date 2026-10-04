/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * The order-flow diagram opened over a document that does not parse.
 *
 * The server says why the canvas is read-only while it is still answering the
 * model request, before the client has rendered anything, and Theia's diagram
 * replaces the element GLSP's status overlay starts in on its first render. A
 * separate spec because the broken document has to be on disk before the
 * workspace opens, and every other spec needs it intact.
 */

import { expect } from '@playwright/test';
import { type TheiaApp, TheiaExplorerView } from '@theia/playwright';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { loadOrderFlowApp, test } from './order-flow-app.mjs';

const READONLY_REASON = 'Read-only: this document has a syntax error. Fix it to edit the diagram again.';

/** A workspace overlay whose `fulfillment.process` has a transition with no target, a parser error. */
function brokenProcessOverlay(): string {
   const source = path.resolve(import.meta.dirname, '..', '..', '..', 'workspace', 'orders', 'fulfillment.process');
   const intact = readFileSync(source, 'utf8');
   if (!intact.includes('transition Pick -> Ship')) {
      throw new Error('fulfillment.process no longer contains the transition this spec breaks');
   }
   const overlay = mkdtempSync(path.join(tmpdir(), 'order-flow-broken-process-'));
   mkdirSync(path.join(overlay, 'orders'));
   writeFileSync(path.join(overlay, 'orders', 'fulfillment.process'), intact.replace('transition Pick -> Ship', 'transition Pick ->'));
   return overlay;
}

test.describe('Order-flow diagram opened over a broken document', () => {
   let app: TheiaApp;

   test.beforeAll(async ({ playwright, browser }) => {
      app = await loadOrderFlowApp({ playwright, browser }, [brokenProcessOverlay()]);
   });

   test.afterAll(async () => {
      await app.page.close();
   });

   test('keeps saying why it is read-only', async () => {
      const explorer = await app.openView(TheiaExplorerView);
      await explorer.waitForVisibleFileNodes();
      await explorer.clickContextMenuItem('orders/fulfillment.process', ['Open']);

      const band = app.page.locator('.sprotty-status');
      await expect(band).toHaveText(READONLY_REASON, { timeout: 30_000 });
      // The server's first live validation runs about 100 ms after the model
      // reaches the client; a second is ten times that.
      await app.page.waitForTimeout(1000);
      await expect(band).toHaveText(READONLY_REASON);
   });
});
