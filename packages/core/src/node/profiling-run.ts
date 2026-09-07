/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/*
 * The profiling session orchestrator: one run = one timestamped folder holding
 * the captured artefacts and a self-describing `manifest.json`. This is the seam
 * that makes "everything from a single run" true without a god-object — each
 * collector shares only the session directory + manifest. This run drives the
 * server-side sampled-profile capture over one or more named windows and, when
 * given a collector, the latency report; browser-origin collectors append their
 * own manifest entries the same way, from the Playwright side.
 */

import {
   DEFAULT_LOG_FILE_ENV,
   PROFILING_SCHEMA_VERSION,
   type LatencyCollector,
   type ProfilingArtifact,
   type ProfilingArtifactKind,
   type ProfilingEnvironment,
   type ProfilingManifest
} from '@hydranium/protocol';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { profileWorkload, type ProfileCaptureOptions, type ProfileReport } from './profile-capture.js';
import { digestAllocationProfile, digestCpuProfile, type AllocationProfile, type CpuProfile } from './profile-digest.js';

// The manifest schema lives in `@hydranium/protocol` so a Playwright-side
// assembler can share the shape without a Node-only dependency chain;
// re-export it here so `@hydranium/core/node` consumers keep one import site.
export { PROFILING_SCHEMA_VERSION };
export type { ProfilingArtifact, ProfilingEnvironment, ProfilingManifest };

/** Options for a {@link ProfilingRun}. Environment fields are injectable so a run is reproducible in tests. */
export interface ProfilingRunOptions {
   /** Parent directory for the session folder; falls back to the OS temp dir when missing. */
   directory?: string;
   /** Session id / folder name; defaults to `profiling-<timestamp>`. */
   sessionId?: string;
   /** `harness` (default) for a headless run, `app` for a real deployment. */
   mode?: 'harness' | 'app';
   /** Override the cgroup auto-detection (mainly for tests). */
   container?: boolean;
   commit?: string;
   workspace?: string;
   /** Which dimensions each window captures (default-off, per {@link ProfileCaptureOptions}). */
   capture?: ProfileCaptureOptions;
   /**
    * Optional latency collector. When present, {@link ProfilingRun.finish} writes
    * its report to `server-latency.json` and records a `server-latency` manifest artefact. A
    * head feeds it via the RPC binding / `instrumentLspConnection`; a pure
    * headless build with no request traffic leaves it empty.
    */
   latency?: LatencyCollector;
}

/** A cgroup memory controller signals we are inside a container/pod. */
function detectContainer(): boolean {
   return fs.existsSync('/sys/fs/cgroup/memory.current') || fs.existsSync('/sys/fs/cgroup/memory/memory.usage_in_bytes');
}

/**
 * A profiling session: create it, run one or more named windows through it, then
 * {@link finish} to write `server-summary.json` + `manifest.json` and get the manifest.
 * Windows run sequentially (the underlying capture is a single inspector session).
 */
export class ProfilingRun {
   readonly directory: string;
   protected readonly sessionId: string;
   protected readonly reports: Record<string, ProfileReport> = {};
   protected readonly artifacts: ProfilingArtifact[] = [];
   protected readonly windows: { label: string; ms: number }[] = [];
   protected finished = false;
   /** The `HYDRANIUM_LOG_FILE` value seen before this run pointed it at the session (restored on {@link finish}). */
   protected readonly previousLogFileEnv?: string;
   /** Absolute path of the session's teed server log. */
   readonly serverLogPath: string;

   protected constructor(
      protected readonly options: ProfilingRunOptions,
      directory: string,
      sessionId: string
   ) {
      this.directory = directory;
      this.sessionId = sessionId;
      this.serverLogPath = path.join(directory, 'server.log');
      // Point the log-file tee at the session so the head's structured logs
      // (build phases, warnings, and — in an app run — the interleaved browser
      // console) land in the bundle beside the profiles. Done via the
      // `HYDRANIUM_LOG_FILE` env, which every `@hydranium/core` copy reads when
      // its logger is CONSTRUCTED — so `ProfilingRun.start` must run before the
      // head's services are created (as `measureModelMemory` does). This is the
      // only mechanism that crosses a yalc'd adopter's separate core copy; a
      // process-local `setLogFilePath` would only reach this module's own copy.
      this.previousLogFileEnv = process.env[DEFAULT_LOG_FILE_ENV];
      process.env[DEFAULT_LOG_FILE_ENV] = this.serverLogPath;
   }

   static async start(options: ProfilingRunOptions = {}): Promise<ProfilingRun> {
      const sessionId = options.sessionId ?? `profiling-${new Date().toISOString().replace(/[:.]/g, '-')}`;
      // Honour an explicitly requested directory (created recursively); only fall
      // back to the OS temp dir when none was given.
      const directory = path.join(options.directory ?? os.tmpdir(), sessionId);
      fs.mkdirSync(directory, { recursive: true });
      return new ProfilingRun(options, directory, sessionId);
   }

   /**
    * Write an already-collected artefact (e.g. `server-ast.json`,
    * `server-memory-report.json`) into the session directory and record it in the
    * manifest. For non-profile inputs a head/harness already has in hand.
    */
   attach(kind: ProfilingArtifactKind, filename: string, data: unknown): void {
      if (this.finished) {
         throw new Error('ProfilingRun.attach called after finish().');
      }
      fs.writeFileSync(path.join(this.directory, filename), JSON.stringify(data, undefined, 2));
      this.artifacts.push({ kind, path: filename });
   }

   /** Capture {@link run} as a named window, recording its artefacts + duration. Returns the block's result. */
   async window<T>(label: string, run: () => Promise<T>): Promise<T> {
      if (this.finished) {
         throw new Error('ProfilingRun.window called after finish().');
      }
      if (this.reports[label] !== undefined) {
         throw new Error(`ProfilingRun.window called twice with label '${label}'; window labels must be unique.`);
      }
      const { result, report } = await profileWorkload({ ...(this.options.capture ?? {}), directory: this.directory, label }, run);
      this.reports[label] = report;
      this.windows.push({ label, ms: report.durationMs });
      if (report.cpuProfilePath) {
         this.artifacts.push(
            this.artifactWithDigest('server-cpu', report.cpuProfilePath, label, raw => digestCpuProfile(raw as CpuProfile))
         );
      }
      if (report.allocationProfilePath) {
         this.artifacts.push(
            this.artifactWithDigest('server-alloc', report.allocationProfilePath, label, raw =>
               digestAllocationProfile(raw as AllocationProfile)
            )
         );
      }
      if (report.heapSnapshotPath) {
         // No inline digest: a heap snapshot's digest is the retained-size analyzer's report.
         this.artifacts.push({ kind: 'server-heap', path: path.basename(report.heapSnapshotPath), window: label });
      }
      return result;
   }

   /** Build the artefact entry, emitting a `<profile>.txt` digest beside the profile; a digest failure is non-fatal. */
   protected artifactWithDigest(
      kind: ProfilingArtifactKind,
      file: string,
      window: string,
      digest: (raw: unknown) => string
   ): ProfilingArtifact {
      const artifact: ProfilingArtifact = { kind, path: path.basename(file), window };
      try {
         const raw: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
         const digestPath = `${file}.txt`;
         fs.writeFileSync(digestPath, digest(raw));
         artifact.digest = path.basename(digestPath);
      } catch {
         // The raw profile is still in the bundle; a skill can fall back to it.
      }
      return artifact;
   }

   /** Write `server-summary.json` + `manifest.json` into the session directory and return the manifest. */
   async finish(): Promise<ProfilingManifest> {
      this.finished = true;
      // Restore the prior log-file env, then record the log as an artefact only
      // if the run actually produced one.
      if (this.previousLogFileEnv === undefined) {
         delete process.env[DEFAULT_LOG_FILE_ENV];
      } else {
         process.env[DEFAULT_LOG_FILE_ENV] = this.previousLogFileEnv;
      }
      if (fs.existsSync(this.serverLogPath)) {
         this.artifacts.push({ kind: 'server-log', path: 'server.log' });
      }
      fs.writeFileSync(path.join(this.directory, 'server-summary.json'), JSON.stringify(this.reports, undefined, 2));
      if (this.options.latency) {
         fs.writeFileSync(path.join(this.directory, 'server-latency.json'), JSON.stringify(this.options.latency.report(), undefined, 2));
         this.artifacts.push({ kind: 'server-latency', path: 'server-latency.json' });
      }
      const manifest: ProfilingManifest = {
         schemaVersion: PROFILING_SCHEMA_VERSION,
         sessionId: this.sessionId,
         environment: {
            mode: this.options.mode ?? 'harness',
            container: this.options.container ?? detectContainer(),
            commit: this.options.commit,
            workspace: this.options.workspace,
            node: process.version,
            windows: this.windows
         },
         artifacts: [...this.artifacts, { kind: 'server-summary', path: 'server-summary.json' }]
      };
      fs.writeFileSync(path.join(this.directory, 'manifest.json'), JSON.stringify(manifest, undefined, 2));
      return manifest;
   }
}

/**
 * Merge one window's {@link ProfileReport} into `<directory>/server-summary.json`
 * (read-modify-write, keyed by window label). Lets the interactive / RPC capture path
 * — which stops a single window at a time via the data-server `stopProfiling`, with no
 * {@link ProfilingRun} to collect the reports — accrue the same `server-summary`
 * artefact the headless {@link ProfilingRun.finish} writes in one pass. An empty label
 * is keyed `app`; a malformed or absent existing file is treated as empty. Creates the
 * directory if needed, so a caller-supplied path that does not yet exist does not throw.
 */
export function recordServerSummaryEntry(directory: string, label: string, report: ProfileReport): void {
   fs.mkdirSync(directory, { recursive: true });
   const file = path.join(directory, 'server-summary.json');
   let summary: Record<string, ProfileReport> = {};
   try {
      const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (parsed && typeof parsed === 'object') {
         summary = parsed as Record<string, ProfileReport>;
      }
   } catch {
      // No existing summary (or unreadable) — start fresh.
   }
   summary[label || 'app'] = report;
   fs.writeFileSync(file, JSON.stringify(summary, undefined, 2));
}
