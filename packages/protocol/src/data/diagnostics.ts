/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * Optional diagnostics slice of the data-server wire contract: capture memory /
 * state snapshots of the running server process for OOM debugging (notably in a
 * cloud pod). Kept OUT of `DataServerProtocol` so the core document /
 * project contract stays lean, but the framework `DataServer` registers these
 * BY DEFAULT (so every head gets them with no wiring); a head that does not want
 * them drops the names via `DataServerOptions.excludedMethods`.
 *
 * Returns are plain formatted strings — the caller (a command, a log sink, the
 * pod's stdout) decides how to surface them. The wire names are
 * `DATA_SERVER_WIRE_PREFIX + methodName`, same as the core methods.
 */

import type { LatencyReport } from '../latency-collector.js';
import type { ProfileCaptureOptions } from '../profiling.js';

/** Arguments for {@link DataServerDiagnosticsProtocol.dumpServerState}. */
export interface DumpServerStateArgs {
   /** Optional label folded into the snapshot heading (e.g. an ISO timestamp). */
   label?: string;
}

/**
 * Arguments for {@link DataServerDiagnosticsProtocol.startProfiling} — the capture
 * dimensions to sample over the window (all off unless named). The wire args are
 * exactly the neutral {@link ProfileCaptureOptions}.
 */
export type StartProfilingArgs = ProfileCaptureOptions;

/** Arguments for {@link DataServerDiagnosticsProtocol.stopProfiling}. */
export interface StopProfilingArgs {
   /** Optional label folded into the profile filenames + report heading. */
   label?: string;
   /** Directory to write profile artefacts into; defaults to the OS temp dir when absent or not present on disk. */
   directory?: string;
}

/** Arguments for {@link DataServerDiagnosticsProtocol.writeHeapSnapshot}. */
export interface WriteServerHeapSnapshotArgs {
   /** Optional label folded into the snapshot filename. */
   label?: string;
   /** Directory to write into; defaults to the OS temp dir when absent or not present on disk. */
   directory?: string;
}

/**
 * Memory / state diagnostics the running server process exposes. Implemented by
 * the framework `DataServer`; computed in the data-server process (the heavy
 * model store), so the snapshots reflect the process that actually holds the
 * workspace AST/CST — the one that OOMs.
 */
export interface DataServerDiagnosticsProtocol {
   /**
    * Capture a server-process state snapshot — heap, rss, V8 stats, event-loop
    * utilisation, CPU usage, and document counts — and return it formatted.
    */
   dumpServerState(args: DumpServerStateArgs): Promise<string>;

   /**
    * Write a V8 heap snapshot of the server process to disk (full GC first;
    * briefly pauses the process) and return the absolute file path. Open it in
    * Chrome DevTools > Memory > Load for retained-size analysis.
    */
   writeHeapSnapshot(args: WriteServerHeapSnapshotArgs): Promise<string>;

   /**
    * Capture a pod/container memory snapshot — cgroup v2/v1 current/peak/limit
    * plus a per-process RSS tree, the figure the Kubernetes OOM-killer watches.
    * Degrades to a "no cgroup controller" note outside a container.
    */
   dumpPodMemory(): Promise<string>;

   /**
    * Begin a windowed sampled-profile capture (CPU / allocation / GC / event-loop
    * delay, per the named dimensions) of the server process. Sampling does NOT
    * pause the process. Rejects if a capture is already active — one inspector
    * session at a time. Pair with {@link stopProfiling}.
    */
   startProfiling(args: StartProfilingArgs): Promise<void>;

   /**
    * Stop the active capture, write the requested profile artefacts, and return
    * the formatted profile report. Rejects if no capture is active.
    */
   stopProfiling(args: StopProfilingArgs): Promise<string>;

   /**
    * Return the per-method RPC/LSP latency + throughput collected so far (count,
    * p50/p99/max, total per method). Empty when the head was not started with a
    * latency collector. Read-only — does not reset the window.
    */
   getLatency(): Promise<LatencyReport>;
}

/**
 * Request-method names on {@link DataServerDiagnosticsProtocol}. The framework
 * `DataServer` appends these to its registered method set by default; the
 * `as const satisfies` constraint keeps the array in lockstep with the interface.
 */
export const DATA_SERVER_DIAGNOSTICS_METHODS = [
   'dumpServerState',
   'writeHeapSnapshot',
   'dumpPodMemory',
   'startProfiling',
   'stopProfiling',
   'getLatency'
] as const satisfies ReadonlyArray<keyof DataServerDiagnosticsProtocol & string>;
