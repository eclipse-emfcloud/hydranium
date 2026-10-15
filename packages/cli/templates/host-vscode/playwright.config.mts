// The smoke tier: each test launches the VS Code `npm run test:e2e:install`
// downloaded, with this extension loaded from `out/`, so build first. On Linux
// without a display, run it under `xvfb-run -a`.

import { defineConfig } from '@playwright/test';

export default defineConfig({
   testDir: './test',
   // The first request waits for the server to build the workspace.
   timeout: 120_000,
   expect: { timeout: 60_000 },
   // One VS Code at a time.
   workers: 1
});
