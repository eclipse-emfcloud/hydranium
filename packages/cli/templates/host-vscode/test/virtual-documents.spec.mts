import { test } from '@playwright/test';
import { runTests } from '@vscode/test-electron';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VSCODE_CACHE, VSCODE_VERSION } from './vscode-version.mts';

test('serves virtual documents without synchronizing their text', async () => {
   const scratch = mkdtempSync(join(tmpdir(), 'virtual-host-'));
   try {
      await runTests({
         version: VSCODE_VERSION,
         cachePath: VSCODE_CACHE,
         extensionDevelopmentPath: fileURLToPath(new URL('..', import.meta.url)),
         extensionTestsPath: fileURLToPath(new URL('./virtual-documents.cjs', import.meta.url)),
         launchArgs: [
            '--no-sandbox',
            '--disable-extensions',
            '--disable-workspace-trust',
            `--user-data-dir=${join(scratch, 'profile')}`,
            `--extensions-dir=${join(scratch, 'extensions')}`
         ]
      });
   } finally {
      rmSync(scratch, { recursive: true, force: true });
   }
});
