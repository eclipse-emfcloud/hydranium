/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/*
 * The opt-in e2e profiling harness — the Playwright-side assembler. A single
 * Playwright run drives the real app, so it is the one place the two dimensions
 * with no headless producer — real RPC/LSP traffic, and the renderer
 * runtime/timeline — get real input.
 *
 * The fixture brackets a scenario: start the server-side capture + the in-page
 * timeline BEFORE the body, then AFTER stop the capture (the server writes its
 * profile files into the shared session dir — local e2e shares the filesystem),
 * pull latency over RPC, bridge the browser state to disk, and assemble ONE
 * manifest indexing everything gathered. The server-RPC calls are adopter hooks
 * (only the adopter knows how to reach its model-service from the page); the
 * browser bridge + manifest assembly are framework-generic. The manifest uses the
 * shared `@hydranium/protocol` `ProfilingManifest` shape so this assembler and the
 * headless `ProfilingRun` produce the same bundle a skill reads.
 */

import {
   PROFILING_SCHEMA_VERSION,
   type BrowserRuntimeReport,
   type BrowserRuntimeSample,
   type LatencyReport,
   type ProfileCaptureOptions,
   type ProfilingArtifact,
   type ProfilingArtifactKind,
   type ProfilingManifest
} from '@hydranium/protocol';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { DEFAULT_LATENCY_ENV } from '../../node/latency-from-env.js';
import { digestAllocationProfile, digestCpuProfile, type AllocationProfile, type CpuProfile } from '../../node/profile-digest.js';
import {
   bridgeBrowserState,
   browserRuntimeDelta,
   captureBrowserHeapSnapshot,
   captureBrowserRuntimeSample,
   type CdpSession,
   type EvaluatablePage,
   startBrowserTimeline
} from './browser-capture-bridge.js';

/**
 * Env flag that opts a run into e2e profiling. Its presence (any non-empty value)
 * is the switch — {@link withE2EProfiling} is an inert pass-through when it is
 * unset, so a spec can keep the wrapper permanently and only capture on demand.
 */
export const DEFAULT_PROFILE_E2E_ENV = 'HYDRANIUM_PROFILE_E2E';

/** True when the e2e profiling env flag is set to a non-empty value. */
export function isE2EProfilingEnabled(): boolean {
   return !!process.env[DEFAULT_PROFILE_E2E_ENV];
}

/**
 * The environment a SPAWNED server needs for an e2e profiling run to have
 * anything to report — spread into the `env` of whatever launches the server
 * (Playwright's `webServer`, a `spawn`), since a child process inherits only
 * what its launcher hands it.
 *
 * {@link finishE2EProfiling} calls `hooks.getLatency()`, but the collector that
 * answers it is installed by `latencyFromEnv` in the server process and is
 * off unless `HYDRANIUM_LATENCY` is set there. Setting only the profiling flag
 * therefore yields a bundle whose `server-latency.json` is empty — a silent hole
 * rather than a failure.
 *
 * Empty off a run with profiling disabled, so an unconditional spread leaves a
 * normal run's environment untouched. An explicitly-set `HYDRANIUM_LATENCY` is
 * passed through rather than overwritten.
 */
export function e2eProfilingServerEnv(env: Record<string, string | undefined> = process.env): Record<string, string> {
   const profileFlag = env[DEFAULT_PROFILE_E2E_ENV];
   if (!profileFlag) {
      return {};
   }
   return {
      [DEFAULT_PROFILE_E2E_ENV]: profileFlag,
      [DEFAULT_LATENCY_ENV]: env[DEFAULT_LATENCY_ENV] || '1'
   };
}

/** The default capture dimensions — every sampled dimension except the heavy `heapSnapshot`. */
export const DEFAULT_E2E_DIMENSIONS: ProfileCaptureOptions = { cpu: true, allocation: true, gc: true, eventLoopDelay: true };

/**
 * The adopter-supplied bridge to its model-service RPC — only the adopter knows how
 * to reach the running head from the page (e.g. a `page.evaluate` into its frontend
 * proxy). Each call maps to a `DataServerDiagnosticsProtocol` method.
 */
export interface E2EProfilingHooks {
   /** Begin the server-side sampled capture for the given dimensions. */
   startProfiling(options: ProfileCaptureOptions): Promise<void>;
   /** Stop the capture, writing the profile artefacts into `directory` (the session dir). */
   stopProfiling(directory: string): Promise<unknown>;
   /** Return the per-method RPC/LSP latency collected during the scenario. */
   getLatency(): Promise<LatencyReport>;
}

/** Options shared by {@link startE2EProfiling} / {@link finishE2EProfiling} / {@link withE2EProfiling}. */
export interface E2EProfilingOptions {
   /** The Playwright page — bridged for the browser runtime/timeline. */
   page: EvaluatablePage;
   /** The session directory both the server (profile files) and the assembler write into. */
   sessionDir: string;
   /** Adopter hooks reaching the model-service RPC. */
   hooks: E2EProfilingHooks;
   /** Capture dimensions; defaults to {@link DEFAULT_E2E_DIMENSIONS}. */
   dimensions?: ProfileCaptureOptions;
   /**
    * A CDP session on {@link page} (`page.context().newCDPSession(page)`). When
    * given, the run grades `browser-runtime.json` up to the two-point
    * `cdp-performance` source — DOM nodes, listeners, JS heap + delta — which the
    * `page.evaluate` bridge cannot reach. Absent: the run keeps the coarser
    * `page.evaluate` runtime read (no CDP counters).
    */
   cdp?: CdpSession;
   /** Also capture a renderer heap snapshot via CDP (heavy; opt-in, like the server's `heapSnapshot`). Requires {@link cdp}. */
   browserHeapSnapshot?: boolean;
   /** The pre-scenario runtime sample from {@link startE2EProfiling}, paired against the post-scenario sample for the delta. */
   browserRuntimeBefore?: BrowserRuntimeSample;
   /** A per-workspace server.log to fold into the bundle (copied to `<session>/server.log`). */
   serverLogPath?: string;
   /** A per-workspace browser-console log to fold into the bundle (copied to `<session>/browser-console.log`). */
   browserLogPath?: string;
   /** The commit the run reflects — anchors a skill's `file:line` findings. */
   commit?: string;
   /** The workspace under test. */
   workspace?: string;
}

/** What {@link startE2EProfiling} hands back for {@link finishE2EProfiling} to pair against. */
export interface E2EProfilingStart {
   /** The pre-scenario renderer-runtime sample, when a {@link E2EProfilingOptions.cdp} session was given. */
   browserRuntimeBefore?: BrowserRuntimeSample;
}

/** Options for {@link assembleProfilingManifest}. */
export interface AssembleManifestOptions {
   /** `app` (default here — an e2e run drives the real app) vs `harness`. */
   mode?: 'harness' | 'app';
   commit?: string;
   workspace?: string;
   /** Windows the run captured, when known (the e2e path typically has none). */
   windows?: { label: string; ms: number }[];
   container?: boolean;
}

/** Map a gathered filename to its manifest artefact kind, or `undefined` to skip it. */
function artifactKind(file: string): ProfilingArtifactKind | undefined {
   if (file.endsWith('.cpuprofile')) {
      return 'server-cpu';
   }
   if (file.endsWith('.heapprofile')) {
      return 'server-alloc';
   }
   if (file.endsWith('.heapsnapshot')) {
      // The renderer snapshot (CDP) is kept distinct from the server's `server-heap`
      // so a skill knows which process it belongs to.
      return file.startsWith('browser') ? 'browser-heap' : 'server-heap';
   }
   switch (file) {
      case 'server-latency.json':
         return 'server-latency';
      case 'server.log':
         return 'server-log';
      case 'browser-console.log':
         return 'browser-console';
      case 'browser-runtime.json':
         return 'browser-runtime';
      case 'browser-timeline.json':
         return 'browser-timeline';
      case 'server-summary.json':
         return 'server-summary';
      case 'server-ast.json':
         return 'server-ast';
      case 'server-memory-report.json':
         return 'server-memory-report';
      default:
         return undefined;
   }
}

/**
 * Attach a digest pointer to a raw profile artefact: reference an existing
 * `<file>.txt` if present, else emit one beside the profile (matching the headless
 * `ProfilingRun`, so the cpu/allocation skills read the same compact digest). A
 * malformed profile leaves the raw file in the bundle as the fallback.
 */
function attachDigest(sessionDir: string, artifact: ProfilingArtifact, files: readonly string[]): void {
   const digestFile = `${artifact.path}.txt`;
   if (files.includes(digestFile)) {
      artifact.digest = digestFile;
      return;
   }
   const emit = artifact.kind === 'server-cpu' ? digestCpuProfile : artifact.kind === 'server-alloc' ? digestAllocationProfile : undefined;
   if (!emit) {
      return;
   }
   try {
      const raw: unknown = JSON.parse(readFileSync(join(sessionDir, artifact.path), 'utf8'));
      writeFileSync(join(sessionDir, digestFile), emit(raw as CpuProfile & AllocationProfile));
      artifact.digest = digestFile;
   } catch {
      // The raw profile is still in the bundle; a skill can fall back to it.
   }
}

/**
 * Scan a session directory for the gathered profiling artefacts and write a
 * `manifest.json` indexing them — the Playwright process assembles the bundle from
 * the files the fixture gathered. Returns the manifest. Ignores its own
 * `manifest.json` and loose `.txt` digests (referenced from their profile).
 */
export function assembleProfilingManifest(sessionDir: string, options: AssembleManifestOptions = {}): ProfilingManifest {
   const files = readdirSync(sessionDir);
   const artifacts: ProfilingArtifact[] = [];
   for (const file of files) {
      const kind = artifactKind(file);
      if (!kind) {
         continue;
      }
      const artifact: ProfilingArtifact = { kind, path: file };
      if (kind === 'server-cpu' || kind === 'server-alloc') {
         attachDigest(sessionDir, artifact, files);
      }
      artifacts.push(artifact);
   }
   const manifest: ProfilingManifest = {
      schemaVersion: PROFILING_SCHEMA_VERSION,
      sessionId: basename(sessionDir),
      environment: {
         mode: options.mode ?? 'app',
         container: options.container ?? false,
         commit: options.commit,
         workspace: options.workspace,
         node: process.version,
         windows: options.windows ?? []
      },
      artifacts
   };
   writeFileSync(join(sessionDir, 'manifest.json'), JSON.stringify(manifest, undefined, 2));
   return manifest;
}

/** Remove and recreate the session directory so the run starts from a clean, predictable folder. */
function emptySessionDir(sessionDir: string): void {
   rmSync(sessionDir, { recursive: true, force: true });
   mkdirSync(sessionDir, { recursive: true });
}

/**
 * Begin capture — call BEFORE the scenario body. Starts the server-side sampled
 * profile (adopter hook) and the in-page main-thread timeline, and — when a CDP
 * session is given — takes the pre-scenario renderer-runtime sample so
 * {@link finishE2EProfiling} can report the growth delta.
 */
export async function startE2EProfiling(options: E2EProfilingOptions): Promise<E2EProfilingStart> {
   // Start from an empty session dir so a reused path (the common e2e case)
   // yields exactly this run's artefacts — no ISO stamp means a prior run's
   // files would otherwise be re-indexed as duplicates by the assembler.
   emptySessionDir(options.sessionDir);
   await options.hooks.startProfiling(options.dimensions ?? DEFAULT_E2E_DIMENSIONS);
   await startBrowserTimeline(options.page);
   const browserRuntimeBefore = options.cdp ? await captureBrowserRuntimeSample(options.cdp) : undefined;
   return { browserRuntimeBefore };
}

/**
 * End capture — call AFTER the scenario body. Stops the server capture (its files
 * land in the session dir), writes `server-latency.json` from the RPC, bridges the
 * browser state to disk (`browser-timeline.json` + a single source-graded
 * `browser-runtime.json` — the richer two-point CDP read superseding the coarse
 * `page.evaluate` read when a CDP session is given), folds in `server.log` when
 * given, and assembles the manifest. Returns the manifest.
 */
export async function finishE2EProfiling(options: E2EProfilingOptions): Promise<ProfilingManifest> {
   await options.hooks.stopProfiling(options.sessionDir);
   const latency = await options.hooks.getLatency();
   writeFileSync(join(options.sessionDir, 'server-latency.json'), JSON.stringify(latency, undefined, 2));
   const state = await bridgeBrowserState(options.page, options.sessionDir);
   // One source-graded browser-runtime report: CDP (two-point counters + delta)
   // supersedes the coarse page.evaluate memory read when a session is given.
   let runtime: BrowserRuntimeReport = state.runtime;
   if (options.cdp) {
      const after = await captureBrowserRuntimeSample(options.cdp);
      // CDP exposes neither the `performance.memory` heap-limit ceiling nor the
      // precise per-type/container renderer total from `measureUserAgentSpecificMemory`;
      // fold both in from the page read so superseding with CDP does not discard the
      // signals CDP cannot produce (the limit is a static ceiling, excluded from the
      // delta by design; totalBytes/breakdown only exist under cross-origin isolation).
      if (after.jsHeapLimitBytes === undefined && state.runtime.after.jsHeapLimitBytes !== undefined) {
         after.jsHeapLimitBytes = state.runtime.after.jsHeapLimitBytes;
      }
      if (after.totalBytes === undefined && state.runtime.after.totalBytes !== undefined) {
         after.totalBytes = state.runtime.after.totalBytes;
         after.breakdown = state.runtime.after.breakdown;
      }
      const before = options.browserRuntimeBefore;
      runtime = before
         ? { source: 'cdp-performance', before, after, delta: browserRuntimeDelta(before, after) }
         : { source: 'cdp-performance', after };
      if (options.browserHeapSnapshot) {
         await captureBrowserHeapSnapshot(options.cdp, options.sessionDir);
      }
   }
   writeFileSync(join(options.sessionDir, 'browser-runtime.json'), JSON.stringify(runtime, undefined, 2));
   if (options.serverLogPath && existsSync(options.serverLogPath)) {
      copyFileSync(options.serverLogPath, join(options.sessionDir, 'server.log'));
   }
   if (options.browserLogPath && existsSync(options.browserLogPath)) {
      copyFileSync(options.browserLogPath, join(options.sessionDir, 'browser-console.log'));
   }
   return assembleProfilingManifest(options.sessionDir, { mode: 'app', commit: options.commit, workspace: options.workspace });
}

/**
 * Bracket a scenario with a full profiling capture — the one-call ergonomic. When
 * {@link isE2EProfilingEnabled} is false this is an inert pass-through (runs the
 * scenario, captures nothing, returns `undefined`), so a spec keeps the wrapper
 * permanently and profiles only when the env flag is set. The bundle is still
 * assembled if the scenario throws (a failing run is worth profiling), and the
 * scenario error is re-thrown after.
 */
export async function withE2EProfiling(
   options: E2EProfilingOptions,
   scenario: () => Promise<void>
): Promise<ProfilingManifest | undefined> {
   if (!isE2EProfilingEnabled()) {
      await scenario();
      return undefined;
   }
   const started = await startE2EProfiling(options);
   let scenarioError: unknown;
   try {
      await scenario();
   } catch (error: unknown) {
      scenarioError = error;
   }
   let manifest: ProfilingManifest | undefined;
   try {
      manifest = await finishE2EProfiling({ ...options, browserRuntimeBefore: started.browserRuntimeBefore });
   } catch (finishError: unknown) {
      // A teardown/assembly failure must never mask the scenario's own failure —
      // the real assertion error is what the test is about; re-throw it in preference.
      if (scenarioError !== undefined) {
         throw scenarioError;
      }
      throw finishError;
   }
   if (scenarioError !== undefined) {
      throw scenarioError;
   }
   return manifest;
}
