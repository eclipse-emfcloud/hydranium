// The smoke tier: Playwright starts the application on a copy of the starter
// workspace, since the server writes its repairs to the folder it opens, and
// drives it in Chromium, which `npm run test:e2e:install` downloads once.
// `npm start` serves what `npm run build` bundled, so build first.

import { defineConfig, devices } from '@playwright/test';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The port the smoke serves on, not `npm start`'s 3000, so a running
 * application doesn't block it; set `THEIA_PORT` to choose another.
 */
const PORT = Number(process.env.THEIA_PORT || 4938);

// Copied once, by the runner: its workers load this file again, and inherit the flag.
if (process.env.SMOKE_WORKSPACE_COPIED === undefined) {
   process.env.SMOKE_WORKSPACE_COPIED = 'true';
   const workspace = new URL('smoke-workspace', import.meta.url);
   rmSync(workspace, { recursive: true, force: true });
   cpSync(new URL('../workspace', import.meta.url), workspace, { recursive: true });
   // Settings of its own too, so a run never writes `~/.theia/settings.json`.
   process.env.THEIA_CONFIG_DIR ??= mkdtempSync(join(tmpdir(), 'theia-smoke-config-'));
}

export default defineConfig({
   testDir: './test',
   // The first request waits for the backend to start the server and build the workspace.
   timeout: 120_000,
   expect: { timeout: 60_000 },
   use: { ...devices['Desktop Chrome'], baseURL: `http://localhost:${PORT}` },
   webServer: {
      // Relative to this folder, the server's working directory.
      command: 'node start.mjs smoke-workspace',
      url: `http://localhost:${PORT}`,
      env: { THEIA_PORT: String(PORT) },
      // A server already on the port fails the run rather than being tested in this one's place.
      reuseExistingServer: false,
      timeout: 120_000
   }
});
