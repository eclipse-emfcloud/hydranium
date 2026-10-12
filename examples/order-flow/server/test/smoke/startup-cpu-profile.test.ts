/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * The built three-head entry, spawned with `HYDRANIUM_CPU_PROFILE_FILE` set and
 * ended the way a language client ends it, over LSP `shutdown` / `exit`. Only a
 * real entry shows that a head gets the profile without wiring anything, and
 * that the file is named by the workspace the head initialized.
 */

import { toLogFileWorkspaceToken } from '@hydranium/core';
import { type ScratchWorkspace, makeScratchWorkspace } from '@hydranium/core/testing/node';
import { DEFAULT_CPU_PROFILE_FILE_ENV } from '@hydranium/protocol';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WORKSPACE_ROOT } from '../order-flow-harness.js';
import { SPAWN_TIMEOUT_MS, startSpawnedOrderFlowServer } from './spawned-order-flow-server.js';

let workspace: ScratchWorkspace | undefined;
let output: ScratchWorkspace | undefined;

afterEach(() => {
   workspace?.dispose();
   output?.dispose();
   workspace = undefined;
   output = undefined;
});

describe('order-flow startup CPU profile', () => {
   it(
      'writes a parseable profile named by the workspace when the client ends the head over LSP',
      async () => {
         workspace = makeScratchWorkspace({ seed: WORKSPACE_ROOT, prefix: 'order-flow-cpu-profile-ws-' });
         output = makeScratchWorkspace({ prefix: 'order-flow-cpu-profile-out-' });
         const server = await startSpawnedOrderFlowServer({
            workspaceRoot: workspace.root,
            env: { [DEFAULT_CPU_PROFILE_FILE_ENV]: path.join(output.root, '{workspace}.cpuprofile') }
         });

         const exitCode = await server.dispose();

         expect(exitCode, server.stderr()).toBe(0);
         const file = path.join(output.root, `${toLogFileWorkspaceToken(workspace.root)}.cpuprofile`);
         expect(existsSync(file), `no profile at ${file}; the directory holds: ${readdirSync(output.root).join(', ') || '(nothing)'}`).toBe(
            true
         );
         const profile: unknown = JSON.parse(readFileSync(file, 'utf8'));
         expect(profile).toMatchObject({ nodes: expect.any(Array), samples: expect.any(Array) });
      },
      SPAWN_TIMEOUT_MS
   );
});
