/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * The shared launch surface for the subprocess smoke suites: `node lib/main.js
 * --stdio` as a real child process, driven over the real LSP wire.
 *
 * The spawn, the handshake, the diagnostics / `window/logMessage` / stderr
 * captures, the polled port lookup and the SIGKILL-backed teardown are all
 * framework surface — `startSpawnedServer` from `@hydranium/core/testing/node`,
 * whose doc carries the transport's two traps (stdout IS the protocol channel,
 * and a publish fans out). All this module supplies is what is specific to THIS
 * example: which built entry to run, and what to call its workspace folder.
 *
 * `lib/main.js` is what this package's `order-flow-server` bin key and its
 * `start` script point at, so it is the entry a host spawns, and it is the only
 * one composing all three heads in one process — the LSP head over stdio, the
 * data head on an ephemeral socket, and the GLSP head on a second one. The
 * package's other bin key, `order-flow-data-server`, points at
 * `lib/data-server-main.js`, a single-head entry. Each smoke suite beside this
 * file drives one of those transports and the cross-head suite crosses two.
 */

import {
   SPAWNED_SERVER_HOOK_TIMEOUT_MS,
   startSpawnedServer,
   type SpawnedServer,
   type SpawnedServerOptions
} from '@hydranium/core/testing/node';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * The compiled three-head entry. Pointed at `lib/` rather than `src/` on
 * purpose: what is under test is the artefact an adopter ships, which
 * `turbo run test`'s `dependsOn: ["build"]` guarantees exists.
 */
export const SERVER_BIN = path.resolve(HERE, '../../lib/main.js');

/**
 * Budget for a `beforeAll` / `afterAll` that boots or tears down the child. The
 * framework's own boot bound is deliberately shorter, so a child that never
 * completes the handshake fails with its named error rather than as an
 * anonymous hook timeout.
 */
export const SPAWN_TIMEOUT_MS = SPAWNED_SERVER_HOOK_TIMEOUT_MS;

/** A spawned `lib/main.js`, initialized and ready to drive. */
export type SpawnedOrderFlowServer = SpawnedServer;

/**
 * Spawn `lib/main.js --stdio` and complete the `initialize` / `initialized`
 * handshake.
 *
 * `workspaceRoot` is an absolute directory the child indexes as its single
 * workspace folder. Every suite passes a **throwaway copy** of the sample
 * workspace: the initial build runs the integrity rules, whose default silent
 * mode persists repairs through `FileSystemProvider.writeFile`, so booting a
 * child over the committed workspace would let it rewrite the fixture.
 */
export function startSpawnedOrderFlowServer(options: Omit<SpawnedServerOptions, 'serverModule'> = {}): Promise<SpawnedOrderFlowServer> {
   return startSpawnedServer({ serverModule: SERVER_BIN, workspaceFolderName: 'order-flow', ...options });
}
