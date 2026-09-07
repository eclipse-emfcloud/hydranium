/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import type { ServerSharedServices } from '@hydranium/core';
import type { DumpServerStateArgs, StartProfilingArgs, StopProfilingArgs, WriteServerHeapSnapshotArgs } from '@hydranium/protocol';

/**
 * The runtime-specific half of `DataServerDiagnosticsProtocol`, supplied
 * by the host rather than reached for directly.
 *
 * # Why this is a seam and not four method bodies
 *
 * Every operation behind it needs a Node runtime — a V8 heap snapshot, an
 * inspector session, `process.memoryUsage()`, cgroup files. Calling them
 * directly puts a static `@hydranium/core/node` import on the data head's
 * portable `.` entry, which no browser bundler can resolve: the head then fails
 * to BUILD for a browser even though nothing in a browser would ever call a
 * diagnostics method. Since the data head exists to serve non-LSP clients —
 * webviews and browser pages among them — that is a defect rather than a
 * trade-off.
 *
 * Node hosts get the real implementation from `@hydranium/data-server/node`.
 * Hosts that supply nothing keep the whole rest of the protocol and reject only
 * these four methods, with a message naming the import that would satisfy them.
 */
export interface DataServerDiagnosticsProvider {
   /**
    * Snapshot this process's memory, V8 stats, event-loop utilisation and
    * document counts, formatted for a log.
    *
    * Takes the services rather than a document list so the whole shape of the
    * snapshot — including which of the shared tier's stores it reads — stays a
    * decision of the implementation, and no Node-only type appears here.
    */
   dumpServerState(services: ServerSharedServices, args: DumpServerStateArgs): Promise<string>;

   /** Write a V8 heap snapshot and return its absolute path. */
   writeHeapSnapshot(args: WriteServerHeapSnapshotArgs): Promise<string>;

   /** Snapshot cgroup/pod memory — the figure an OOM-killer watches. */
   dumpPodMemory(): Promise<string>;

   /**
    * Begin a windowed sampled-profile capture.
    *
    * Rejecting when a capture is already active is the implementation's
    * responsibility, because the constraint is the runtime's: one inspector
    * session per process.
    */
   startProfiling(args: StartProfilingArgs): Promise<DataServerProfileCapture>;
}

/** A profile capture in flight, returned by {@link DataServerDiagnosticsProvider.startProfiling}. */
export interface DataServerProfileCapture {
   /**
    * End the capture, write its artefacts when a directory was given, and
    * return the formatted report.
    *
    * Formatting belongs here rather than in the caller so the report type never
    * has to cross this boundary — it is a Node-side shape, and naming it in the
    * portable interface would put the import back.
    */
   stop(args: StopProfilingArgs): Promise<string>;
}
