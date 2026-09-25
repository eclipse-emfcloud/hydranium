/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * A Monaco editor saved after its file was written, at the same size, with
 * some of the edits the editor still holds unsaved but not all of them.
 *
 * That is the file `EditorDiskSync` cannot help with: it acts only on a file
 * that holds the editor's whole buffer, so here it leaves the save alone, as it
 * does when a save participant ordered ahead of Theia's first one edits before
 * the sync takes the buffer. Theia's own check passes a file whose size is
 * unchanged, and its incremental save then applies the edits the file already
 * holds a second time. `HydraniumFileService`, which the app binds in place of
 * Theia's file service, refuses that save because the file's mtime moved, and
 * the editor falls back to writing its whole text.
 *
 * The edits stay few on purpose: once the pending edits, as JSON, outgrow the
 * file, Theia writes the whole text anyway and nothing is applied twice, with
 * or without the rebind.
 */

import { expect } from '@playwright/test';
import { type TheiaApp, TheiaTextEditor } from '@theia/playwright';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { loadOrderFlowApp, test } from './order-flow-app.mjs';

const FILE = 'orders/orders.domain';

/**
 * A workspace overlay that turns auto-save off. Theia's browser default saves a
 * second after the last edit, which would save the buffer before the file is
 * written, and the editor would then take the file as it is.
 */
function noAutoSaveOverlay(): string {
   const overlay = mkdtempSync(path.join(tmpdir(), 'order-flow-no-autosave-'));
   mkdirSync(path.join(overlay, '.theia'));
   writeFileSync(path.join(overlay, '.theia', 'settings.json'), JSON.stringify({ 'files.autoSave': 'off' }));
   return overlay;
}

test.describe('an editor saved after its file took some of its edits', () => {
   let app: TheiaApp;

   test.beforeAll(async ({ playwright, browser }) => {
      app = await loadOrderFlowApp({ playwright, browser }, [noAutoSaveOverlay()]);
   });

   test.afterAll(async () => {
      await app.page.close();
   });

   test('writes its whole text rather than applying those edits twice', async () => {
      const file = path.join(app.workspace.path, FILE);
      const editor = await app.openEditor(FILE, TheiaTextEditor);
      const lines = readFileSync(file, 'utf-8').split('\n');

      // One character in on line 1 and one out on line 2 keep the size; the
      // file is written with these two.
      await editor.placeCursorInLineWithLineNumber(1);
      await app.page.keyboard.press('End');
      await app.page.keyboard.type('X');
      await app.page.keyboard.press('Escape');
      await editor.placeCursorInLineWithLineNumber(2);
      await app.page.keyboard.press('End');
      await app.page.keyboard.press('Backspace');
      lines[0] = `${lines[0]}X`;
      lines[1] = lines[1].slice(0, -1);
      const written = lines.join('\n');
      // A third edit the file never sees, so the file holds neither the buffer
      // nor the text the editor read.
      await editor.placeCursorInLineWithLineNumber(3);
      await app.page.keyboard.press('End');
      await app.page.keyboard.type('Z');
      await app.page.keyboard.press('Escape');
      lines[2] = `${lines[2]}Z`;
      const buffer = lines.join('\n');
      await expect.poll(() => editor.isDirty()).toBe(true);

      // Past the mtime the editor loaded, so the refused save can tell.
      await app.page.waitForTimeout(1_500);
      writeFileSync(file, written, 'utf-8');
      // Time for the watcher to report the change, which leaves the editor
      // dirty because the file does not hold its buffer.
      await app.page.waitForTimeout(1_500);
      expect(await editor.isDirty()).toBe(true);

      await editor.activate();
      await app.page.keyboard.press('Control+s');
      await expect.poll(() => editor.isDirty(), { timeout: 10_000 }).toBe(false);
      // Applied twice, line 1 would end in `XX`; only the whole text written
      // over the file gives the buffer back.
      expect(readFileSync(file, 'utf-8')).toBe(buffer);
   });
});
