/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * What the extension's webviews draw in a real VS Code, and that a properties
 * write reaches the server. Everything the extension API can see is the host
 * tier's.
 */

import { expect, type FrameLocator } from '@playwright/test';
import { launchOrderFlowVscode, quickOpen, runCommand, test, webview, type OrderFlowVscode } from './order-flow-vscode.mjs';

/**
 * Serial, and one VS Code for the file: the property tests build on each other
 * (the repair undoes the break), and without serial mode a retry would re-run
 * `beforeAll` and only the failed test.
 */
test.describe.serial('Order-flow webviews in VS Code', () => {
   let vscode: OrderFlowVscode;

   test.beforeAll(async () => {
      vscode = await launchOrderFlowVscode();
   });

   test.afterAll(async () => {
      await vscode?.close();
   });

   test('a .process opened from Quick Open renders as a diagram', async () => {
      await quickOpen(vscode.page, 'orders/fulfillment.process');
      const diagram = webview(vscode.page);
      // The first request to the GLSP head pays the language server's cold
      // start: it has to walk the workspace before the port command answers.
      await expect(diagram.locator('.sprotty svg').first()).toBeVisible({ timeout: 60_000 });
      await expect(diagram.locator('.sprotty').getByText('Pay', { exact: false }).first()).toBeVisible();
      await expect(diagram.locator('.sprotty').getByText('Ship', { exact: false }).first()).toBeVisible();
      await runCommand(vscode.page, 'View: Close All Editors');
   });

   test("the properties panel shows the active document's root fields", async () => {
      // As text, because the panel follows the active TEXT editor; the
      // diagram is a custom editor and does not count as one.
      await quickOpen(vscode.page, 'orders/fulfillment.process');
      await expect(webview(vscode.page).locator('.sprotty svg').first()).toBeVisible();
      await runCommand(vscode.page, 'View: Reopen Editor with Text Editor');
      await expect(vscode.page.locator('.monaco-editor .view-lines').first()).toContainText('process Fulfillment');

      await runCommand(vscode.page, 'Order Flow: Show Properties');
      const panel = webview(vscode.page);
      await expect(panel.locator('h1')).toHaveText('orders/fulfillment.process');
      await expect(panel.locator('input#field-name')).toHaveValue('Fulfillment', { timeout: 60_000 });
      await expect(panel.locator('input#field-subject')).toHaveValue('Order');
   });

   test('writing an unresolvable reference is accepted and the server reports it', async () => {
      // A diagnostic can only come from the server parsing, linking and
      // validating the written document, so this proves the write reached it;
      // reading the input back would only prove the DOM echoed the typing.
      const panel = webview(vscode.page);
      await setField(panel, 'subject', 'Nonexistent');
      const diagnostics = panel.locator('.diagnostics li');
      await expect(diagnostics.first()).toContainText('Nonexistent');
      await expect(diagnostics.first()).toContainText('error');
   });

   test('repairing the reference clears the diagnostic', async () => {
      const panel = webview(vscode.page);
      await setField(panel, 'subject', 'Order');
      // `toHaveCount(0)` retries for the whole timeout, so it waits for the
      // rebuild rather than reading the list once before it lands.
      await expect(panel.locator('.diagnostics li')).toHaveCount(0);
      await expect(panel.locator('input#field-subject')).toHaveValue('Order');
   });
});

/**
 * Write `value` into the panel's `fieldName` input and commit it. `Enter`,
 * because the input commits on `change`, which `fill` alone does not fire.
 */
async function setField(panel: FrameLocator, fieldName: string, value: string): Promise<void> {
   const input = panel.locator(`input#field-${fieldName}`);
   await input.fill(value);
   await input.press('Enter');
}
