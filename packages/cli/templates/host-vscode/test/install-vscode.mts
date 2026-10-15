// Downloads the pinned VS Code into `.vscode-test/`, retrying, so the smoke
// test finds it there and asks the update server nothing.

import { downloadAndUnzipVSCode } from '@vscode/test-electron';
import { setTimeout } from 'node:timers/promises';
import { VSCODE_CACHE, VSCODE_VERSION } from './vscode-version.mts';

const ATTEMPTS = 3;

for (let attempt = 1; ; attempt++) {
   try {
      await downloadAndUnzipVSCode({ version: VSCODE_VERSION, cachePath: VSCODE_CACHE });
      break;
   } catch (error: unknown) {
      if (attempt === ATTEMPTS) {
         throw error;
      }
      console.warn(`Downloading VS Code ${VSCODE_VERSION} failed, attempt ${attempt} of ${ATTEMPTS}.`, error);
      await setTimeout(attempt * 5_000);
   }
}
