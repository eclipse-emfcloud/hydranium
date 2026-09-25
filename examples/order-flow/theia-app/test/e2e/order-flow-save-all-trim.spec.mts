/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * Save All over a diagram and a Monaco editor on the same unsaved file, with a
 * save participant that edits the editor's buffer: `files.trimTrailingWhitespace`,
 * set in this spec's workspace only.
 *
 * The diagram's save writes the edit, trailing whitespace included. The editor's
 * save then runs Theia's participants, whose trim changes the buffer while
 * `EditorDiskSync` reads the file, so the buffer no longer equals the file
 * when the read returns. The check has to compare the file with the buffer as
 * it was when the save began: the edits up to then are dropped, and the trim
 * is written on top of the file.
 *
 * The file is the fixture's `.process` file padded with comment lines, so that
 * the pending edits are smaller than the text and Theia applies them to the file
 * rather than writing the text: a whole-text write hides a doubled edit.
 */

import { expect } from '@playwright/test';
import { type TheiaApp, TheiaExplorerView, TheiaTextEditor } from '@theia/playwright';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { loadOrderFlowApp, test } from './order-flow-app.mjs';

const FILE = 'orders/fulfillment.process';

/** A workspace overlay with the trim setting and a padded copy of {@link FILE}. */
function trimOverlay(): string {
   const overlay = mkdtempSync(path.join(tmpdir(), 'order-flow-trim-'));
   mkdirSync(path.join(overlay, '.theia'));
   writeFileSync(path.join(overlay, '.theia', 'settings.json'), JSON.stringify({ 'files.trimTrailingWhitespace': true }));
   const source = readFileSync(path.resolve(import.meta.dirname, '..', '..', '..', 'workspace', FILE), 'utf-8');
   const padding = Array.from({ length: 60 }, (_, i) => `// padding line ${i} keeps the pending edits smaller than the text\n`);
   mkdirSync(path.join(overlay, 'orders'));
   writeFileSync(path.join(overlay, FILE), source + padding.join(''));
   return overlay;
}

test.describe('Save All with a save participant that edits the editor', () => {
   let app: TheiaApp;

   test.beforeAll(async ({ playwright, browser }) => {
      app = await loadOrderFlowApp({ playwright, browser }, [trimOverlay()]);
   });

   test.afterAll(async () => {
      await app.page.close();
   });

   test('leaves the file with the edit applied once and the whitespace trimmed', async () => {
      const file = path.join(app.workspace.path, FILE);
      const lines = readFileSync(file, 'utf-8').split('\n');

      // The diagram first, so Save All saves it before the editor.
      const explorer = await app.openView(TheiaExplorerView);
      await explorer.waitForVisibleFileNodes();
      await explorer.clickContextMenuItem(FILE, ['Open']);
      await expect(app.page.locator('.sprotty').getByText('Pay', { exact: false }).first()).toBeVisible({ timeout: 30_000 });
      await explorer.clickContextMenuItem(FILE, ['Open With...']);
      await app.quickCommandPalette.type('Text Editor');
      await expect(app.page.locator('.quick-input-widget .monaco-list-row.focused .label-name').first()).toHaveText('Text Editor');
      await app.page.keyboard.press('Enter');
      const editor = new TheiaTextEditor(FILE, app);
      await editor.waitForVisible();

      // Two trailing spaces on the first line, for the trim to remove, and two
      // characters out of the second: the size stays the same until the trim.
      await editor.placeCursorInLineWithLineNumber(1);
      await app.page.keyboard.press('End');
      await app.page.keyboard.type('  ');
      await app.page.keyboard.press('Escape');
      await editor.placeCursorInLineWithLineNumber(2);
      await app.page.keyboard.press('End');
      await app.page.keyboard.press('Backspace');
      await app.page.keyboard.press('Backspace');
      lines[1] = lines[1].slice(0, -2);
      const edited = lines.join('\n');
      await expect.poll(() => editor.isDirty()).toBe(true);
      // The diagram's tab marks it dirty once the server has the edit.
      await expect(
         app.page.locator(
            '#theia-main-content-panel .p-TabBar-tab.theia-mod-dirty, #theia-main-content-panel .lm-TabBar-tab.theia-mod-dirty'
         )
      ).toHaveCount(2, { timeout: 10_000 });

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
