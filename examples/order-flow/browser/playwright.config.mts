/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * Playwright configuration for the order-flow browser app.
 *
 * The `webServer` block boots the package's own static server before the suite
 * runs. The build is intentionally NOT chained in — `npm run test:e2e` expects
 * `out/` to exist, as the Theia app's tier expects its `lib/`.
 *
 * **There is no server-log capture here, unlike the Theia app's tier, and its
 * absence is not an oversight.** That tier captures a language-server process's
 * log because the failure it fears is a stalled multi-process handshake. Here the
 * language server is IN the browser: its logs travel to the page over the LSP
 * channel, and the worker's own failures are posted back on the global channel by
 * `order-flow-worker.ts`. Both land in the browser console, so the console is the
 * log — which is why the spec asserts on it directly.
 *
 * **`reuseExistingServer` is on outside CI, and unlike the Theia tier that is
 * harmless.** This server is stateless and holds no warm backend: every reload
 * builds a new worker and a new Langium store, so a reused server cannot hide a
 * cold-start bug. What it CAN hide is a stale bundle, which is why `out/` is a
 * build input rather than something this config regenerates.
 */

import { defineConfig, devices } from '@playwright/test';

/** Must match `scripts/serve.mjs`'s default port. */
const PORT = 3002;

export default defineConfig({
   testDir: './test/e2e',
   /*
    * Sized against what a GREEN run actually costs, not against the worst case.
    *
    * Measured, every spec here settles in 2-4s: the slow part is one worker
    * parsing three grammars and building a workspace, and it happens once per
    * page load. Generous timeouts do not make a passing run slower — they make a
    * FAILING one cost thirty times what it should, and a suite whose failures take
    * six minutes to report is one nobody runs while iterating.
    *
    * The floor is the first load, so `expect` keeps enough room for it on a cold
    * or loaded machine; the test timeout is a backstop for a hang, not a budget.
    */
   timeout: 30_000,
   expect: { timeout: 10_000 },
   retries: process.env.CI ? 1 : 0,
   // JUnit beside the HTML one under CI, and it is not redundant with it: the
   // HTML report is for a human opening an artefact, while the XML carries a
   // per-case duration the vitest tiers already emit to the same
   // `test-results/junit.xml` path. Without it the e2e specs — the slowest and
   // most timing-sensitive things in the suite — are the ONLY ones absent from
   // any "what is closest to its timeout" question.
   reporter: [
      ['list'],
      ...(process.env.CI
         ? ([
              // Playwright's own GitHub reporter, which annotates a failure on
              // the diff. It is the only one of the three a reader sees WITHOUT
              // downloading something, and it needs no workflow permission.
              ['github'],
              ['html', { open: 'never' }],
              ['junit', { outputFile: 'test-results/junit.xml' }]
           ] as const)
         : [])
   ],
   use: {
      baseURL: `http://localhost:${PORT}`,
      trace: 'retain-on-failure',
      screenshot: 'only-on-failure'
   },
   projects: [
      {
         name: 'chromium',
         // A real Chromium, and headless still counts: `document.visibilityState`
         // is `visible` in headless, so `requestAnimationFrame` fires and
         // sprotty's render loop runs. A HIDDEN tab is what does not work — see
         // the spec — and that is why this tier exists instead of driving a tab
         // in whatever browser happens to be open.
         //
         // **The viewport goes AFTER the device spread and inside the PROJECT,
         // which is the only place it takes effect.** A project's `use` replaces
         // the top-level one key by key, and `devices['Desktop Chrome']` carries
         // a `viewport` of its own — so the same setting written at the top level
         // is silently overridden, and the suite runs at 1280x720 while the
         // config says otherwise.
         //
         // A WORKBENCH size rather than the device default, because the page is a
         // sidebar, a diagram, three editors and a dock: at 720px tall the
         // diagram mount is 178px, so a drag of the size a reader makes leaves
         // the canvas and is consumed as nothing, and at 303px wide an editor
         // puts the last token of a line under Monaco's own overview ruler, where
         // no pointer can reach it. Both were measured. A suite run at a size no
         // reader would use tests the cramping rather than the behaviour.
         use: { ...devices['Desktop Chrome'], viewport: { width: 1600, height: 1000 } }
      }
   ],
   webServer: {
      command: 'npm start',
      url: `http://localhost:${PORT}`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      stdout: 'pipe',
      stderr: 'pipe'
   }
});
