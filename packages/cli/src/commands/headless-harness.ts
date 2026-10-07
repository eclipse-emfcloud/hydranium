/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import type * as HydraniumCoreNode from '@hydranium/core/node';
import { spawn } from 'node:child_process';
import { statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { driverHeapArgs, type HeapReading } from '../driver-heap.js';
import { logEnv, type LogOptions } from '../log-level.js';
import { IMPORT_FLAG, SERVICES_FLAG } from './harness-args.js';

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
 * The module is an ESM file exporting a ZERO-ARG `createServices(): { shared }`:
 * a compiled `lib/*.js`, or the TypeScript source when the child was started
 * with a loader through {@link IMPORT_FLAG}. `hydranium-cli` is language-agnostic
 * and cannot statically import a head's `create<Lang>Services`, so the dynamic
 * import is the seam that keeps the binary head-neutral. Resolving the harness
 * from the head's graph (via `createRequire` rooted at the head module) rather
 * than from the CLI's guarantees it runs against the SAME core copy as
 * `createServices`, which a second copy of the module would break even where
 * both resolve.
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
            `which is not one. Pass the path of the head's entry, e.g. \`${SERVICES_FLAG} ./lib/services.js\` — ` +
            'not a package name.'
      );
   }
   const moduleUrl = pathToFileURL(modulePath).href;
   let imported: Record<string, unknown>;
   try {
      imported = (await import(moduleUrl)) as Record<string, unknown>;
   } catch (err: unknown) {
      throw withLoaderHint(err, modulePath);
   }
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

/** The codes Node fails a TypeScript entry with when no loader handled it, depending on its version. */
const UNLOADED_TYPESCRIPT_CODES: ReadonlySet<string> = new Set([
   'ERR_UNKNOWN_FILE_EXTENSION',
   'ERR_MODULE_NOT_FOUND',
   'ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX'
]);

/**
 * Append a loader hint to a TypeScript entry's import failure, unless the child
 * was started with {@link IMPORT_FLAG}, where the hint would only repeat the
 * caller's own command. Appended rather than substituted: a loader set through
 * `NODE_OPTIONS` does not show in `execArgv`, and under it the failure can be a
 * missing module that only Node's own message names.
 */
function withLoaderHint(err: unknown, modulePath: string): unknown {
   if (!(err instanceof Error) || !/\.[cm]?ts$/.test(modulePath) || !('code' in err) || typeof err.code !== 'string') {
      return err;
   }
   if (!UNLOADED_TYPESCRIPT_CODES.has(err.code) || process.execArgv.some(arg => arg.startsWith(IMPORT_FLAG))) {
      return err;
   }
   return new Error(`${err.message}\nA TypeScript head needs a loader registered with \`${IMPORT_FLAG}\`, e.g. \`${IMPORT_FLAG} tsx\`.`, {
      cause: err
   });
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

/**
 * What every `--services` subcommand carries for the child it spawns, on top of
 * its own options. The log options apply to the head the driver boots; an
 * absent one leaves the child's inherited environment alone, so an ambient
 * variable still wins where a caller set one.
 */
export interface DriverSpawnOptions extends LogOptions {
   /** Specifiers the driver child registers with Node's `--import`, in order, before it imports the head. */
   readonly imports?: readonly string[];
   /** Test-only: capture the node argv and env instead of spawning the real child. */
   readonly __spawnForTest?: SpawnDriverChild;
   /**
    * Test-only: decide the heap ceiling from a stated cgroup reading rather
    * than the machine's. Without it an argv assertion means one thing on a
    * workstation and nothing at all under a memory limit, so a suite that
    * asserts the ceiling is present passes vacuously in a container.
    */
   readonly __heapReadingForTest?: HeapReading;
}

/**
 * Parent-side: run a subcommand's driver child and propagate its exit code, so a
 * shell or CI step sees the gate.
 *
 * **The log options travel in the child's ENVIRONMENT, not its argv.** The
 * head's logger reads its `HYDRANIUM_LOG_*` variables while `createServices`
 * constructs it, which is inside the driver's dynamic import — a flag the driver
 * parsed would arrive after the only moment it can be read. Setting them here
 * rather than exporting them also leaves the CLI's own output alone, unlike
 * ambient variables the parent would carry too.
 *
 * A head that binds a logger of its own decides for itself whether the flag means
 * anything, which is the intended seam: the CLI is language-agnostic and cannot
 * reach past `createServices`.
 *
 * **The heap ceiling is prepended HERE rather than passed by each subcommand.**
 * Every caller wants the same answer to the same question, and the answer is not
 * a constant — see {@link driverHeapArgs}. A literal at the call site is a place
 * the container case can be missed, and the caller that misses it takes the whole
 * cgroup down with it rather than failing on its own.
 */
export async function runDriverChild(execArgs: string[], options: DriverSpawnOptions): Promise<void> {
   const spawnChild = options.__spawnForTest ?? spawnNodeChild;
   const importArgs = (options.imports ?? []).map(specifier => `${IMPORT_FLAG}=${loaderSpecifier(specifier)}`);
   const code = await spawnChild([...driverHeapArgs(options.__heapReadingForTest), ...importArgs, ...execArgs], logEnv(options));
   if (code) {
      process.exitCode = code;
   }
}

/**
 * A path, absolute or `./`/`../` relative with either separator, becomes a file
 * URL resolved against the caller's directory. Node reads `--import` as a URL or
 * package specifier, so it would take a Windows `C:\…` for the URL scheme `c:`
 * and a `.\…` for a package name. Any other specifier passes through as Node
 * reads it.
 */
function loaderSpecifier(specifier: string): string {
   const isPath = path.isAbsolute(specifier) || /^\.\.?[\\/]/.test(specifier);
   return isPath ? pathToFileURL(path.resolve(specifier)).href : specifier;
}
