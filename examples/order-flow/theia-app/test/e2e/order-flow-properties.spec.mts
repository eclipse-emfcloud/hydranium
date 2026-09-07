/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * Theia end-to-end for the order-flow properties panel.
 *
 * Exercises the data head through the deployment path a Theia product actually
 * uses: the servers-only VS Code extension forks the language server via
 * `@theia/plugin-ext`, the Theia backend forwards a socket to the data-server
 * head, and `OrderFlowPropertiesWidget` renders the transfer root inside Theia's
 * own Properties view. Nothing here touches the diagram — that is the diagram
 * spec beside it, and keeping the two apart means a diagram failure cannot take
 * the panel's assertions down with it.
 *
 * The assertions worth having are the write ones, which observe the SERVER's
 * verdict rather than the panel's echo of what was typed into it. The strongest
 * is cross-document and cross-grammar: renaming `fulfillment.process`'s root
 * breaks `fulfillment.layout`'s `for Fulfillment` reference, so a diagnostic
 * appearing on the LAYOUT proves the write reached the shared Langium workspace
 * and triggered a real dependent rebuild.
 */

import { expect } from '@playwright/test';
import type { TheiaApp } from '@theia/playwright';
import { loadOrderFlowApp, openPropertiesPanel, PROPERTIES_PANEL as PANEL, selectFile, test } from './order-flow-app.mjs';

/**
 * Write `value` into the panel's `fieldName` input and commit it.
 *
 * `Enter` rather than a blur, because the input commits on `change` (the form
 * writes the WHOLE transfer root per edit, so per-keystroke writes would reparse
 * the file on every character) and `fill` alone does not fire it.
 */
async function setField(app: TheiaApp, fieldName: string, value: string): Promise<void> {
   const input = app.page.locator(`${PANEL} input#field-${fieldName}`);
   await input.fill(value);
   await input.press('Enter');
}

/**
 * Serial, because these tests share one Theia app AND build on each other: the
 * rename test leaves the workspace edited and the revert test puts it back. A
 * retry re-runs `beforeAll` but not preceding tests, so without serial mode a
 * retried revert would run against a workspace nobody had renamed and pass for
 * the wrong reason.
 */
test.describe.serial('Order-flow properties panel in Theia', () => {
   let app: TheiaApp;

   test.beforeAll(async ({ playwright, browser }) => {
      app = await loadOrderFlowApp({ playwright, browser });
   });

   test.afterAll(async () => {
      await app.page.close();
   });

   test('the Theia shell is initialised', async () => {
      expect(await app.isMainContentPanelVisible()).toBe(true);
   });

   test("selecting a .process file shows its root's editable fields", async () => {
      await openPropertiesPanel(app);
      await selectFile(app, 'orders/fulfillment.process');

      // `name` and `subject` are the ProcessModel root's only string-valued own
      // properties, and the panel derives its fields from exactly that — so this
      // also pins that `subject` arrives in TRANSFER form (the reference's text)
      // rather than as an AST reference object.
      await expect(app.page.locator(`${PANEL} h1`)).toHaveText('fulfillment.process');
      // The FIRST field carries an explicit timeout above the config's 15s
      // default, and only the first: it is this spec's first request to the data
      // head, so it pays that head's entire cold start — the plugin host forks
      // the language server, which walks the workspace, before the port command
      // can answer. Measured cold it takes 12.2s, inside the default by under
      // three seconds, and a run immediately after a full rebuild crossed it.
      // The `h1` above is no protection: it renders from the SELECTION alone and
      // resolves long before the head does, which is what makes a failure here
      // read as the panel being broken rather than as a race.
      await expect(app.page.locator(`${PANEL} input#field-name`)).toHaveValue('Fulfillment', { timeout: 60_000 });
      await expect(app.page.locator(`${PANEL} input#field-subject`)).toHaveValue('Order');
   });

   test('a .domain root reports that it has no editable text properties', async () => {
      // Not a degenerate case worth skipping: `DomainModel` has only
      // `declarations` and `project`, neither a string, and the form has to draw
      // that rather than leave the previous document's inputs on screen. The
      // panel claiming the file at all is the other half — `.domain` is
      // LSP-primary and has no diagram, so this is the only surface it has.
      await selectFile(app, 'orders/orders.domain');
      await expect(app.page.locator(PANEL)).toContainText('This document root has no editable text properties.');
      await expect(app.page.locator(`${PANEL} input#field-name`)).toHaveCount(0);
   });

   test('writing an unresolvable reference is accepted and the server reports it', async () => {
      // The strongest end-to-end assertion available to this panel, and the one
      // the form's own doc describes: the transfer form of a reference IS its
      // text, so the server accepts `subject = Nonexistent` and answers with a
      // diagnostic rather than rejecting the write. That diagnostic can only have
      // come from a real parse + link + validate of the edited document, so it
      // proves the whole open → write → rebuild → publish loop — unlike reading
      // back the input, which would only prove the DOM echoed what was typed.
      await selectFile(app, 'orders/fulfillment.process');
      await expect(app.page.locator(`${PANEL} input#field-subject`)).toHaveValue('Order');
      await setField(app, 'subject', 'Nonexistent');

      const diagnostics = app.page.locator(`${PANEL} .diagnostics li`);
      await expect(diagnostics.first()).toContainText('Nonexistent');
      await expect(diagnostics.first()).toContainText('error');
   });

   test('repairing the reference clears the diagnostic', async () => {
      await setField(app, 'subject', 'Order');
      // An ABSENCE, so it proves nothing until the rebuild it is waiting on has
      // had time to land. `toHaveCount(0)` retries for the whole `expect`
      // timeout, which is what makes it a wait rather than a snapshot — a bare
      // `expect(await locator.count()).toBe(0)` would read the DOM once, on the
      // line after the write, and pass while the old diagnostic was still on
      // screen about to be cleared.
      await expect(app.page.locator(`${PANEL} .diagnostics li`)).toHaveCount(0);
      await expect(app.page.locator(`${PANEL} input#field-subject`)).toHaveValue('Order');
   });

   test('renaming the process root breaks the dependent .layout file', async () => {
      // Cross-document AND cross-grammar. Nothing about the `.layout` file is
      // touched here — renaming the process root is what invalidates its
      // `for Fulfillment` reference — so a diagnostic on the layout can only come
      // from a real dependent rebuild in the shared Langium workspace.
      //
      // This assertion depends on the panel's open settling at `Validated`: the
      // layout is merely SELECTED, never edited, so a read that returned at an
      // earlier build landmark would answer before validation had run and show
      // the document as clean.
      await selectFile(app, 'orders/fulfillment.process');
      await expect(app.page.locator(`${PANEL} input#field-name`)).toHaveValue('Fulfillment');
      await setField(app, 'name', 'Fulfilment');

      await selectFile(app, 'orders/fulfillment.layout');
      await expect(app.page.locator(`${PANEL} input#field-process`)).toHaveValue('Fulfillment');
      const diagnostics = app.page.locator(`${PANEL} .diagnostics li`);
      await expect(diagnostics.first()).toContainText('Fulfillment');
      await expect(diagnostics.first()).toContainText('error');
   });

   test('reverting the rename clears the dependent diagnostic', async () => {
      await selectFile(app, 'orders/fulfillment.process');
      await expect(app.page.locator(`${PANEL} input#field-name`)).toHaveValue('Fulfilment');
      await setField(app, 'name', 'Fulfillment');

      // Selecting the layout re-reads it at validation, so this is a genuine
      // re-check rather than a wait for a push that may never come.
      await selectFile(app, 'orders/fulfillment.layout');
      await expect(app.page.locator(`${PANEL} .diagnostics li`)).toHaveCount(0);
   });
});
