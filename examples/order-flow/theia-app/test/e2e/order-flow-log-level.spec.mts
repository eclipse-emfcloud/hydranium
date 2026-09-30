/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * The order-flow diagram with the server log level above `info`.
 *
 * The level filters what the server writes to the Output channel, so a client
 * gate that waits for a line in that channel never opens at `warn`: the diagram
 * stays at its loading overlay and nothing reports a failure. A separate spec
 * because the level is a workspace setting, read once at startup, and every
 * other spec runs at the default.
 */

import { expect } from '@playwright/test';
import { type TheiaApp, TheiaExplorerView } from '@theia/playwright';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { loadOrderFlowApp, test } from './order-flow-app.mjs';

/** A workspace overlay that raises the server log level to `warn`. */
function warnLevelOverlay(): string {
   const overlay = mkdtempSync(path.join(tmpdir(), 'order-flow-log-warn-'));
   mkdirSync(path.join(overlay, '.theia'));
   writeFileSync(path.join(overlay, '.theia', 'settings.json'), JSON.stringify({ 'order-flow.log.level': 'warn' }));
   return overlay;
}

test.describe('Order-flow diagram with the server log level at warn', () => {
   let app: TheiaApp;

   test.beforeAll(async ({ playwright, browser }) => {
      app = await loadOrderFlowApp({ playwright, browser }, [warnLevelOverlay()]);
   });

   test.afterAll(async () => {
      await app.page.close();
   });

   test('opens fulfillment.process as a GLSP diagram', async () => {
      const explorer = await app.openView(TheiaExplorerView);
      await explorer.waitForVisibleFileNodes();
      await explorer.clickContextMenuItem('orders/fulfillment.process', ['Open']);

      await expect(app.page.locator('.sprotty').getByText('Pay', { exact: false }).first()).toBeVisible({ timeout: 30_000 });
      await expect(app.page.locator('.sprotty').getByText('Ship', { exact: false }).first()).toBeVisible();
   });
});
