/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * Theia end-to-end for the memory-diagnostics commands.
 *
 * A third spec beside the properties and diagram ones because its subject is
 * neither view: it is the extension's SECOND channel to the data head. The
 * properties panel drives that head through a host-neutral `DataPort`, while
 * `OrderFlowDiagnosticsDataService` is a Theia `AbstractDataServiceFrontend`
 * owning its own channel — and Theia keys a frontend channel by its service
 * path and refuses a second channel on a path already open, so the two need
 * separate paths and a backend forwarder each.
 *
 * **Why this spec exists rather than being folded into the panel's.** The
 * diagnostics commands had no end-to-end coverage at all, and the cost of that
 * was a shipped hang: both frontends sat on the framework default path, the
 * later opener threw inside an `openChannelConnection` the other was awaiting,
 * and the loser's promise was left unsettled rather than rejected. The panel
 * showed `Loading…` indefinitely with a clean server log and one unread page
 * error.
 *
 * It is worth being precise about what this test does and does not catch. It
 * would NOT have caught that original bug — the diagnostics service starts
 * eagerly at `@postConstruct`, so it won the race and the PANEL was the casualty,
 * which the properties spec catches. What it covers is the direction nothing
 * covered: this path answering at all. A wrong service path here forwards to no
 * one and the command hangs silently, which is precisely the shape that shipped.
 */

import { expect } from '@playwright/test';
import { type TheiaApp } from '@theia/playwright';
import { loadOrderFlowApp, runCommand, test } from './order-flow-app.mjs';

/**
 * The command as the palette lists it — `category: label`, from
 * `bindMemoryDiagnostics({ commandIdPrefix: 'order-flow', category: 'Order Flow' })`.
 */
const DUMP_SERVER_STATE = 'Order Flow: Dump Server State';

test.describe('Order-flow memory diagnostics in Theia', () => {
   let app: TheiaApp;

   test.beforeAll(async ({ playwright, browser }) => {
      app = await loadOrderFlowApp({ playwright, browser });
   });

   test.afterAll(async () => {
      await app.page.close();
   });

   test('a diagnostics command reaches the data head on its own service path', async () => {
      await runCommand(app, DUMP_SERVER_STATE);

      // The notification the contribution raises on SUCCESS, matched on the
      // heap figure it reports rather than on its prefix alone. The numbers come
      // from `process.memoryUsage()` in the language-server process, so a
      // message carrying them is proof the request crossed the channel, the
      // backend forwarder and the socket and came back — which a
      // "Captured server state" prefix on its own would not be.
      //
      // Waited for, not read once: a channel that was never forwarded produces
      // no notification and no error, so the failure here is a timeout. That is
      // the honest shape for this defect — a silent hang has nothing to assert
      // against except its own absence.
      //
      // `.first()` because Theia renders one notification into TWO nodes
      // carrying this class — the transient toast and the notification-centre
      // list entry — so an unqualified locator is a strict-mode violation rather
      // than a missing element, which reads like the command having failed.
      //
      // The timeout is EXPLICIT and well above the config's 15s default,
      // because this is the tier's first request to the data head and it pays
      // that head's whole cold start: the plugin host forks the language server,
      // which walks the workspace, before the port command can answer. Measured
      // against a killed backend it takes 13.4s, i.e. inside the default by 1.6s
      // — and a run immediately after a full rebuild crossed it. A margin that
      // thin is a flake that reports as this defect returning.
      await expect(app.page.locator('.theia-notification-message').filter({ hasText: 'Captured server state' }).first()).toContainText(
         /heap .* used/,
         { timeout: 60_000 }
      );
   });
});
