/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * What the properties panel does when the language server is killed underneath
 * it — the evidence that restart recovery works, and the only place it can be
 * had.
 *
 * The chain under test spans four processes: the frontend holds a Theia channel
 * to the backend forwarder, which holds a TCP socket to the data-server head
 * inside the language server, which `vscode-languageclient` restarts on crash.
 * Recovery needs three independent pieces of that chain to act on the same
 * close, and a unit test over a fake connection provider can only ever assert
 * the first: `openChannelConnection` re-opens the service path, the backend
 * forwarder re-runs its port command and reaches the replacement server's new
 * ephemeral port, and the data port reports the loss so the session stops
 * addressing the dead process. Killing the middle is what exercises all three at
 * once.
 *
 * **Runs alone, with one worker.** It kills a process by command-line pattern,
 * and Theia gives each frontend connection its own plugin host — so a second
 * spec sharing the backend would have its language server killed too. The
 * `test:e2e:restart` script enforces both.
 */

import { expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import type { TheiaApp } from '@theia/playwright';
import { loadOrderFlowApp, openPropertiesPanel, PROPERTIES_PANEL as PANEL, runCommand, selectFile, test } from './order-flow-app.mjs';

/**
 * Two diagnostics commands as the palette lists them (`category: title`), from
 * `bindMemoryDiagnostics({ commandIdPrefix: 'order-flow', category: 'Order Flow' })`.
 * Both round-trip to the data head; the spec runs one on each side of the
 * restart, for the reason the second test gives.
 */
const DUMP_SERVER_STATE = 'Order Flow: Dump Server State';
const DUMP_LATENCY = 'Order Flow: Dump RPC/LSP Latency (Server)';

/**
 * The notification a diagnostics command raises on SUCCESS, by its summary
 * prefix. The failure branch reads `Failed to dump …` and is matched separately
 * where it matters, so a thrown command is distinguishable from one that hung.
 *
 * `.first()` because Theia renders one notification into TWO nodes carrying this
 * class — the transient toast and the notification-centre entry — so an
 * unqualified locator is a strict-mode violation rather than a missing element,
 * which reads like the command having failed.
 */
function diagnosticsToast(app: TheiaApp, summary: string): ReturnType<TheiaApp['page']['locator']> {
   return app.page.locator('.theia-notification-message').filter({ hasText: summary }).first();
}

/**
 * Matches the forked language server, and nothing else on the machine.
 *
 * RESOLVED, not written out. The VS Code extension launches the server with
 * exactly this specifier, and `require.resolve` reports the realpath — so this
 * is the absolute path that appears in the child's argv, derived the same way
 * the launcher derives it. A hand-written fragment of that path instead rots
 * silently in BOTH directions, and both have happened here: after the example
 * moved one directory deeper the old fragment matched nothing, and because
 * `pgrep` exits 1 on no match and {@link languageServerPids} maps that to an
 * empty list, the spec stops testing restart recovery rather than failing. The
 * mirror image is worse, because it looks like a pass: a fragment loose enough
 * to match a leftover process from a previous layout makes the guard below
 * succeed and `pkill` kill something the test never started.
 */
const SERVER_PROCESS_PATTERN = createRequire(import.meta.url).resolve('@hydranium/example-order-flow-server/lib/main.js');

/** PIDs of the running language servers. Empty is a legitimate answer. */
function languageServerPids(): string[] {
   try {
      return execFileSync('pgrep', ['-f', SERVER_PROCESS_PATTERN], { encoding: 'utf-8' })
         .split('\n')
         .map(line => line.trim())
         .filter(line => line.length > 0);
   } catch {
      // `pgrep` exits 1 when nothing matches.
      return [];
   }
}

/**
 * Re-open the panel on `filePath`, forcing a real load.
 *
 * Selecting the document already shown is a deliberate no-op in
 * `OrderFlowPropertiesWidget.showDocument` (the diagram republishes a selection
 * on every focus change, so re-loading per selection would drop the server-side
 * watch). Going via another file is therefore required to make the panel talk to
 * the server again.
 *
 * The view is re-activated first, and that is not belt-and-braces: a diagnostics
 * command shows its output channel, which takes the same area, leaving the
 * `field-*` inputs present in the DOM but not actionable. `fill` then fails on an
 * action timeout that reads like a hung data head rather than like a covered view.
 */
async function reopenPanelOn(app: TheiaApp, filePath: string): Promise<void> {
   await openPropertiesPanel(app);
   await selectFile(app, 'orders/orders.domain');
   await selectFile(app, filePath);
}

/**
 * Prove the panel is talking to a LIVE data head, by making it fetch something it
 * cannot already have.
 *
 * Reading the field values back is not enough, and believing it cost a run:
 * `PropertiesForm` deliberately suppresses the empty render while a document
 * switch is in flight (see `setLoading` — otherwise every switch flashes "this
 * root has no editable text properties"), so a load that never resolves leaves
 * the PREVIOUS document's inputs on screen indefinitely. Against a dead
 * connection the panel therefore still shows `name=Fulfillment`, and an
 * assertion on that passes while nothing works.
 *
 * A write is the discriminator. Setting `subject` to an unresolvable name makes
 * the SERVER answer with a diagnostic naming it; that string cannot be produced
 * by stale DOM, by the client, or by a hung request. The status line is checked
 * first because it fails faster and more legibly — a hung open leaves it on
 * "Loading…" forever.
 */
async function expectLiveDataHead(app: TheiaApp, timeout: number): Promise<void> {
   await expect(app.page.locator(`${PANEL} .status`), 'the panel is still loading — the data head never answered').toHaveText('', {
      timeout
   });
   const subject = app.page.locator(`${PANEL} input#field-subject`);
   await subject.fill('Nonexistent');
   await subject.press('Enter');
   await expect(app.page.locator(`${PANEL} .diagnostics li`).first()).toContainText('Nonexistent', { timeout });
   // Put it back, so a re-run of this spec starts from the fixture's own state.
   await subject.fill('Order');
   await subject.press('Enter');
   await expect(app.page.locator(`${PANEL} .diagnostics li`)).toHaveCount(0, { timeout });
}

test.describe.serial('Order-flow data connection across a language-server restart', { tag: '@restart' }, () => {
   let app: TheiaApp;

   test.beforeAll(async ({ playwright, browser }) => {
      app = await loadOrderFlowApp({ playwright, browser });
   });

   test.afterAll(async () => {
      await app.page.close();
   });

   test('the panel reaches the data head before the restart', async () => {
      await openPropertiesPanel(app);
      await selectFile(app, 'orders/fulfillment.process');
      await expect(app.page.locator(`${PANEL} input#field-name`)).toHaveValue('Fulfillment');
      await expectLiveDataHead(app, 15_000);
      expect(languageServerPids().length, 'no language server to restart').toBeGreaterThan(0);
   });

   test('the diagnostics frontend reaches the data head before the restart', async () => {
      // The SECOND data-head consumer, and it recovers by a different route: the
      // panel's port drives `DataSession`, while `OrderFlowDiagnosticsDataService`
      // is an `AbstractDataServiceFrontend` rebinding its own proxy from
      // `onDidLoseConnection`. That is framework code whose only other coverage is
      // a unit test over a fake connection provider, which decides the question by
      // construction.
      //
      // This half is what makes the recovery assertion below mean anything.
      // Without it, a passing post-restart command is equally explained by a
      // channel that was never open before the kill and merely connected for the
      // first time afterwards — recovery untested, and the test reading as though
      // it had been.
      //
      // 60s because this is the tier's first diagnostics request and pays the
      // head's whole cold start; measured at 13.4s against a 15s default.
      test.setTimeout(120_000);
      await runCommand(app, DUMP_SERVER_STATE);
      await expect(diagnosticsToast(app, 'Captured server state')).toContainText(/heap .* used/, { timeout: 60_000 });
   });

   test('the language server is killed and comes back', async () => {
      const before = languageServerPids();
      execFileSync('pkill', ['-f', SERVER_PROCESS_PATTERN]);

      // `vscode-languageclient` restarts a crashed server, so what proves the
      // restart is a DIFFERENT pid — not merely a pid existing, which the old
      // process satisfies for as long as it takes to die. Polled rather than
      // slept on: the restart backoff is not a fixed interval.
      await expect
         .poll(() => languageServerPids().filter(pid => !before.includes(pid)).length, {
            message: 'the language server did not restart under a new pid',
            timeout: 60_000
         })
         .toBeGreaterThan(0);
   });

   test('the panel recovers on the replacement connection', async () => {
      // The whole point of the spec, and the only place the recovery chain is
      // observable end to end: `openChannelConnection` sees the sub-channel close
      // and re-opens the path, the backend forwarder re-runs its port command and
      // finds the replacement server's new ephemeral port, and the port reports
      // the loss so `DataSession` drops the generation that still addressed the
      // dead process. Any one of those missing leaves the panel on "Loading…"
      // exactly as it did before, so this passing is what says all three ran.
      //
      // The window is generous rather than tight: the restart itself takes
      // ~300ms, but the replacement server pays a cold workspace walk and the
      // first request behind it has been measured at over 12s on a cold build.
      test.setTimeout(120_000);
      await reopenPanelOn(app, 'orders/fulfillment.process');
      await expectLiveDataHead(app, 60_000);
   });

   test('the diagnostics frontend recovers on its replacement connection', async () => {
      // A DIFFERENT command from the pre-restart one, and that is the design of
      // the assertion rather than variety. Both notify through the same
      // `MessageService` and Theia keeps a delivered notification in its centre,
      // so re-running "Dump Server State" would be asserted against a locator the
      // pre-restart test had already satisfied — and would pass with the data head
      // permanently dead. "RPC/LSP latency" has never been on screen here, so only
      // a round trip to the REPLACEMENT server can put it there.
      //
      // Two assertions, because the failure this test is FOR does not look the
      // way the obvious guess says. Measured by turning the base class's
      // reconnect off: the command does not hang. `vscode-jsonrpc` refuses a
      // request on a closed connection outright, so the diagnostics contribution
      // catches it and raises `Failed to dump …` within seconds — a notification
      // that is neither the success string nor an absence, and which a
      // success-only assertion sits through for its whole timeout while calling
      // it "no answer". The `or` catches whichever arrives; the count then says
      // which, so a genuinely silent channel and a fast rejection are told apart
      // instead of both reading as a hang.
      test.setTimeout(120_000);
      await runCommand(app, DUMP_LATENCY);
      await expect(
         diagnosticsToast(app, 'Captured RPC/LSP latency').or(diagnosticsToast(app, 'Failed to dump RPC/LSP latency')),
         'the diagnostics frontend never answered — its channel did not recover'
      ).toBeVisible({ timeout: 60_000 });
      await expect(diagnosticsToast(app, 'Failed to dump RPC/LSP latency')).toHaveCount(0);
   });
});
