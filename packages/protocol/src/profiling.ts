/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/*
 * Neutral shape of a sampled-profile capture request. It lives in `protocol`
 * (not the Node-only `@hydranium/core/node` capture implementation) because it
 * crosses the wire — the data-server diagnostics `startProfiling` args extend it,
 * and a frontend/CLI names the dimensions to capture. The implementation
 * (`ProfileCapture`, the `node:inspector` session) stays in `@hydranium/core/node`.
 */

/** Which dimensions to capture, and the two sampling knobs. All off by default. */
export interface ProfileCaptureOptions {
   cpu?: boolean;
   allocation?: boolean;
   gc?: boolean;
   eventLoopDelay?: boolean;
   /** Also drop a retained `.heapsnapshot` at stop (for the memory analyzer). */
   heapSnapshot?: boolean;
   /** CPU sampling interval in µs (implementation default 1000). */
   cpuIntervalMicros?: number;
   /** Allocation sampling interval in bytes (implementation default 32768). */
   allocationIntervalBytes?: number;
}

/*
 * The manifest schema — the self-describing index over one profiling run's
 * artefacts. It lives in `protocol` (not the Node-only `ProfilingRun` that writes
 * it) so both the server-side assembler AND a Playwright-side assembler can share
 * the shape without a `node`-only dependency chain. `ProfilingRun` re-exports
 * these from `@hydranium/core/node`.
 */

export const PROFILING_SCHEMA_VERSION = 1;

/**
 * The locked, origin-first artefact kinds (the kind equals the artefact's filename stem).
 * A closed union so a producer cannot emit a stale or typo'd kind and still
 * compile — the drift the naming scheme forbids.
 */
export type ProfilingArtifactKind =
   | 'server-cpu'
   | 'server-alloc'
   | 'server-heap'
   | 'server-summary'
   | 'server-latency'
   | 'server-ast'
   | 'server-memory-report'
   | 'server-log'
   | 'browser-runtime'
   | 'browser-timeline'
   | 'browser-heap'
   | 'browser-console';

/** One entry in the manifest — a captured file plus enough context for a skill to know what it is. */
export interface ProfilingArtifact {
   /** The artefact's origin-first kind; equals its filename stem. */
   kind: ProfilingArtifactKind;
   /** Path relative to the manifest (the artefact lives beside it in the session directory). */
   path: string;
   /** The window the artefact was captured in, when it is window-scoped. */
   window?: string;
   /** Pointer to a compact digest file for a heavy artefact (added by the digest emitters). */
   digest?: string;
}

/** What a skill reads to know what to expect from a run (browser entries only in `app` mode, etc.). */
export interface ProfilingEnvironment {
   mode: 'harness' | 'app';
   /** Whether a cgroup memory controller is present (running in a pod) vs local. */
   container: boolean;
   commit?: string;
   workspace?: string;
   node: string;
   windows: { label: string; ms: number }[];
}

/** The `manifest.json` contents — the index over one run's artefacts. */
export interface ProfilingManifest {
   /**
    * Always {@link PROFILING_SCHEMA_VERSION} as written; declared as `number`
    * because a READER may be newer than the run it is opening. Check it before
    * trusting any field — an older manifest can be missing fields this
    * declaration says are required.
    */
   schemaVersion: number;
   /**
    * Names the session directory the manifest sits in, so it identifies a run
    * without carrying an absolute path. Unique per run by construction (a
    * timestamp when the caller supplies none), but nothing enforces that a
    * caller-supplied id is not reused.
    */
   sessionId: string;
   /**
    * What the run was captured against — needed to know which artefacts to
    * expect at all, since the browser kinds only occur in `app` mode, and to
    * know whether two runs are comparable.
    */
   environment: ProfilingEnvironment;
   /**
    * Every file written beside the manifest. Presence is the only signal that a
    * dimension was captured: an artefact for a dimension that was not requested
    * is absent rather than empty, and a kind may occur more than once when the
    * run has several windows.
    */
   artifacts: ProfilingArtifact[];
}
