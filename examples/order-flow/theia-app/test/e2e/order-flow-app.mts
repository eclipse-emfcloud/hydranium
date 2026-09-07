/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * Shared harness for the order-flow Theia e2e specs: the `test` object every
 * spec imports (server-log capture already composed in) and the app loader that
 * arms it.
 *
 * Importing `test` from here rather than from `@playwright/test` is what makes a
 * failure self-describing — see {@link test}.
 */

import { forwardBrowserConsole, serverLogFixtures, type ServerLogFixtures } from '@hydranium/core/testing/playwright';
import { expect, test as base, type Browser, type PlaywrightWorkerArgs } from '@playwright/test';
import { type TheiaApp, TheiaAppLoader, TheiaExplorerView, TheiaView, TheiaWorkspace } from '@theia/playwright';
import * as path from 'node:path';

/**
 * The checked-in fixture workspace, copied per suite rather than opened in place.
 *
 * `TheiaWorkspace` copies these paths into a fresh `mkdtemp` directory and Theia
 * opens THAT, so a spec that edits a model file — which the properties spec does
 * — cannot dirty the repository. Driving the same flows by hand does dirty it,
 * which is why `git status` after a manual run is a habit worth keeping and is
 * not needed here.
 */
const WORKSPACE_SOURCE = path.resolve(import.meta.dirname, '..', '..', '..', 'workspace');

/**
 * Workspace path of the app the current spec loaded, for the server-log fixture.
 *
 * Module-scoped rather than passed, because of a shape mismatch the framework
 * fixture documents: `serverLogWorkspace` has to be readable by a per-test
 * fixture, while these suites deliberately load ONE app in `beforeAll` (loading
 * Theia per test would multiply a ~5s startup across every assertion, and the
 * diagram spec's later tests observe state its earlier tests produced). A
 * `beforeAll` app lives in the spec's closure, which a fixture cannot reach — so
 * the loader publishes it here instead. Playwright creates test-scoped fixtures
 * after `beforeAll` has run, so this is always set by the time the fixture reads
 * it.
 */
let activeWorkspacePath = '';

/**
 * The framework's auto fixture set plus the internal side-effect fixture it
 * registers. `serverLogCapture` is declared only so the spread below type-checks
 * against the parameter list — `@hydranium/core/testing/playwright` keeps its own
 * equivalent interface internal.
 */
interface OrderFlowFixtures extends ServerLogFixtures {
   /** Internal auto fixture from `serverLogFixtures`: marks on setup, attaches on teardown. */
   serverLogCapture: void;
}

/**
 * Use this in place of `@playwright/test`'s `test`.
 *
 * It composes the framework's `serverLogFixtures`, which writes a
 * `===== START: <title> =====` marker into the language server's log before each
 * test and **attaches that log to the test on failure**. Everything these specs
 * exercise crosses at least three processes, and every interesting failure so far
 * has been a hop that went quiet rather than one that threw — so a Playwright
 * report that carries only "expected visible, got hidden" costs a whole re-run to
 * localise. With this, the first failure already has the server side of the story
 * attached, next to the trace and the screenshot.
 *
 * The browser console is captured too, as a separate `<token>.browser.log`, by
 * {@link loadOrderFlowApp}.
 */
export const test = base.extend<OrderFlowFixtures>({
   ...serverLogFixtures,
   // The empty pattern is Playwright's own signature for a fixture that depends
   // on no other fixture — Playwright reads the destructured names to build the
   // dependency graph, so naming anything here would REQUEST it.
   // eslint-disable-next-line no-empty-pattern
   serverLogWorkspace: async ({}, use) => {
      await use(activeWorkspacePath);
   }
});

/**
 * Boot Theia on a private copy of the fixture workspace and arm both log
 * captures.
 *
 * Call from a spec's `beforeAll`. The returned app is the spec's own; the
 * workspace path it publishes is what the server-log fixture attaches on
 * failure.
 */
export async function loadOrderFlowApp(args: PlaywrightWorkerArgs & { browser: Browser }): Promise<TheiaApp> {
   const workspace = new TheiaWorkspace([WORKSPACE_SOURCE]);
   const app = await TheiaAppLoader.load(args, workspace);
   activeWorkspacePath = app.workspace.path;
   forwardBrowserConsole(app.page, activeWorkspacePath);
   return app;
}

/** Class the properties widget puts on its own node; the panel's DOM root. */
export const PROPERTIES_PANEL = '.order-flow-properties';

/** Theia's Properties view, which has no page object in `@theia/playwright`. */
class TheiaPropertyView extends TheiaView {
   constructor(app: TheiaApp) {
      super(
         {
            tabSelector: '#shell-tab-property-view',
            viewSelector: '#property-view',
            // Must match `PropertyViewWidget.LABEL`: the view is reached through
            // "View: Open View..." by this exact name.
            viewName: 'Properties'
         },
         app
      );
   }

   /**
    * Open the view through the palette, narrowing BOTH quick picks.
    *
    * `TheiaView.open` narrows only the first. It types `View: Open View`, then
    * calls `trigger('View: Open View...', viewName)` — and `trigger`'s second
    * argument walks the view list that the command puts up, unfiltered, by
    * `ArrowDown` to an exact text match. That walk has no exit condition
    * (`selectedCommand` may return `null`, whose `innerText` is `undefined` and
    * never matches), so a view whose row text differs by so much as an icon
    * hangs the spec to its timeout instead of failing on the name.
    *
    * Only the FIRST call per spec reaches this at all — `TheiaApp.openView`
    * activates an existing tab instead — which is exactly why it was worth
    * replacing rather than tolerating: a once-per-spec path that fails as a
    * timeout is one nobody attributes correctly.
    */
   override async open(): Promise<TheiaView> {
      await this.app.quickCommandPalette.open();
      await pickQuickInputItem(this.app, 'View: Open View', 'View: Open View...');
      // Accepting the command swaps the list for the view picker in the same
      // widget, so this narrows the second list rather than reopening anything.
      await pickQuickInputItem(this.app, this.data.viewName!);
      await this.waitForVisible();
      return this;
   }
}

/**
 * Explorer with a REPLACING selection, which the shipped page object does not have.
 *
 * `TheiaExplorerView.selectTreeNode` clicks with Ctrl held, so each call ADDS to
 * the tree's selection rather than replacing it. The properties panel reads
 * `selection[0]` (Theia's own `ResourcePropertyDataService` reads it the same
 * way), so a second selection left the panel showing the FIRST file and a test
 * read a stale document. It failed loudly only because two documents happened to
 * have different field sets; between two `.process` files it would have passed
 * while observing the wrong one.
 */
class OrderFlowExplorerView extends TheiaExplorerView {
   /**
    * Select `filePath` and nothing else.
    *
    * The `fileStatNode` call is load-bearing rather than a readability nicety:
    * neither it nor the click expands parents on its own, and walking the
    * segments is what opens `orders/` on the way down.
    */
   async selectOnlyTreeNode(filePath: string): Promise<void> {
      await this.activate();
      await this.waitForVisibleFileNodes();
      await this.fileStatNode(filePath);
      const selector = this.treeNodeSelector(filePath);
      await (await this.page.waitForSelector(selector)).click();
      await this.page.waitForSelector(`${selector}.theia-mod-selected`);
   }
}

/**
 * Mount the properties panel.
 *
 * Required before any `PROPERTIES_PANEL` assertion: the widget lives inside
 * Theia's Properties view, so with that view closed the panel's node does not
 * exist and every locator reports "element(s) not found" — which reads as a
 * broken data connection rather than as a closed view.
 */
export async function openPropertiesPanel(app: TheiaApp): Promise<void> {
   await app.openView(TheiaPropertyView);
}

/** Select exactly `filePath` in the Explorer, replacing any previous selection. */
export async function selectFile(app: TheiaApp, filePath: string): Promise<void> {
   const explorer = await app.openView(OrderFlowExplorerView);
   await explorer.selectOnlyTreeNode(filePath);
}

/**
 * Run the command whose palette entry reads exactly `label` (`category: title`).
 *
 * Use this rather than `app.quickCommandPalette.trigger(label)`, which is not
 * safe to run twice in one spec. That helper types NO filter: it opens the
 * palette on the full command list and presses `ArrowDown` until the focused
 * row's text matches, with no exit condition — and Theia orders that list by
 * RECENTLY USED, so the walk's path depends on which commands the spec already
 * ran. It also leaves its own `open()` un-awaited and pays a flat 5s probe
 * deciding whether the palette is already open.
 *
 * Typing the label filters the list instead of walking it, which removes the
 * order dependence. The focused row is then asserted BEFORE `Enter`: quick-pick
 * matching is fuzzy, so without it a near-miss silently runs a different command
 * and the failure surfaces somewhere else entirely.
 */
export async function runCommand(app: TheiaApp, label: string): Promise<void> {
   await app.quickCommandPalette.open();
   await pickQuickInputItem(app, label);
   // The palette closing is what says the command was accepted rather than the
   // Enter landing on a still-filtering list.
   await expect(app.page.locator(QUICK_INPUT)).toBeHidden();
}

/** Theia's quick input — the command palette and every quick pick after it. */
const QUICK_INPUT = '.quick-input-widget';

/**
 * Narrow the ALREADY-OPEN quick input to `filter`, check the focused row reads
 * `expected`, and accept it.
 *
 * Split out because a quick pick can chain: accepting an item may replace the
 * list rather than close the widget, and the second list needs narrowing on the
 * same terms as the first. `filter` and `expected` are separate because they
 * routinely differ — a trailing `...` in a command's label does not fuzzy-match
 * itself, which is why upstream types `View: Open View` to reach
 * `View: Open View...`.
 */
async function pickQuickInputItem(app: TheiaApp, filter: string, expected = filter): Promise<void> {
   await app.quickCommandPalette.type(filter);
   const focused = app.page.locator(`${QUICK_INPUT} .monaco-list-row.focused .monaco-highlighted-label`);
   await expect(focused).toHaveText(expected);
   await app.page.keyboard.press('Enter');
}
