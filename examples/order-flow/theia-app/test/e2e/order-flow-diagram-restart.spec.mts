/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * What an open diagram does when the language server is killed underneath it.
 *
 * The GLSP server lives in the language server's process, so the kill takes the
 * diagram's server with it. The client contribution starts a fresh client over
 * a fresh channel, the backend forwarder finds the replacement's new port, and
 * the diagram reopens in its tab as a fresh widget.
 *
 * A diagram that did not recover still shows its old nodes, so they prove
 * nothing on their own. The loading overlay coming back after the kill says the
 * tab reopened, a GLSP connection in the server log after the kill says it
 * reached the replacement server, and an edit applied exactly once says the
 * diagram is editable again rather than only drawn.
 *
 * **Runs alone, with one worker**, for the reason the data-head restart spec
 * gives: it kills a process by command-line pattern.
 */

import { expect } from '@playwright/test';
import { resolveServerLogPath } from '@hydranium/core/testing/playwright';
import { type TheiaApp, TheiaExplorerView } from '@theia/playwright';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { languageServerPids, loadOrderFlowApp, SERVER_PROCESS_PATTERN, test } from './order-flow-app.mjs';

/** Class contract published by `@hydranium/glsp-client-theia`'s diagram widget. */
const LOADING_OVERLAY_CLASS = 'hydranium-diagram-loading';

/** Logged by the GLSP server when a client connects to its socket. */
const GLSP_CONNECTION_LINE = 'Starting GLSP server connection';

test.describe.serial('Order-flow diagram across a language-server restart', { tag: '@restart' }, () => {
   let app: TheiaApp;

   test.beforeAll(async ({ playwright, browser }) => {
      app = await loadOrderFlowApp({ playwright, browser });
   });

   test.afterAll(async () => {
      await app.page.close();
   });

   test('the diagram loads before the restart', async () => {
      const explorer = await app.openView(TheiaExplorerView);
      await explorer.waitForVisibleFileNodes();
      await explorer.clickContextMenuItem('orders/fulfillment.process', ['Open']);
      await expect(app.page.locator('.sprotty').getByText('Pay', { exact: false }).first()).toBeVisible({ timeout: 30_000 });
      await expect(app.page.locator(`.${LOADING_OVERLAY_CLASS}`)).toHaveCount(0);
      expect(languageServerPids().length, 'no language server to restart').toBeGreaterThan(0);
   });

   test('the diagram loads again on the replacement server', async () => {
      test.setTimeout(120_000);
      // Watched from before the kill: the reload's overlay can come and go
      // between two polls.
      await app.page.evaluate(overlayClass => {
         const globals = window as unknown as { __hydraniumReloadSeen?: boolean };
         globals.__hydraniumReloadSeen = false;
         new MutationObserver(records => {
            for (const record of records) {
               for (const node of Array.from(record.addedNodes)) {
                  if (node instanceof HTMLElement && node.classList.contains(overlayClass)) {
                     globals.__hydraniumReloadSeen = true;
                  }
               }
            }
         }).observe(document.body, { childList: true, subtree: true });
      }, LOADING_OVERLAY_CLASS);

      const before = languageServerPids();
      execFileSync('pkill', ['-f', SERVER_PROCESS_PATTERN]);
      await expect
         .poll(() => languageServerPids().filter(pid => !before.includes(pid)).length, {
            message: 'the language server did not restart under a new pid',
            timeout: 60_000
         })
         .toBeGreaterThan(0);

      await expect
         .poll(() => app.page.evaluate(() => (window as unknown as { __hydraniumReloadSeen?: boolean }).__hydraniumReloadSeen === true), {
            message: 'the diagram never reloaded after the kill',
            timeout: 60_000
         })
         .toBe(true);
      await expect(app.page.locator(`.${LOADING_OVERLAY_CLASS}`)).toHaveCount(0, { timeout: 60_000 });
      await expect(app.page.locator('.sprotty').getByText('Pay', { exact: false }).first()).toBeVisible();

      const log = resolveServerLogPath(app.workspace.path);
      expect(log, 'no server log to read').toBeDefined();
      const text = readFileSync(log!, 'utf-8');
      const sinceTheKill = text.slice(text.lastIndexOf('===== START: the diagram loads again'));
      expect(sinceTheKill, 'no client reached the replacement GLSP server').toContain(GLSP_CONNECTION_LINE);
   });

   /** A diagram loaded again in the same container registers GLSP's model
    *  source handlers twice, and then sends every edit twice: a second task. */
   test('an edit after the restart applies once', async () => {
      const diagram = app.page.locator('#theia-main-content-panel .sprotty').first();
      // A second task would be proposed under the next free name that starts with `NewTask`.
      const newTasks = diagram.locator('svg.sprotty-graph').getByText(/^NewTask/);
      const taskTool = app.page.locator('#theia-main-content-panel .tool-button', { hasText: 'Task' });
      const box = await diagram.boundingBox();
      expect(box, 'the diagram has no box to click in').not.toBeNull();
      // Retried because a model update right after the load disarms the
      // palette's tool; a retry follows only a click that created nothing.
      await expect(async () => {
         await taskTool.click();
         await expect(taskTool).toHaveClass(/clicked/);
         // Low and left of centre, where the fitted process leaves empty canvas.
         await diagram.click({ position: { x: box!.width * 0.4, y: box!.height * 0.85 } });
         await expect(newTasks).not.toHaveCount(0, { timeout: 5_000 });
      }).toPass({ timeout: 30_000 });
      // The create opens the new node's label editor, which would keep the keyboard.
      await app.page.keyboard.press('Escape');

      await expect(newTasks).toHaveCount(1);
      // A second application would land right after the first.
      await app.page.waitForTimeout(2_000);
      await expect(newTasks).toHaveCount(1);
   });
});
