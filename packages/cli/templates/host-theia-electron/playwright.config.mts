// The smoke tier: the test launches the application in Electron itself, so
// there is no server to start here. It runs what `npm run build` bundled, so
// build first.

import { defineConfig } from '@playwright/test';

export default defineConfig({
   testDir: './test',
   // The first window waits for the backend to start the server and build the workspace.
   timeout: 120_000,
   expect: { timeout: 60_000 }
});
