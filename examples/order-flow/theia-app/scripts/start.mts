/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

// `npm start`: the Theia backend on `THEIA_PORT`, 3001 when it is unset.
//
// A script rather than `--port=${THEIA_PORT:-3001}` in package.json: only a
// POSIX shell expands that, and `npm start` also runs under cmd.exe.

import { spawn } from 'node:child_process';

const port = Number(process.env.THEIA_PORT ?? 3001);
const theia = spawn(`theia start --plugins=local-dir:./plugins --hostname=0.0.0.0 --port=${port} ../workspace`, {
   stdio: 'inherit',
   shell: true
});
theia.on('exit', code => process.exit(code ?? 1));
