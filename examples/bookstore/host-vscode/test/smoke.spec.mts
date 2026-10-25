/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

// VS Code opens a copy of the starter workspace with this extension loaded, the
// data head reads the file, the diagram file draws in its diagram editor, and
// the server reports a reference that resolves to nothing.

import { _electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { downloadAndUnzipVSCode } from '@vscode/test-electron';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VSCODE_CACHE, VSCODE_VERSION } from './vscode-version.mts';

const extensionRoot = fileURLToPath(new URL('..', import.meta.url));

test('reads the model, draws the diagram, and reports a broken reference', async () => {
   // A copy, since the server writes its repairs to the folder it opens, and a
   // fresh profile, since a reused one restores the last run's editors.
   const scratch = mkdtempSync(join(tmpdir(), 'bookstore-vscode-'));
   const workspace = join(scratch, 'workspace');
   cpSync(fileURLToPath(new URL('../../workspace', import.meta.url)), workspace, { recursive: true });
   let app: ElectronApplication | undefined;
   try {
      app = await _electron.launch({
         executablePath: await downloadAndUnzipVSCode({ version: VSCODE_VERSION, cachePath: VSCODE_CACHE }),
         args: [
            '--no-sandbox',
            '--disable-gpu-sandbox',
            '--disable-updates',
            '--skip-welcome',
            '--skip-release-notes',
            '--disable-workspace-trust',
            '--disable-extensions',
            `--extensionDevelopmentPath=${extensionRoot}`,
            `--user-data-dir=${join(scratch, 'user-data')}`,
            `--extensions-dir=${join(scratch, 'extensions')}`,
            workspace
         ]
      });
      const page = await app.firstWindow();
      await expect(page.locator('.monaco-workbench')).toBeVisible();
      await quickOpen(page, 'nodes.bookstore');
      // The data head reads the open file.
      await page.keyboard.press('ControlOrMeta+Shift+P');
      await page.locator('.quick-input-widget input').fill('>Bookstore: Show Model');
      await page
         .locator('.quick-input-list')
         .getByRole('option', { name: /^Bookstore: Show Model(,|$)/ })
         .click();
      await expect(page.locator('.notification-toast').filter({ hasText: 'nodes.bookstore holds a BookstoreModel' })).toBeVisible();

      // The diagram file opens in its diagram, which draws the two starter nodes.
      const webview = page.frameLocator('iframe.webview.ready').frameLocator('#active-frame');
      // In the editor's container: sprotty measures shapes in a hidden copy beside it.
      await expect(webview.locator('.hydranium-diagram-container .sprotty-node')).toHaveCount(2);
      // Then as text. The row is clicked, since Enter runs the best fuzzy match,
      // and its name ends in its keybinding, if it has one.
      await page.keyboard.press('ControlOrMeta+Shift+P');
      await page.locator('.quick-input-widget input').fill('>View: Reopen Editor with Text Editor');
      await page
         .locator('.quick-input-list')
         .getByRole('option', { name: /^View: Reopen Editor with Text Editor(,|$)/ })
         .click();

      const editor = page.locator('.monaco-editor .view-lines').first();
      await expect(editor).toContainText('node First');
      await editor.click();
      await page.keyboard.press('ControlOrMeta+End');
      // In one edit: typed key by key, the half-typed reference is reported on the way.
      await page.keyboard.insertText('\nnode Broken -> Missing');
      await expect(page.locator('.monaco-editor .squiggly-error').first()).toBeVisible();
   } finally {
      await app?.close();
      rmSync(scratch, { recursive: true, force: true });
   }
});

/** Open `file` through Quick Open, so it gets the editor a user would. */
async function quickOpen(page: Page, file: string): Promise<void> {
   await page.keyboard.press('ControlOrMeta+P');
   const input = page.locator('.quick-input-widget input');
   await input.fill(file);
   await expect(page.locator('.quick-input-list .monaco-list-row').first()).toContainText(file);
   await input.press('Enter');
   await expect(page.locator('.quick-input-widget')).toBeHidden();
}
