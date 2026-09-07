/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * `--version` on the BINARY, spawned as a process.
 *
 * Spawned rather than called, because the entry point runs `main()` on import:
 * importing it to test it would run the CLI inside the worker. That also makes
 * this the only tier that can see the defect the flag closes — the token used to
 * fall through to the unknown-command branch, which is a dispatch decision no
 * exported function makes.
 *
 * Requires `npm run build`; `lib/` is what the `bin` entry points at, and the
 * turbo pipeline orders `build` before `test`.
 */

import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

// `fileURLToPath`, never `URL.pathname`: on Windows the pathname of a file URL
// keeps its leading slash and reads as `/D:/…`, which `path.resolve` then takes
// as absolute-from-drive-root and prefixes the drive to, spawning
// `D:\D:\…\cli.js`. The failure names a missing module rather than a bad path.
const BINARY = fileURLToPath(new URL('../lib/cli.js', import.meta.url));
const MANIFEST_VERSION = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8')) as { version: string }).version;

describe('hydranium-cli --version', () => {
   it.each(['--version', '-V'])('%s: prints the manifest version alone on stdout and exits zero', async flag => {
      const run = await execFileAsync(process.execPath, [BINARY, flag]);

      // The whole of stdout, not a substring: a support script capturing the
      // output must get a version string, not a version inside a help page.
      expect(run.stdout.trim()).toBe(MANIFEST_VERSION);
      expect(run.stderr).toBe('');
   });

   it('is listed in the top-level help, so it is discoverable without knowing it exists', async () => {
      const run = await execFileAsync(process.execPath, [BINARY, '--help']);

      expect(run.stdout).toContain('-V, --version');
   });
});
