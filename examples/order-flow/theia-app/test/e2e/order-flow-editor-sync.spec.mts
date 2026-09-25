/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * A Monaco editor whose file changes to exactly the text it shows unsaved, as
 * it does when the server saves a document the editor holds dirty.
 *
 * Theia keeps such an editor dirty, and on the next save applies the editor's
 * edits to the file a second time: its check that the file has not changed
 * since the editor read it passes when the size is unchanged. The edit here
 * keeps the size, so the only thing between it and a corrupted file is the
 * framework's `EditorDiskSync`. Another process writes the file, which is the
 * same event to the editor as a server save and needs no server to stage.
 */

import { expect } from '@playwright/test';
import { type TheiaApp, TheiaTextEditor } from '@theia/playwright';
import { readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { loadOrderFlowApp, test } from './order-flow-app.mjs';

const FILE = 'orders/orders.domain';

test.describe('an editor whose file is written with its unsaved text', () => {
   let app: TheiaApp;

   test.beforeAll(async ({ playwright, browser }) => {
      app = await loadOrderFlowApp({ playwright, browser });
   });

   test.afterAll(async () => {
      await app.page.close();
   });

   test('turns clean, and its next save leaves the file as it was written', async () => {
      const file = path.join(app.workspace.path, FILE);
      const editor = await app.openEditor(FILE, TheiaTextEditor);
      const lines = readFileSync(file, 'utf-8').split('\n');

      // Two characters in on line 1, two out on line 2: the size stays the
      // same, and applying the edits twice is visible in the text.
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
      const buffer = lines.join('\n');
      await expect.poll(() => editor.isDirty()).toBe(true);

      // Past the mtime the editor loaded, so the watcher reports a change.
      await app.page.waitForTimeout(1_500);
      writeFileSync(file, buffer, 'utf-8');
      await expect.poll(() => editor.isDirty(), { timeout: 10_000 }).toBe(false);

      await editor.activate();
      await app.page.keyboard.press('Control+s');
      // No dialog is expected; a save that double-applies shows none either,
      // so the file is what tells.
      await app.page.waitForTimeout(2_000);
      expect(readFileSync(file, 'utf-8')).toBe(buffer);
      expect(await editor.isDirty()).toBe(false);
   });
});
