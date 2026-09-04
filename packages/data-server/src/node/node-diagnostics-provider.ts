/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import type { ServerSharedServices } from '@hydranium/core';
import {
   formatPodMemory,
   formatProfileReport,
   formatServerState,
   ProfileCapture,
   recordServerSummaryEntry,
   writeHeapSnapshotToDir
} from '@hydranium/core/node';
import type { DumpServerStateArgs, StartProfilingArgs, StopProfilingArgs, WriteServerHeapSnapshotArgs } from '@hydranium/protocol';
import type { DataServerDiagnosticsProvider, DataServerProfileCapture } from '../diagnostics-provider.js';

/**
 * The Node implementation of the data head's diagnostics, and the reason this
 * subpath exists.
 *
 * Everything here needs a process to inspect — a V8 heap snapshot, an inspector
 * session, `process.memoryUsage()`, cgroup files — so it is server-only by
 * nature. Keeping it out of the package's portable `.` entry is what lets a
 * browser bundle the data head at all.
 *
 * Snapshots are computed in THIS process on purpose: the data-server child holds
 * the model store, so they reflect the heap that actually carries the workspace
 * AST/CST — the process that OOMs.
 */
class NodeProfileCapture implements DataServerProfileCapture {
   constructor(protected readonly capture: ProfileCapture) {}

   async stop(args: StopProfilingArgs): Promise<string> {
      const report = await this.capture.stop(args.directory, args.label ?? '');
      // When a directory was given (the profile files land there), also fold this
      // window's report into `<dir>/server-summary.json` so an interactive/e2e
      // bundle carries the same per-window summary the headless `ProfilingRun`
      // writes.
      if (args.directory) {
         recordServerSummaryEntry(args.directory, args.label ?? '', report);
      }
      return formatProfileReport(report, args.label ? `Profile report (${args.label})` : undefined);
   }
}

class NodeDataServerDiagnostics implements DataServerDiagnosticsProvider {
   async dumpServerState(services: ServerSharedServices, args: DumpServerStateArgs): Promise<string> {
      const openDocuments = services.workspace.TextDocuments.openDocuments();
      return formatServerState(services.workspace.LangiumDocuments, args.label, { openDocuments });
   }

   async writeHeapSnapshot(args: WriteServerHeapSnapshotArgs): Promise<string> {
      return writeHeapSnapshotToDir(args.directory, args.label ?? '');
   }

   async dumpPodMemory(): Promise<string> {
      return formatPodMemory();
   }

   async startProfiling(args: StartProfilingArgs): Promise<DataServerProfileCapture> {
      // `ProfileCapture` is singleton-guarded — one inspector session per
      // process — so a second concurrent start rejects here rather than in the
      // caller, which is where the constraint actually lives.
      return new NodeProfileCapture(await ProfileCapture.start(args));
   }
}

/**
 * The diagnostics provider a Node-hosted `DataServer` should be constructed
 * with: `new DataServer(connection, shared, { diagnostics: nodeDataServerDiagnostics() })`.
 *
 * Omitting it is not an error — the head runs without it and rejects only the
 * four diagnostics methods — so a host that never calls them can leave it out.
 */
export function nodeDataServerDiagnostics(): DataServerDiagnosticsProvider {
   return new NodeDataServerDiagnostics();
}
