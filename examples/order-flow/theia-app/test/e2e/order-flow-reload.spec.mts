/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * Theia end-to-end for a page reload: what the reloaded page shows of the edits
 * the old page made.
 *
 * In this app every page load gets a server of its own. `@theia/plugin-ext`
 * runs a plugin host per frontend connection, and the servers extension forks
 * the language server inside it. So the reloaded page never meets the old
 * page's store, whose unsaved text stays behind in a server nobody reaches for
 * as long as Theia holds the old page's connection open, unless the old page
 * ends its data sessions as it stops. The old server's log is the only place
 * that shows the difference, so the first test reads it.
 *
 * Its own app, apart from the properties spec: a reload restarts the frontend,
 * and the edits made here would otherwise leak into that spec's workspace.
 */

import { resolveServerLogPath } from '@hydranium/core/testing/playwright';
import { expect } from '@playwright/test';
import { type TheiaApp, TheiaTextEditor } from '@theia/playwright';
import { existsSync, readFileSync } from 'node:fs';
import { loadOrderFlowApp, openPropertiesPanel, PROPERTIES_PANEL as PANEL, selectFile, test } from './order-flow-app.mjs';

async function setField(app: TheiaApp, fieldName: string, value: string): Promise<void> {
   const input = app.page.locator(`${PANEL} input#field-${fieldName}`);
   await input.fill(value);
   await input.press('Enter');
}

/**
 * The server log of `app`'s workspace, which every server of the app writes to,
 * the old page's among them. Capture is always on for this app, so a missing
 * path is a broken setup rather than a skip.
 */
function serverLog(app: TheiaApp): { readonly length: number; since(offset: number): string } {
   const file = resolveServerLogPath(app.workspace.path);
   if (!file) {
      throw new Error('no server log capture directory is configured');
   }
   const read = (): string => (existsSync(file) ? readFileSync(file, 'utf-8') : '');
   return { length: read().length, since: offset => read().slice(offset) };
}

/** Reload the page and wait for the shell, as a user pressing F5 would. */
async function reload(app: TheiaApp): Promise<void> {
   await app.page.reload();
   await app.waitForShellAndInitialized();
}

/**
 * Serial, because the second test reloads a page the first has already
 * reloaded, and reads the workspace the first left.
 */
test.describe.serial('Order-flow in Theia across a page reload', () => {
   let app: TheiaApp;

   test.beforeAll(async ({ playwright, browser }) => {
      app = await loadOrderFlowApp({ playwright, browser });
   });

   test.afterAll(async () => {
      await app.page.close();
   });

   test("the reloaded page shows none of the old page's unsaved edits", async () => {
      await openPropertiesPanel(app);
      await selectFile(app, 'orders/fulfillment.process');
      // The first request to the data head pays its cold start, hence the long wait.
      await expect(app.page.locator(`${PANEL} input#field-subject`)).toHaveValue('Order', { timeout: 60_000 });
      await setField(app, 'subject', 'Nonexistent');
      // The server's diagnostic, so the write is known to have landed there
      // before the page goes.
      await expect(app.page.locator(`${PANEL} .diagnostics li`).first()).toContainText('Nonexistent');
      const beforeReload = serverLog(app).length;

      await reload(app);
      // The old page ended its session as it stopped, so the old server let
      // go of the document and its unsaved text at once. Without that, the
      // session lives on until Theia drops the old page's connection, a
      // minute in this app, and the document waits out the revert grace after.
      await expect
         .poll(() => serverLog(app).since(beforeReload), { message: 'the old server releasing the unsaved document', timeout: 20_000 })
         .toMatch(/fulfillment\.process\] Remove synced document: \d+ \(no client left\)/);
      await openPropertiesPanel(app);
      await selectFile(app, 'orders/fulfillment.process');

      await expect(app.page.locator(`${PANEL} input#field-subject`)).toHaveValue('Order', { timeout: 60_000 });
      await expect(app.page.locator(`${PANEL} .diagnostics li`)).toHaveCount(0);
   });

   test('the reloaded page shows an edit saved before the reload', async () => {
      // Through the text editor, since the panel writes but never saves. The
      // layout file, because its default opener is the text editor, where the
      // process file's is the diagram.
      const editor = await app.openEditor('orders/fulfillment.layout', TheiaTextEditor);
      // By keyboard: the declaration sits below the fold, where the page
      // object's line lookups cannot see it, as Monaco renders visible lines
      // only. Only the name is replaced, so no bracket gets auto-closed.
      await editor.placeCursorInLineWithLineNumber(1);
      await app.page.keyboard.press('Control+End');
      await expect(app.page.locator('.monaco-editor .view-line', { hasText: 'layout FulfillmentLayout for' })).toBeVisible();
      await app.page.locator('.monaco-editor .view-line', { hasText: 'layout FulfillmentLayout for' }).click();
      await app.page.keyboard.press('Home');
      // Past `layout ` to the name, which is then selected as one word.
      await app.page.keyboard.press('Control+ArrowRight');
      await app.page.keyboard.press('ArrowRight');
      await app.page.keyboard.press('Control+Shift+ArrowRight');
      await app.page.keyboard.type('FulfilledLayout');
      await expect(app.page.locator('.monaco-editor .view-line', { hasText: 'layout FulfilledLayout for Fulfillment {' })).toBeVisible();
      await editor.save();

      await reload(app);
      await openPropertiesPanel(app);
      await selectFile(app, 'orders/fulfillment.layout');

      await expect(app.page.locator(`${PANEL} input#field-name`)).toHaveValue('FulfilledLayout', { timeout: 60_000 });
   });
});
