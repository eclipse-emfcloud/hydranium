/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { expect } from '@playwright/test';
import { type TheiaApp, TheiaTextEditor } from '@theia/playwright';
import { loadOrderFlowApp, test } from './order-flow-app.mjs';

test.describe('virtual documents in Theia', () => {
   let app: TheiaApp;
   test.beforeAll(async ({ playwright, browser }) => {
      app = await loadOrderFlowApp({ playwright, browser });
   });
   test.afterAll(async () => {
      await app.page.close();
   });

   test('keeps a library opened through definition read-only', async () => {
      const editor = await app.openEditor('orders/orders.domain', TheiaTextEditor);
      await editor.placeCursorInLineWithLineNumber(24);
      await app.page.keyboard.press('Home');
      for (let i = 0; i < 16; i++) await app.page.keyboard.press('ArrowRight');
      await app.page.keyboard.press('F12');
      const library = app.page.locator('.monaco-editor .view-lines').filter({ hasText: 'valuetype String' });
      await expect(library).toBeVisible();
      const before = await library.innerText();
      await library.click();
      await app.page.keyboard.press('Control+Home');
      await app.page.keyboard.type('XY');
      await expect(app.page.locator('p').filter({ hasText: 'Cannot edit in read-only editor' })).toBeVisible();
      await expect(library).toHaveText(before, { useInnerText: true });
   });
});
