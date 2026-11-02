/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { expect, test } from '@playwright/test';

test.describe('order-flow adopter feedback', () => {
   test('Ctrl+S applies the focused draft before saving it', async ({ page }) => {
      await page.goto('/');
      const name = page.locator('#properties-body #field-name');
      await expect(name).toHaveValue('Fulfillment');
      await name.fill('AppliedVersion');
      await name.press('Enter');
      await expect(page.locator('#process-editor-title')).toHaveClass(/is-dirty/);
      await name.fill('TypedVersion');
      await name.press('Control+s');
      await expect(page.locator('[data-report="workspace"]')).toHaveAttribute('title', /^saved 1 document/);
      await expect(page.locator('#properties-body [data-pending]')).toHaveCount(0);
      await page.reload();
      await expect(name).toHaveValue('TypedVersion');
   });

   test('a draft submitted by saving times out while its response is held', async ({ page }) => {
      await page.goto('/');
      const name = page.locator('#properties-body #field-name');
      await expect(name).toHaveValue('Fulfillment');
      const worker = page.workers().find(candidate => candidate.url().includes('order-flow-worker'))!;
      // Hold actual replies after the worker has applied the write. Requests
      // and notifications still flow, including the edit sent to Monaco.
      await worker.evaluate(() => {
         const replies: Array<() => void> = [];
         const post = MessagePort.prototype.postMessage;
         MessagePort.prototype.postMessage = function (this: MessagePort, ...args: unknown[]) {
            const message = args[0];
            if (message && typeof message === 'object' && 'id' in message && ('result' in message || 'error' in message)) {
               replies.push(() => Reflect.apply(post, this, args));
            } else {
               Reflect.apply(post, this, args);
            }
         };
         Object.assign(globalThis, {
            heldSaveReplies: replies,
            releaseSaveReplies: () => {
               MessagePort.prototype.postMessage = post;
               replies.splice(0).forEach(reply => reply());
            }
         });
      });
      await page.clock.install();
      await name.fill('DelayedDraft');
      await name.press('Control+s');
      await expect.poll(() => worker.evaluate(() => Reflect.get(globalThis, 'heldSaveReplies').length)).toBeGreaterThan(0);
      const report = page.locator('[data-report="workspace"]');
      await expect(report).toHaveAttribute('title', 'saving…');
      await page.clock.fastForward(31_000);
      await expect(report).toHaveAttribute('title', /save failed:.*not answered/);
      expect(
         await page.evaluate(() => {
            const event = new Event('beforeunload', { cancelable: true });
            window.dispatchEvent(event);
            return event.defaultPrevented;
         })
      ).toBe(true);

      await worker.evaluate(() => Reflect.get(globalThis, 'releaseSaveReplies')());
      await expect(page.locator('#properties-body [data-pending]')).toHaveCount(0);
      await name.press('Control+s');
      await expect(report).toHaveAttribute('title', /^saved 1 document/);
      await page.reload();
      await expect(name).toHaveValue('DelayedDraft');
   });

   test('a draft without a submitted write prevents unloading', async ({ page }) => {
      await page.goto('/');
      const name = page.locator('#properties-body #field-name');
      await expect(name).toHaveValue('Fulfillment');
      await name.fill('UnsavedDraft');
      await expect(page.locator('#process-editor-title')).not.toHaveClass(/is-dirty/);
      const guarded = await page.evaluate(() => {
         const event = new Event('beforeunload', { cancelable: true });
         window.dispatchEvent(event);
         return event.defaultPrevented;
      });
      expect(guarded).toBe(true);
   });

   test('reset in a narrow viewport forgets suspended desktop sizes', async ({ page }) => {
      await page.goto('/');
      await expect(page.locator('#properties-body #field-name')).toHaveValue('Fulfillment');
      const sidebar = page.locator('#sidebar-column');
      const original = (await sidebar.boundingBox())!.width;
      const divider = await page.locator('[data-splitter="--sidebar-width"]').boundingBox();
      await page.mouse.move(divider!.x + 2, divider!.y + 20);
      await page.mouse.down();
      await page.mouse.move(divider!.x + 100, divider!.y + 20);
      await page.mouse.up();
      const customized = (await sidebar.boundingBox())!.width;
      expect(customized).toBeGreaterThan(original + 40);
      await page.setViewportSize({ width: 800, height: 1000 });
      await page.setViewportSize({ width: 1600, height: 1000 });
      await expect.poll(async () => (await sidebar.boundingBox())!.width).toBe(customized);
      await page.setViewportSize({ width: 800, height: 1000 });
      await page.locator('#reset-layout').click();
      await page.setViewportSize({ width: 1600, height: 1000 });
      await expect.poll(async () => (await sidebar.boundingBox())!.width).toBe(original);
   });

   test('diagnostic navigation expands its collapsed target', async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto('/');
      const pane = page.locator('#selected-pane');
      const head = pane.locator('.pane-head');
      await expect(head).toHaveAttribute('aria-expanded', 'true');
      await head.click();
      await expect(head).toHaveAttribute('aria-expanded', 'false');
      await page.locator('#problem-list .problem-row').filter({ hasText: 'AuditStamp' }).click();
      await expect(head).toHaveAttribute('aria-expanded', 'true');
      await expect(pane).not.toHaveAttribute('data-collapsed');
      await expect(page.locator('#selected-editor .view-line').filter({ hasText: 'stamp: AuditStamp' })).toBeVisible();
   });

   test('space clears the log without collapsing its panel', async ({ page }) => {
      await page.setViewportSize({ width: 800, height: 1000 });
      await page.goto('/');
      await expect(page.locator('#properties-body #field-name')).toHaveValue('Fulfillment');
      const clear = page.getByRole('button', { name: 'Clear the lines held here', exact: true });
      await clear.focus();
      await clear.press('Space');
      await expect(page.locator('#log-panel > .panel-head')).toHaveAttribute('aria-expanded', 'true');
      await expect(page.locator('#log').locator(':scope > *')).toHaveCount(0);
   });

   test('task names and branch labels open inline editors', async ({ page }) => {
      await page.goto('/');
      const diagram = page.locator('#order-flow-process-diagram');
      const pay = diagram.locator('text').filter({ hasText: /^Pay$/ });
      await expect(pay).toBeVisible();
      await pay.dblclick();
      const input = page.locator('.label-edit input');
      await expect(input).toBeVisible();
      await input.fill('Charge');
      await input.press('Enter');
      await expect(diagram.locator('text').filter({ hasText: /^Charge$/ })).toBeVisible();
      await diagram.locator('text').filter({ hasText: /^yes$/ }).dblclick();
      await expect(input).toBeVisible();
      await input.fill('approved');
      await input.press('Enter');
      await expect(diagram.locator('text').filter({ hasText: /^approved$/ })).toBeVisible();
   });

   test('creating a task starts its inline rename', async ({ page }) => {
      await page.goto('/');
      const diagram = page.locator('#order-flow-process-diagram');
      await expect(diagram.locator('text').filter({ hasText: /^Pay$/ })).toBeVisible();
      await diagram.locator('.tool-button', { hasText: 'Task' }).click();
      const box = (await diagram.boundingBox())!;
      await diagram.click({ position: { x: box.width * 0.4, y: box.height * 0.85 } });
      const input = page.locator('.label-edit input');
      await expect(input).toBeVisible();
      await input.fill('CreatedTask');
      await input.press('Enter');
      await expect(diagram.locator('text').filter({ hasText: /^CreatedTask$/ })).toBeVisible();
   });

   test('rapid switching keeps the properties title and write target together', async ({ page }) => {
      await page.goto('/');
      const name = page.locator('#properties-body #field-name');
      await expect(name).toHaveValue('Fulfillment');
      await page.evaluate(() => {
         const rows = [...document.querySelectorAll<HTMLElement>('#document-list .document-row')];
         for (const path of ['orders/returns.process', 'orders/fulfillment.process']) {
            rows.find(row => row.textContent?.includes(path))!.click();
         }
      });
      await expect(name).toBeEnabled();
      await expect(name).toHaveValue('Fulfillment');
      await name.fill('RightFileEdit');
      await name.press('Enter');
      await expect(page.locator('#process-editor .view-line').filter({ hasText: 'process RightFileEdit' })).toHaveCount(1);
      await page.locator('#document-list .document-row').filter({ hasText: 'orders/returns.process' }).click();
      await expect(name).toHaveValue('Returns');
   });
});
