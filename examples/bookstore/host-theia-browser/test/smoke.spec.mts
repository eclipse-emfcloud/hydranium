/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

// Theia opens a copy of the starter workspace with this application's
// extensions, the diagram file draws in its diagram editor, the data head reads
// the file, and the server reports a reference that resolves to nothing.

import { expect, test, type Page } from '@playwright/test';

test('draws the diagram, reads the model, and reports a broken reference', async ({ page }) => {
   await page.goto('/');
   // Up once the loading screen is gone; a key pressed before then is lost.
   await expect(page.locator('.theia-preload')).toHaveCount(0);
   await page.keyboard.press('ControlOrMeta+Shift+E');
   await expect(page.locator('.theia-FileTree .theia-TreeNode', { hasText: 'nodes.bookstore' })).toBeVisible();
   await quickOpen(page, 'nodes.bookstore');

   // The diagram file opens in its diagram, which draws the two starter nodes.
   // In the editor's copy: sprotty measures shapes in a hidden one on the page.
   await expect(page.locator('.sprotty:not(.sprotty-hidden) .sprotty-node')).toHaveCount(2);

   // The data head reads the open file, with focus in the Explorer beside it.
   await page.locator('.theia-FileTree .theia-TreeNode', { hasText: 'nodes.bookstore' }).click();
   await expect(page.locator('.theia-FileTree:focus-within')).toHaveCount(1);
   await runCommand(page, 'Bookstore: Show Model');
   // `first()`: Theia lists a notification in its toast and in the notification centre.
   await expect(
      page.locator('.theia-notification-message').filter({ hasText: 'nodes.bookstore holds a BookstoreModel' }).first()
   ).toBeVisible();

   // Then as text, through the Explorer's Open With.
   await page.locator('.theia-FileTree .theia-TreeNode', { hasText: 'nodes.bookstore' }).click({ button: 'right' });
   await page.locator('.lm-Menu-item', { hasText: 'Open With...' }).click();
   await page.locator('.quick-input-list .monaco-list-row', { hasText: 'Text Editor' }).click();
   const editor = page.locator('.monaco-editor .view-lines').first();
   await expect(editor).toContainText('node First');
   await editor.click();
   await page.keyboard.press('ControlOrMeta+End');
   // In one edit: typed key by key, the half-typed reference is reported on the way.
   await page.keyboard.insertText('\nnode Broken -> Missing');
   await expect(page.locator('.monaco-editor .squiggly-error').first()).toBeVisible();
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

/** Run the command whose palette entry reads `label`, checked before Enter, since the match is fuzzy. */
async function runCommand(page: Page, label: string): Promise<void> {
   await page.keyboard.press('F1');
   const input = page.locator('.quick-input-widget input');
   await input.fill(`>${label}`);
   await expect(page.locator('.quick-input-list .monaco-list-row.focused')).toContainText(label);
   await input.press('Enter');
   await expect(page.locator('.quick-input-widget')).toBeHidden();
}
