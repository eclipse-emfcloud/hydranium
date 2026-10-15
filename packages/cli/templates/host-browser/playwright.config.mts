// The smoke tier: Playwright serves the page with `npm start` and drives it in
// Chromium, which `npm run test:e2e:install` downloads once. `npm start`
// bundles the page itself but not the packages it imports, so build those
// first.

import { defineConfig, devices } from '@playwright/test';

/** The port `npm start` serves on; set `PORT` to run beside another server. */
const PORT = Number(process.env.PORT ?? 4937);

export default defineConfig({
   testDir: './test',
   // The first load parses the grammar and builds the workspace in the worker.
   timeout: 60_000,
   expect: { timeout: 20_000 },
   use: { ...devices['Desktop Chrome'], baseURL: `http://localhost:${PORT}` },
   webServer: {
      command: 'npm start',
      url: `http://localhost:${PORT}`,
      // A server already on the port fails the run rather than being tested in this one's place.
      reuseExistingServer: false,
      timeout: 120_000
   }
});
