/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { appendFileSync, existsSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_LOG_FILE_ENV, DEFAULT_LOG_LEVEL_ENV } from '@hydranium/protocol';
import { toLogFileWorkspaceToken } from '../../langium/diagnostics/log-file-token.js';

/**
 * Default env var naming the per-test server-log capture directory. Its presence
 * is the opt-in: set it to a directory to enable capture, leave it unset for a
 * normal (no-capture) run. Read by both {@link captureServerLog} and
 * {@link attachServerLog}.
 */
export const DEFAULT_SERVER_LOG_DIR_ENV = 'HYDRANIUM_SERVER_LOG_DIR';
/**
 * Default env var providing a central {@link AttachServerLogOptions.attachOn}
 * policy (`'failure' | 'always' | 'never'`) for a whole run, so a debugging
 * session can flip it once on the CLI without touching any spec. An explicit
 * `attachOn` option still wins; an unset/invalid value falls back to `'failure'`.
 */
export const DEFAULT_SERVER_LOG_ATTACH_ENV = 'HYDRANIUM_SERVER_LOG_ATTACH';
/**
 * Default env var naming which browser console levels {@link forwardBrowserConsole}
 * forwards — a comma-separated list (e.g. `error,warning,info`). Lets a run widen or
 * narrow the forwarded set without touching the spec. An explicit `levels` option
 * wins; an unset value falls back to {@link DEFAULT_BROWSER_LOG_LEVELS}.
 */
export const DEFAULT_BROWSER_LOG_LEVELS_ENV = 'HYDRANIUM_BROWSER_LOG_LEVELS';

/** Console levels {@link forwardBrowserConsole} forwards by default — errors + warnings only (tiny volume). */
export const DEFAULT_BROWSER_LOG_LEVELS: readonly string[] = ['error', 'warning'];

/** Valid {@link AttachServerLogOptions.attachOn} values. */
export type ServerLogAttachOn = 'failure' | 'always' | 'never';

function parseAttachOn(value: string | undefined): ServerLogAttachOn | undefined {
   return value === 'failure' || value === 'always' || value === 'never' ? value : undefined;
}

/** Parse a comma-separated console-level list, or `undefined` when empty/unset. */
function parseBrowserLogLevels(value: string | undefined): readonly string[] | undefined {
   if (!value) {
      return undefined;
   }
   const levels = value
      .split(',')
      .map(level => level.trim())
      .filter(level => level.length > 0);
   return levels.length > 0 ? levels : undefined;
}

/** The `{workspace}` placeholder the file-tee expands once the workspace is known. */
const WORKSPACE_PLACEHOLDER = '{workspace}';

export interface CaptureServerLogOptions {
   /**
    * Capture directory. When omitted, read from `process.env[`{@link DEFAULT_SERVER_LOG_DIR_ENV}`]`
    * (the opt-in: capture is off — empty env — when that's unset too). When
    * given, it is published back onto that env var so the runner-side halves of
    * the capture see the same directory.
    */
   dir?: string;
   /**
    * Server log level set on `HYDRANIUM_LOG_LEVEL`. When omitted, respects a
    * pre-set `HYDRANIUM_LOG_LEVEL` env (so a run can pick the level without editing
    * the config), then falls back to `'debug'` (a capture at `'info'` is too thin).
    */
   level?: string;
}

/** A Playwright `reporter` config entry: `[modulePath, options]`. */
export type ServerLogReporterEntry = [string, ServerLogRenameReporterOptions];

export interface CaptureServerLogResult {
   /** Spread into the server process's environment (e.g. Playwright `webServer.env`). */
   env: Record<string, string>;
   /** Add to the Playwright `reporter` array to rename per-suite logs to spec names. Absent when capture is off. */
   reporter?: ServerLogReporterEntry;
}

export interface ServerLogRenameReporterOptions {
   /** Capture directory holding the `<token>.log` files + `<token>.spec` sidecars. */
   dir: string;
}

/**
 * Build the environment to inject into the server process (e.g. a Playwright
 * `webServer.env`) so it writes one per-workspace log file under the capture dir,
 * plus the reporter entry that renames those files to spec names once the run
 * ends. Returns an **empty env, and no reporter, when no dir is configured**, so a
 * normal run is untouched. The `{workspace}` token is expanded server-side once
 * the workspace is known.
 *
 * **Publishes a resolved `options.dir` onto {@link DEFAULT_SERVER_LOG_DIR_ENV} in
 * the CALLING process, and that mutation is load-bearing rather than a
 * convenience.** The returned env reaches the server child only, while
 * {@link markServerLog} / {@link attachServerLog} — the halves that write the
 * per-test boundary markers and do the attaching — run in the runner process and
 * resolve their directory from that env var, which a fixture typically calls with
 * no options at all. Passing the option without publishing it produces a captured
 * log with no markers in it and nothing attached to the failing test, which is
 * worse than capture being off. A config-time caller runs before any worker forks,
 * so the workers inherit it.
 */
export function captureServerLog(options: CaptureServerLogOptions = {}): CaptureServerLogResult {
   const dir = options.dir ?? process.env[DEFAULT_SERVER_LOG_DIR_ENV];
   if (!dir) {
      return { env: {} };
   }
   process.env[DEFAULT_SERVER_LOG_DIR_ENV] = dir;
   const env: Record<string, string> = {
      [DEFAULT_LOG_FILE_ENV]: join(dir, `${WORKSPACE_PLACEHOLDER}.log`)
   };
   env[DEFAULT_LOG_LEVEL_ENV] = options.level ?? process.env[DEFAULT_LOG_LEVEL_ENV] ?? 'debug';
   const reporterModule = fileURLToPath(new URL('./server-log-rename-reporter.js', import.meta.url));
   return { env, reporter: [reporterModule, { dir }] };
}

/**
 * Structural subset of Playwright's `TestInfo` that {@link attachServerLog}
 * uses — declared locally so this module imports nothing from `@playwright/test`
 * (an optional peer). Matches `TestInfo`'s `title` / `status` / `expectedStatus`
 * / `attach`.
 */
export interface ServerLogTestInfo {
   readonly title: string;
   readonly status?: string;
   readonly expectedStatus?: string;
   /** Absolute spec file path (Playwright `TestInfo.file`); used to name the renamed per-suite log. */
   readonly file?: string;
   attach(name: string, options: { path: string; contentType: string }): Promise<unknown>;
}

/**
 * Derive a stable, filename-safe per-suite log name from a spec's absolute path:
 * the path below the last `tests/` segment (or the basename), minus the
 * `.spec.ts(x)` suffix, with separators flattened. The server names logs by an
 * opaque workspace token; {@link renameServerLogs} uses this to rename them to
 * spec names once the run ends.
 *
 * `.mts` / `.cts` are stripped too: an ESM Playwright project names its specs
 * `.spec.mts`, and a `.ts`-only strip leaves that inside the log's file name.
 */
export function serverLogSpecName(file: string): string {
   const norm = file.replace(/\\/g, '/');
   const idx = norm.lastIndexOf('/tests/');
   const relative = idx >= 0 ? norm.slice(idx + '/tests/'.length) : norm.slice(norm.lastIndexOf('/') + 1);
   return relative.replace(/\.spec\.[cm]?tsx?$/, '').replace(/[^A-Za-z0-9._-]/g, '_');
}

/**
 * Rename each `<token>.log` (backend) and `<token>.browser.log` (forwarded
 * browser console) to the spec name recorded in its `<token>.spec` sidecar
 * (written by {@link markServerLog}), then delete the sidecar. Colliding names —
 * a spec that opened more than one workspace — get a `-2`, `-3`, … suffix. Token
 * logs without a sidecar are left untouched. Run once, after all server processes
 * have exited (e.g. a reporter's `onEnd`). Best-effort.
 */
export function renameServerLogs(dir: string): void {
   let entries: string[];
   try {
      entries = readdirSync(dir);
   } catch {
      return;
   }
   // Per suffix (`.log`, `.browser.log`) a `taken` set guards collisions, so the
   // backend and browser logs for one spec share the same friendly base name.
   const taken: Record<string, Set<string>> = { '.log': new Set(), '.browser.log': new Set() };
   const rename = (token: string, name: string, suffix: string): void => {
      const source = join(dir, `${token}${suffix}`);
      if (!existsSync(source)) {
         return;
      }
      let target = `${name}${suffix}`;
      for (let n = 2; taken[suffix].has(target) || existsSync(join(dir, target)); n++) {
         target = `${name}-${n}${suffix}`;
      }
      taken[suffix].add(target);
      try {
         renameSync(source, join(dir, target));
      } catch {
         // ignore
      }
   };
   for (const entry of entries) {
      if (!entry.endsWith('.spec')) {
         continue;
      }
      const sidecar = join(dir, entry);
      const token = entry.slice(0, -'.spec'.length);
      let name: string;
      try {
         name = readFileSync(sidecar, 'utf-8').trim();
      } catch {
         continue;
      }
      try {
         unlinkSync(sidecar);
      } catch {
         // ignore
      }
      if (!name) {
         continue;
      }
      rename(token, name, '.log');
      rename(token, name, '.browser.log');
   }
}

/**
 * Resolve the per-workspace server-log file the {@link captureServerLog} tee
 * writes for `workspacePath` — the `<token>.log` under the capture dir — or
 * `undefined` when no capture dir is configured (`options.dir` / the default env
 * var both unset). Lets a harness locate the log to fold elsewhere (e.g. the e2e
 * profiling fixture folding `server.log` into a bundle). Does NOT check the file
 * exists — it names where the tee would write.
 */
export function resolveServerLogPath(workspacePath: string, options: { dir?: string } = {}): string | undefined {
   const dir = options.dir ?? process.env[DEFAULT_SERVER_LOG_DIR_ENV];
   if (!dir) {
      return undefined;
   }
   return join(dir, `${toLogFileWorkspaceToken(workspacePath)}.log`);
}

/**
 * Resolve the per-workspace **browser-console** log file {@link forwardBrowserConsole}
 * writes for `workspacePath` — the `<token>.browser.log` under the capture dir —
 * or `undefined` when no capture dir is configured. The browser console is kept in
 * its OWN file (not interleaved into `server.log`): the two streams use different
 * clocks, so a merged order would misrepresent timing. Does NOT check the file exists.
 */
export function resolveBrowserConsoleLogPath(workspacePath: string, options: { dir?: string } = {}): string | undefined {
   const dir = options.dir ?? process.env[DEFAULT_SERVER_LOG_DIR_ENV];
   if (!dir) {
      return undefined;
   }
   return join(dir, `${toLogFileWorkspaceToken(workspacePath)}.browser.log`);
}

export interface AttachServerLogOptions {
   /**
    * Capture directory. When omitted, read from `process.env[`{@link DEFAULT_SERVER_LOG_DIR_ENV}`]`;
    * no-op when that's unset too.
    */
   dir?: string;
   /**
    * When to attach the log to the test — mirrors how `screenshot`/`trace`
    * retention works (a per-artifact policy, NOT Playwright's coarse
    * `preserveOutput`). `'failure'` attaches only on an unexpected outcome;
    * `'always'` attaches every test; `'never'` writes the boundary marker but
    * attaches nothing. When omitted, read from `process.env[`
    * {@link DEFAULT_SERVER_LOG_ATTACH_ENV}`]`, then default `'failure'`. To track
    * the suite's `preserveOutput`, pass it from `test.info().config.preserveOutput`.
    */
   attachOn?: ServerLogAttachOn;
}

/**
 * Write a start-of-test boundary marker to the workspace's (per-suite) server
 * log, so the test's lines follow it in natural reading order. Call from a
 * spec's `beforeEach` (or a fixture's setup) with the test's workspace path.
 * No-op when no capture dir is configured. Best-effort; never throws.
 */
export function markServerLog(testInfo: ServerLogTestInfo, workspacePath: string, options: AttachServerLogOptions = {}): void {
   const dir = options.dir ?? process.env[DEFAULT_SERVER_LOG_DIR_ENV];
   if (!dir) {
      return;
   }
   const token = toLogFileWorkspaceToken(workspacePath);
   try {
      appendFileSync(join(dir, `${token}.log`), `\n===== START: ${testInfo.title} =====\n`);
   } catch {
      // Best-effort marker; a failing log sink must not break the test run.
   }
   // Record token -> spec name so `renameServerLogs` can give the per-suite log a
   // friendly name after the run (the server itself only knows the workspace token).
   if (testInfo.file) {
      try {
         writeFileSync(join(dir, `${token}.spec`), serverLogSpecName(testInfo.file));
      } catch {
         // ignore
      }
   }
}

/**
 * Append a raw line to the workspace's (per-suite) server-log file — the same
 * `<token>.log` {@link markServerLog} / {@link attachServerLog} write to. Lets a
 * harness interleave its own observations (e.g. forwarded browser-console lines)
 * into the backend stream so they correlate by timestamp/order. A trailing
 * newline is added if the line lacks one.
 *
 * **No-op when no capture dir is configured** (`opts.dir` / the default env var
 * both unset), so a normal run is untouched. Best-effort; never throws.
 */
export function appendServerLog(workspacePath: string, line: string, options: { dir?: string } = {}): void {
   const dir = options.dir ?? process.env[DEFAULT_SERVER_LOG_DIR_ENV];
   if (!dir) {
      return;
   }
   const file = join(dir, `${toLogFileWorkspaceToken(workspacePath)}.log`);
   try {
      appendFileSync(file, line.endsWith('\n') ? line : `${line}\n`);
   } catch {
      // Best-effort; a failing log sink must not break the test run.
   }
}

/**
 * Structural subset of a Playwright `ConsoleMessage` — declared locally so this
 * module imports nothing from `@playwright/test` (an optional peer).
 */
export interface ConsoleMessageLike {
   type(): string;
   text(): string;
}

/**
 * Structural subset of a Playwright `Page` used by {@link forwardBrowserConsole}.
 */
export interface ConsolePageLike {
   on(event: 'console', listener: (message: ConsoleMessageLike) => void): void;
}

/**
 * Forward the browser tab's `error` / `warning` console messages into the
 * workspace's (per-suite) **browser-console** log — `<token>.browser.log`, its own
 * file BESIDE the backend `server.log`, NOT interleaved into it. The two streams
 * use different clocks (the backend logger vs the forwarder's arrival time), so a
 * merged order would misrepresent timing; keeping them separate is honest and a
 * consumer can still merge deliberately by each line's own timestamp. Playwright
 * has both page access and fs access, so no renderer→backend transport is needed.
 * Which levels are forwarded is configurable — `options.levels`, else the
 * comma-separated {@link DEFAULT_BROWSER_LOG_LEVELS_ENV} env, else
 * {@link DEFAULT_BROWSER_LOG_LEVELS} (`error` + `warning`, tiny volume; the
 * production frontend logger strips info/debug/log anyway). Each line keeps the
 * frontend logger's own timestamp (embedded in the text); a `[browser]` tag marks
 * the origin.
 *
 * Call once after the page exists (e.g. right after the Theia app starts), with
 * the test's workspace path. **No-op — and no listener attached — when no capture
 * dir is configured** (`options.dir` / the default env var both unset), so a
 * normal run is untouched. Best-effort; forwarding never throws.
 */
export function forwardBrowserConsole(
   page: ConsolePageLike,
   workspacePath: string,
   options: { dir?: string; levels?: readonly string[] } = {}
): void {
   const dir = options.dir ?? process.env[DEFAULT_SERVER_LOG_DIR_ENV];
   if (!dir) {
      return;
   }
   const levels = new Set(
      options.levels ?? parseBrowserLogLevels(process.env[DEFAULT_BROWSER_LOG_LEVELS_ENV]) ?? DEFAULT_BROWSER_LOG_LEVELS
   );
   const file = join(dir, `${toLogFileWorkspaceToken(workspacePath)}.browser.log`);
   page.on('console', message => {
      const type = message.type();
      if (!levels.has(type)) {
         return;
      }
      try {
         appendFileSync(file, `[browser] [${type}] ${message.text()}\n`);
      } catch {
         // Best-effort; a failing log sink must not break the test run.
      }
   });
}

/**
 * Per-test server-log capture, called from a spec's `afterEach` with the test's
 * workspace path:
 *
 * - appends an end-of-test **boundary marker** to the workspace's (per-suite)
 *   server log, so each test's region is delimited within the shared stream;
 * - attaches that log — and the separate browser-console log, when one exists —
 *   to the test, so it shows in the HTML report alongside the trace + screenshot.
 *   Which outcomes attach is {@link AttachServerLogOptions.attachOn}, failure-only
 *   by default.
 *
 * **No-op when no capture dir is configured** (`options.dir` and the default env
 * var both unset), so a normal run is untouched — no per-spec guard needed.
 * Markers and writes are best-effort; failures never propagate.
 */
export async function attachServerLog(
   testInfo: ServerLogTestInfo,
   workspacePath: string,
   options: AttachServerLogOptions = {}
): Promise<void> {
   const dir = options.dir ?? process.env[DEFAULT_SERVER_LOG_DIR_ENV];
   if (!dir) {
      return;
   }
   const file = join(dir, `${toLogFileWorkspaceToken(workspacePath)}.log`);
   const status = testInfo.status ?? 'unknown';
   try {
      appendFileSync(file, `\n===== END: ${testInfo.title} — ${status} =====\n`);
   } catch {
      // Best-effort marker; a failing log sink must not break the test run.
   }
   const failed = status !== (testInfo.expectedStatus ?? 'passed');
   const attachOn = options.attachOn ?? parseAttachOn(process.env[DEFAULT_SERVER_LOG_ATTACH_ENV]) ?? 'failure';
   const shouldAttach = attachOn === 'always' || (attachOn === 'failure' && failed);
   if (!shouldAttach) {
      return;
   }
   // Attach both streams: the backend server log and (when present) the separate
   // browser-console log, so a failing test carries the frontend side too.
   const attachments: { name: string; path: string }[] = [
      { name: 'server-log', path: file },
      { name: 'browser-console-log', path: join(dir, `${toLogFileWorkspaceToken(workspacePath)}.browser.log`) }
   ];
   for (const attachment of attachments) {
      if (!existsSync(attachment.path)) {
         continue;
      }
      try {
         await testInfo.attach(attachment.name, { path: attachment.path, contentType: 'text/plain' });
      } catch {
         // Attaching must not break the test run.
      }
   }
}
