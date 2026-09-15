/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * What a brief network glitch does to an open model.
 *
 * The browser's socket dies and reconnects within seconds while the server still
 * believes the old one is alive. Several things go wrong in that window when the
 * connection hardening is not installed, and none of them reports anything: the
 * abandoned socket tears the session off the healthy one, buffered messages are
 * concatenated so all but the first are dropped, and messages produced during
 * the handshake overtake the backlog or land on a socket the server has not
 * attached yet. The editor keeps responding throughout, which is what makes this
 * worth testing — the work is simply gone.
 *
 * **A server-produced diagnostic is the assertion**: writing an unresolvable
 * reference is accepted and comes back as a diagnostic, which can only exist if
 * the write reached the server and a real parse, link and validate ran on it.
 * Reading the input back would prove only that the DOM echoed what was typed,
 * and a file on disk would prove only that something saved.
 *
 * Driven through `startFlakyNetworkProxy`, which kills the browser side of a
 * connection and leaves the server side open. That asymmetry cannot be produced
 * from inside the app or with Playwright's offline emulation — both close
 * cleanly at both ends, and the server then notices at once, closing the very
 * window these tests need.
 */

import { flakyNetworkControlClient } from '@hydranium/core/testing/playwright';
import { expect, test } from '@playwright/test';
import { type TheiaApp, TheiaAppLoader, TheiaWorkspace } from '@theia/playwright';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { openPropertiesPanel, PROPERTIES_PANEL as PANEL, selectFile } from '../e2e/order-flow-app.mjs';
import { BACKEND_LOG, CONTROL_URL } from './reconnect-ports.mjs';

const WORKSPACE_SOURCE = path.resolve(import.meta.dirname, '..', '..', '..', 'workspace');
const PROCESS_FILE = 'orders/fulfillment.process';

const proxy = flakyNetworkControlClient(CONTROL_URL);

test.describe.serial('An order-flow model survives a reconnect', () => {
   let app: TheiaApp;

   /** Collected for the whole run: a reordered or missing message surfaces as an
    *  exception in the plugin host rather than as a failed edit, so a passing
    *  edit alone would not catch it. */
   const pageErrors: { phase: string; message: string }[] = [];
   let phase = 'before the first test';

   async function setField(fieldName: string, value: string): Promise<void> {
      const input = app.page.locator(`${PANEL} input#field-${fieldName}`);
      await input.fill(value);
      await input.press('Enter');
   }

   /**
    * Writes a reference the server cannot resolve and waits for it to say so.
    *
    * The round trip is the point: the diagnostic names the value that was
    * written, so it cannot be a stale one left over from an earlier step.
    */
   async function expectWriteToReachServer(value: string): Promise<void> {
      await setField('subject', value);
      const diagnostics = app.page.locator(`${PANEL} .diagnostics li`);
      // Generous, because after an outage this also covers socket.io's reconnect
      // backoff and the rebuild that follows it.
      await expect(diagnostics.first()).toContainText(value, { timeout: 60_000 });
      await expect(diagnostics.first()).toContainText('error');
   }

   /** Puts the model back so the next step's diagnostic cannot be the last one's. */
   async function repair(): Promise<void> {
      await setField('subject', 'Order');
      await expect(app.page.locator(`${PANEL} .diagnostics li`)).toHaveCount(0, { timeout: 60_000 });
   }

   /** Polls rather than sleeping: the reconnect takes socket.io's backoff plus a rebuild. */
   async function waitForBackendReachable(): Promise<void> {
      await expect
         .poll(async () => app.page.evaluate(() => !document.body.classList.contains('theia-mod-offline')), { timeout: 60_000 })
         .toBe(true);
   }

   test.beforeAll(async ({ playwright, browser }) => {
      app = await TheiaAppLoader.load({ playwright, browser }, new TheiaWorkspace([WORKSPACE_SOURCE]));
      app.page.on('pageerror', error => pageErrors.push({ phase, message: error.message }));

      await openPropertiesPanel(app);
      await selectFile(app, PROCESS_FILE);
      // The first request pays the data head's whole cold start — the plugin host
      // forks the language server and it walks the workspace before anything can
      // answer — so this one wait is deliberately far above the others.
      await expect(app.page.locator(`${PANEL} input#field-subject`)).toHaveValue('Order', { timeout: 120_000 });
   });

   test.beforeEach(() => {
      phase = test.info().title;
   });

   test.afterAll(async () => {
      await app?.page?.close();
   });

   test('an edit lands before any disruption', async () => {
      // Establishes that the check can tell a delivered edit from a lost one;
      // without it a later pass could mean the check never worked at all.
      await expectWriteToReachServer('BeforeAnyBreak');
      await repair();
   });

   test('an edit made while disconnected lands once the browser reconnects', async () => {
      // The edit has to happen DURING the outage: that is what puts it in the
      // queue the reconnect has to deliver. Editing afterwards would never
      // exercise the queue at all.
      expect(await proxy.break()).toContain('broken');

      await setField('subject', 'WrittenWhileOffline');
      await waitForBackendReachable();

      const diagnostics = app.page.locator(`${PANEL} .diagnostics li`);
      await expect(diagnostics.first()).toContainText('WrittenWhileOffline', { timeout: 60_000 });
      await repair();
   });

   test('an edit lands after the abandoned socket is reaped', async () => {
      // The socket the browser walked away from is only noticed by the server
      // much later. That late notification must not disturb the connection that
      // replaced it.
      expect(await proxy.release()).toContain('destroyed');

      await expectWriteToReachServer('AfterStaleSocketReaped');
      await repair();
   });

   test('the server refused the stale socket rather than acting on it', async () => {
      // The preceding test shows the session SURVIVED the late disconnect, which
      // it would also do if the guard were absent and the timing merely kind.
      // This is the direct evidence: the guard says which socket it ignored and
      // which one owns the channel, and it only logs that on the path where
      // Theia would otherwise have torn the session off a healthy socket.
      //
      // Polled because the backend writes this to a file of its own accord —
      // there is no handshake telling us it has flushed.
      await expect
         .poll(() => readFileSync(BACKEND_LOG, 'utf-8'), { timeout: 30_000 })
         .toMatch(/\[connection\] ignoring disconnect of stale socket \S+ .*owns it/);
   });

   test('nothing threw along the way', () => {
      // Messages arriving out of order, or not at all, corrupt the plugin host's
      // line-indexed copy of every open document, which shows up here and
      // nowhere else. Grouped because one desynchronised document throws
      // repeatedly: the count says how loud it was, not how many faults occurred.
      const grouped = pageErrors.reduce<Record<string, number>>((counts, error) => {
         const key = `[${error.phase}] ${error.message}`;
         counts[key] = (counts[key] ?? 0) + 1;
         return counts;
      }, {});

      expect(grouped).toEqual({});
   });
});
