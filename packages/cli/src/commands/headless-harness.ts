/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import type * as HydraniumCoreNode from '@hydranium/core/node';
import type { LogThreshold } from '@hydranium/protocol';
import { spawn } from 'node:child_process';
import { statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { logLevelEnv } from '../log-level.js';
import { SERVICES_FLAG } from './harness-args.js';

/** The flag every report-producing subcommand names its destination file with. */
export const OUT_FILE_FLAG = '--out-file';

/** The `@hydranium/core/node` module surface the drivers use (type only). */
type CoreNodeModule = typeof HydraniumCoreNode;

/**
 * The zero-arg service factory a head exports for the headless harness
 * subcommands (`measure-memory`, `ast-ground-truth`). The head wires its own
 * filesystem inside.
 */
export type ServicesFactory = HydraniumCoreNode.MeasureModelMemoryOptions['createServices'];

/** What {@link loadHeadlessContext} hands a driver: the head's factory + harness. */
export interface HeadlessContext {
   /** The head's zero-arg `createServices(): { shared }` thunk. */
   createServices: ServicesFactory;
   /** `@hydranium/core/node`, resolved from the HEAD's dependency graph. */
   coreNode: CoreNodeModule;
}

/**
 * Child-side: load everything a driver needs from a head's `--services` module —
 * its `createServices` thunk AND the `@hydranium/core/node` harness, both
 * resolved from the HEAD's location rather than the CLI's.
 *
 * The module is an ESM file (typically a compiled `lib/*.js`) exporting a
 * ZERO-ARG `createServices(): { shared }`. `hydranium-cli` is language-agnostic
 * and cannot statically import a head's `create<Lang>Services`, so the dynamic
 * import is the seam that keeps the binary head-neutral. Resolving the harness
 * from the head's graph (via `createRequire` rooted at the head module) means the
 * CLI itself needs no `@hydranium/core` dependency — the head always has it — and
 * guarantees the harness runs against the SAME core copy as `createServices`.
 *
 * Throws a clear error when the path names no file, and when the export is
 * missing or not a function.
 */
export async function loadHeadlessContext(servicesModule: string): Promise<HeadlessContext> {
   const modulePath = path.resolve(servicesModule);
   // Checked before the import, not caught after it: Node's
   // ERR_MODULE_NOT_FOUND names neither the flag nor this file's role, and a
   // catch could not tell a missing --services module from a missing dependency
   // OF that module, which deserves Node's message verbatim.
   const stats = statSync(modulePath, { throwIfNoEntry: false });
   if (stats === undefined || !stats.isFile()) {
      throw new Error(
         `${SERVICES_FLAG} must name an existing ESM file; '${servicesModule}' resolved to ${modulePath}, ` +
            `which is not one. Pass the head's COMPILED entry, e.g. \`${SERVICES_FLAG} ./lib/services.js\` — ` +
            'not the TypeScript source and not a package name.'
      );
   }
   const moduleUrl = pathToFileURL(modulePath).href;
   const imported = (await import(moduleUrl)) as Record<string, unknown>;
   const createServices = imported.createServices;
   if (typeof createServices !== 'function') {
      throw new Error(
         `Services module '${servicesModule}' must export a zero-arg 'createServices(): { shared }' ` +
            `function (found ${typeof createServices}). The head wires its own filesystem inside, ` +
            'e.g. `export const createServices = () => createMyLangServices({ ...NodeFileSystem })`.'
      );
   }
   const headRequire = createRequire(moduleUrl);
   const coreNodePath = headRequire.resolve('@hydranium/core/node');
   const coreNode = (await import(pathToFileURL(coreNodePath).href)) as CoreNodeModule;
   return { createServices: createServices as ServicesFactory, coreNode };
}

/**
 * Child-side: deliver a finished report — to `outFile` when one was named, else
 * to stdout.
 *
 * The file is created only once the report EXISTS, which is what the flag buys
 * over the shell redirection it replaces: `> report.md` truncates the destination
 * before the command runs, so a head that throws while booting leaves a
 * zero-length file that a later step reads as an empty report rather than as a
 * failed run.
 */
export function emitReport(report: string, outFile: string | undefined): void {
   if (outFile === undefined) {
      console.log(report);
      return;
   }
   writeFileSync(outFile, report.endsWith('\n') ? report : `${report}\n`);
   // Progress on stderr, so a caller that also captures stdout gets a clean
   // stream rather than a note where the report used to be.
   console.error(`Wrote ${outFile}`);
}

/**
 * Parent-side: spawn `node <execArgs...>` inheriting stdio and resolve with the
 * child's exit code. The harness subcommands need a child process anyway — the
 * heads' services and a workspace build run in isolation, and `measure-memory`
 * additionally needs `--expose-gc` for post-GC readings.
 *
 * `env` is MERGED over the parent's rather than replacing it: the child resolves
 * the head's module graph, so dropping `PATH` / `NODE_OPTIONS` / the platform's
 * own variables would break the import the driver exists to perform.
 */
export function spawnNodeChild(execArgs: string[], env?: Record<string, string>): Promise<number> {
   return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, execArgs, {
         stdio: 'inherit',
         env: env === undefined ? process.env : { ...process.env, ...env }
      });
      child.on('error', reject);
      child.on('close', code => resolve(code ?? 0));
   });
}

/** How a subcommand parent reaches its driver child; the seam `__spawnForTest` replaces. */
export type SpawnDriverChild = (execArgs: string[], env?: Record<string, string>) => Promise<number>;

/** What every `--services` subcommand carries for the child it spawns, on top of its own options. */
export interface DriverSpawnOptions {
   /**
    * Log threshold for the head the driver boots. Absent leaves the child's
    * inherited environment alone, so an ambient `HYDRANIUM_LOG_LEVEL` still wins
    * where a caller set one.
    */
   readonly logLevel?: LogThreshold;
   /** Test-only: capture the node argv and env instead of spawning the real child. */
   readonly __spawnForTest?: SpawnDriverChild;
}

/**
 * Parent-side: run a subcommand's driver child and propagate its exit code, so a
 * shell or CI step sees the gate.
 *
 * **The log threshold travels in the child's ENVIRONMENT, not its argv.** The
 * head's logger reads `HYDRANIUM_LOG_LEVEL` while `createServices` constructs it,
 * which is inside the driver's dynamic import — a flag the driver parsed would
 * arrive after the only moment it can be read. Setting it here rather than
 * exporting it also leaves the CLI's own output alone, unlike an ambient
 * `HYDRANIUM_LOG_LEVEL=…` the parent would carry too.
 *
 * A head that binds a logger of its own decides for itself whether the flag means
 * anything, which is the intended seam: the CLI is language-agnostic and cannot
 * reach past `createServices`.
 */
export async function runDriverChild(execArgs: string[], options: DriverSpawnOptions): Promise<void> {
   const spawnChild = options.__spawnForTest ?? spawnNodeChild;
   const code = await spawnChild(execArgs, options.logLevel === undefined ? undefined : logLevelEnv(options.logLevel));
   if (code) {
      process.exitCode = code;
   }
}
