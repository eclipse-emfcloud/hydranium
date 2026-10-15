/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

// The page loads with every head answering, and an edit saved through the
// LSP head is still there after a reload; any console error fails that
// test. The other asks before a reload drops a diagram edit the server has not
// answered yet, and keeps it when Save is clicked at once.

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
   // The diagram follows the switch: two nodes in one file, and in the other its
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

test('asks before a reload drops a diagram edit the server has not answered, and saves it with Save at once', async ({ page }) => {
   const nodes = page.locator('#diagram .sprotty-node');
   const askGuard = (): Promise<boolean> =>
      page.evaluate(() => {
         const event = new Event('beforeunload', { cancelable: true });
         window.dispatchEvent(event);
         return event.defaultPrevented;
      });
   await page.goto('/');
   await expect(page.locator('#status')).toHaveText('ready');
   await page.locator('#file').selectOption('nodes.bookstore');
   await expect(nodes).toHaveCount(2);

   const canvas = page.locator('#diagram');
   await page.locator('#diagram .tool-button', { hasText: 'BookstoreNode' }).click();
   const size = await canvas.evaluate(element => ({ width: element.clientWidth, height: element.clientHeight }));
   // Asked and clicked right after the click's own handlers, in the same turn
   // of the page, so the server's answer cannot have marked anything unsaved.
   await page.evaluate(() => {
      window.addEventListener(
         'mouseup',
         () =>
            queueMicrotask(() => {
               const event = new Event('beforeunload', { cancelable: true });
               window.dispatchEvent(event);
               document.getElementById('save')?.click();
               Reflect.set(window, 'guardedOnCreate', event.defaultPrevented);
            }),
         { once: true }
      );
   });
   await canvas.click({ position: { x: size.width * 0.4, y: size.height * 0.85 } });
   expect(await page.evaluate(() => Reflect.get(window, 'guardedOnCreate'))).toBe(true);
   await expect(page.locator('#status')).toHaveText('saved 1 file(s)');
   expect(await askGuard()).toBe(false);

   await page.reload();
   await expect(page.locator('#status')).toHaveText('ready');
   await page.locator('#file').selectOption('nodes.bookstore');
   await expect(nodes).toHaveCount(3);
});
