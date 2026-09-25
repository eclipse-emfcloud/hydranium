/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * Save All over a diagram and a Monaco editor that both show the same unsaved
 * edit of one `.process` file.
 *
 * The edit made in the editor reaches the server, so the diagram turns dirty
 * too. Save All saves the widgets in the order they opened: the diagram first,
 * whose save writes the edit, and then the editor at once, before the file
 * watcher has reported that write. The editor's save applies its pending
 * edits to the file rather than writing its text, and the file already holds
 * them; the edit keeps the size, so Theia's check that the file is unchanged
 * passes and nothing but `EditorDiskSync`'s check before the save keeps the
 * edit from landing twice.
 */

import { expect } from '@playwright/test';
import { type TheiaApp, TheiaExplorerView, TheiaTextEditor } from '@theia/playwright';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { loadOrderFlowApp, test } from './order-flow-app.mjs';

const FILE = 'orders/fulfillment.process';

test.describe('Save All over a diagram and an editor on the same unsaved file', () => {
   let app: TheiaApp;

   test.beforeAll(async ({ playwright, browser }) => {
      app = await loadOrderFlowApp({ playwright, browser });
   });

   test.afterAll(async () => {
      await app.page.close();
   });

   test('leaves the file with the edit applied once', async () => {
      const file = path.join(app.workspace.path, FILE);
      const lines = readFileSync(file, 'utf-8').split('\n');

      // The diagram first, so Save All saves it before the editor.
      const explorer = await app.openView(TheiaExplorerView);
      await explorer.waitForVisibleFileNodes();
      await explorer.clickContextMenuItem(FILE, ['Open']);
      await expect(app.page.locator('.sprotty').getByText('Pay', { exact: false }).first()).toBeVisible({ timeout: 30_000 });
      // Through Open With: the file's default opener is the diagram, and in
      // this Theia the entry is a quick pick rather than a submenu.
      await explorer.clickContextMenuItem(FILE, ['Open With...']);
      await app.quickCommandPalette.type('Text Editor');
      // The row's first label is the opener's name; the second, its source.
      await expect(app.page.locator('.quick-input-widget .monaco-list-row.focused .label-name').first()).toHaveText('Text Editor');
      await app.page.keyboard.press('Enter');
      const editor = new TheiaTextEditor(FILE, app);
      await editor.waitForVisible();

      // Two characters in on the first comment line, two out on the second:
      // the size stays the same, and the text shows an edit applied twice.
      await editor.placeCursorInLineWithLineNumber(1);
      await app.page.keyboard.press('End');
      await app.page.keyboard.type('XY');
      await app.page.keyboard.press('Escape');
      await editor.placeCursorInLineWithLineNumber(2);
      await app.page.keyboard.press('End');
      await app.page.keyboard.press('Backspace');
      await app.page.keyboard.press('Backspace');
      lines[0] = `${lines[0]}XY`;
      lines[1] = lines[1].slice(0, -2);
      const edited = lines.join('\n');
      await expect.poll(() => editor.isDirty()).toBe(true);
      // The diagram's tab marks it dirty once the server has the edit.
      await expect(
         app.page.locator(
            '#theia-main-content-panel .p-TabBar-tab.theia-mod-dirty, #theia-main-content-panel .lm-TabBar-tab.theia-mod-dirty'
         )
      ).toHaveCount(2, {
         timeout: 10_000
      });

      // Save All's own keybinding.
      await app.page.keyboard.press('Control+Alt+S');

      await expect.poll(() => readFileSync(file, 'utf-8'), { timeout: 10_000 }).toBe(edited);
      await expect.poll(() => editor.isDirty(), { timeout: 10_000 }).toBe(false);
      // A second application would land after the first; give it the time a
      // save takes before reading the file once more.
      await app.page.waitForTimeout(2_000);
      expect(readFileSync(file, 'utf-8')).toBe(edited);
   });
});
