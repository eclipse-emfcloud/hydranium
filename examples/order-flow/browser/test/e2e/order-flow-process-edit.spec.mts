/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { expect, test } from '@playwright/test';

test.describe('order-flow structured diagram edits', () => {
   test('keeps invalid branch labels editable and reports why they cannot be applied', async ({ page }) => {
      await page.goto('/');
      const diagram = page.locator('#order-flow-process-diagram');
      await diagram
         .locator('text')
         .filter({ hasText: /^PaymentOk$/ })
         .click();
      await diagram.getByRole('button', { name: 'Edit selected effect or gateway' }).click();
      const dialog = page.locator('dialog.order-flow-process-edit');
      await dialog.getByLabel('Target').selectOption('Ship');
      for (const label of ['yes', 'task', 'two words']) {
         await dialog.getByLabel('Label').fill(label);
         await dialog.getByRole('button', { name: 'Apply', exact: true }).click();
         await expect(dialog.getByRole('status')).toContainText(label === 'yes' ? 'already exists' : 'identifier');
         await expect(dialog.getByLabel('Label')).toHaveValue(label);
         await expect(dialog.getByLabel('Target')).toHaveValue('Ship');
      }
      await dialog.getByLabel('Label').fill('later');
      await dialog.getByRole('button', { name: 'Apply', exact: true }).click();
      await expect(diagram.locator('text').filter({ hasText: /^later$/ })).toBeVisible();
   });

   test('disables dependent choices until an outstanding refresh finishes', async ({ page }) => {
      await page.addInitScript(() => {
         const original = MessagePort.prototype.postMessage;
         const pending: Array<() => void> = [];
         const probe = {
            holding: false,
            get pending() {
               return pending.length;
            },
            release() {
               this.holding = false;
               for (const send of pending.splice(0)) {
                  send();
               }
            }
         };
         (window as unknown as { processEditProbe: typeof probe }).processEditProbe = probe;
         MessagePort.prototype.postMessage = function (message: unknown, options?: Transferable[] | StructuredSerializeOptions): void {
            const send = (): void => {
               Reflect.apply(original, this, options === undefined ? [message] : [message, options]);
            };
            if (probe.holding && JSON.stringify(message)?.includes('orderFlowRequestProcessEdit')) {
               pending.push(send);
            } else {
               send();
            }
         };
      });
      await page.goto('/');
      const diagram = page.locator('#order-flow-process-diagram');
      await diagram
         .locator('text')
         .filter({ hasText: /^writes Order.status = PAID$/ })
         .click();
      await diagram.getByRole('button', { name: 'Edit selected effect or gateway' }).click();
      const dialog = page.locator('dialog.order-flow-process-edit');
      await expect(dialog.getByLabel('Literal')).toHaveValue('PAID');
      await page.evaluate(() => {
         (window as unknown as { processEditProbe: { holding: boolean } }).processEditProbe.holding = true;
      });
      await dialog.getByLabel('Field').selectOption('id');
      await expect
         .poll(() => page.evaluate(() => (window as unknown as { processEditProbe: { pending: number } }).processEditProbe.pending))
         .toBe(1);
      await expect(dialog.getByLabel('Literal')).toBeDisabled();
      await expect(dialog.getByLabel('Field')).toBeDisabled();
      await expect(dialog.getByRole('button', { name: 'Apply', exact: true })).toBeDisabled();
      await page.evaluate(() => {
         (window as unknown as { processEditProbe: { release(): void } }).processEditProbe.release();
      });
      await expect(dialog.getByLabel('Literal').locator('option')).toHaveCount(1);
      await expect(dialog.getByLabel('Field')).toBeEnabled();
      await dialog.getByLabel('Field').selectOption('status');
      await expect(dialog.getByLabel('Literal').locator('option')).toHaveCount(5);
      await dialog.getByLabel('Literal').selectOption('NEW');
      await dialog.getByRole('button', { name: 'Apply', exact: true }).click();
      await expect(diagram.locator('text').filter({ hasText: /^writes Order.status = NEW$/ })).toBeVisible();
   });

   test('retargets an effect with dependent choices and creates a labelled branch', async ({ page }) => {
      const errors: string[] = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto('/');
      const diagram = page.locator('#order-flow-process-diagram');
      const effect = diagram.locator('text').filter({ hasText: /^reads Order.id$/ });
      await expect(effect).toBeVisible();
      await effect.click();
      await diagram.getByRole('button', { name: 'Edit selected effect or gateway' }).click();
      const dialog = page.locator('dialog.order-flow-process-edit');
      await expect(dialog.getByLabel('Entity')).toHaveValue('Order');
      await dialog.getByLabel('Entity').selectOption('LineItem');
      await expect(dialog.getByLabel('Field').locator('option')).toContainText(['Choose…', 'price', 'quantity', 'sku']);
      await expect(dialog.getByLabel('Field')).toHaveValue('');
      await dialog.getByLabel('Field').selectOption('sku');
      await dialog.getByRole('button', { name: 'Apply', exact: true }).click();
      await expect(diagram.locator('text').filter({ hasText: /^reads LineItem.sku$/ })).toBeVisible();
      const write = diagram.locator('text').filter({ hasText: /^writes Order.status = PAID$/ });
      await write.click();
      await diagram.getByRole('button', { name: 'Edit selected effect or gateway' }).click();
      await expect(dialog.getByLabel('Literal')).toHaveValue('PAID');
      await dialog.getByLabel('Field').selectOption('id');
      await expect(dialog.getByLabel('Literal').locator('option')).toHaveCount(1);
      await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
      await expect(write).toBeVisible();
      await diagram.getByRole('button', { name: 'Edit selected effect or gateway' }).click();
      await expect(dialog.getByLabel('Literal')).toHaveValue('PAID');
      await dialog.getByLabel('Literal').selectOption('NEW');
      await dialog.getByRole('button', { name: 'Apply', exact: true }).click();
      await expect(diagram.locator('text').filter({ hasText: /^writes Order.status = NEW$/ })).toBeVisible();
      await diagram
         .locator('text')
         .filter({ hasText: /^PaymentOk$/ })
         .click();
      await diagram.getByRole('button', { name: 'Edit selected effect or gateway' }).click();
      await expect(dialog.getByLabel('Target')).toBeVisible();
      await dialog.getByLabel('Label').fill('later');
      await dialog.getByLabel('Target').selectOption('Ship');
      await dialog.getByRole('button', { name: 'Apply', exact: true }).click();
      await expect(diagram.locator('text').filter({ hasText: /^later$/ })).toBeVisible();
      expect(errors).toEqual([]);
   });
});
