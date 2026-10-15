/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

// The page loads with every head answering, and an edit saved through the
// LSP head is still there after a reload. Any console error fails it.

import { expect, test } from '@playwright/test';

test('loads every head and keeps a saved edit across a reload', async ({ page }) => {
   const errors: string[] = [];
   page.on('pageerror', error => errors.push(error.message));
   page.on('console', message => {
      if (message.type() === 'error') {
         errors.push(message.text());
      }
   });
   const editor = page.locator('#editor .view-lines');

   await page.goto('/');
   await expect(page.locator('#status')).toHaveText('ready');
   await expect(editor).toContainText('node First');
   // The data head reads the document out of the same store.
   await expect(page.locator('#data-status')).toHaveText('data head: nodes.bookstore holds a BookstoreModel');
   // The diagram follows the editor: two nodes in one file, and in the other its
   // node and the target it references there, drawn as external.
   const first = await page.locator('#file').inputValue();
   await page.locator('#file').selectOption('nodes.bookstore');
   await expect(page.locator('#diagram .sprotty-node')).toHaveCount(2);
   await page.locator('#file').selectOption('references.bookstore');
   await expect(page.locator('#diagram .external')).toHaveText('Second (nodes.bookstore)');
   await page.locator('#file').selectOption(first);

   await editor.click();
   await page.keyboard.press('ControlOrMeta+End');
   await page.keyboard.type('\nnode Added');
   await page.locator('#save').click();
   await expect(page.locator('#status')).toHaveText('saved 1 file(s)');

   await page.reload();
   await expect(page.locator('#status')).toHaveText('ready');
   await expect(editor).toContainText('node Added');
   expect(errors).toEqual([]);
});
