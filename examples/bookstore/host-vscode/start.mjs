/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

// Starts VS Code with this extension on `../workspace`. VS Code reads a
// relative `--extensionDevelopmentPath` against its own working directory
// rather than this one, so both paths are made absolute here.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const args = [
   `--extensionDevelopmentPath=${fileURLToPath(new URL('.', import.meta.url))}`,
   fileURLToPath(new URL('../workspace', import.meta.url))
];
// On Windows `code` is a `.cmd`, which only a shell runs. The shell gets one
// command line, as Node deprecates arguments beside `shell: true`, and each
// path is quoted so the shell does not split one with a space.
const child =
   process.platform === 'win32'
      ? spawn(['code', ...args.map(arg => `"${arg}"`)].join(' '), { stdio: 'inherit', shell: true })
      : spawn('code', args, { stdio: 'inherit' });
child.on('error', error => {
   console.error(`Could not start VS Code: ${error.message}. npm start needs \`code\` on the PATH.`);
   process.exitCode = 1;
});
