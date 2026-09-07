/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import * as fs from 'node:fs';
import { performance } from 'node:perf_hooks';
import * as path from 'node:path';
import * as v8 from 'node:v8';
import { Format } from '@hydranium/protocol';
import { type ServerSharedServicesMinimal } from '../langium/shared-services.js';
import { buildWorkspaceProgrammatically } from '../langium/workspace/initialize-workspace.js';
import { tallyAstGroundTruth } from './ast-ground-truth.js';
import { type ProfileCaptureOptions } from './profile-capture.js';
import { ProfilingRun } from './profiling-run.js';

/** Options for {@link measureModelMemory}. */
export interface MeasureModelMemoryOptions {
   /**
    * Create the language's shared services in-process. Invoked AFTER the empty
    * baseline so the delta to after-build is exactly what parsing/building the
    * workspace adds. This is the only language-specific input — a head passes its
    * own `create<Lang>Services(fileSystem)`.
    */
   createServices: () => { shared: ServerSharedServicesMinimal };
   /** Workspace root (filesystem path or file URI) to build. */
   workspace: string;
   /** Re-run `DocumentBuilder.update` this many times to probe for retention (default 0 = skip). */
   editCycles?: number;
   /** Documents to churn per cycle (default 25). */
   editDocs?: number;
   /** Only churn documents whose URI path ends with this suffix (default: any document). */
   churnDocSuffix?: string;
   /**
    * Wait this many milliseconds after the build before the after-build reading
    * (default 0 = no wait). Needed to measure timer-driven residency policies
    * (e.g. `CstResidencyService`'s
    * `shed-closed-when-idle`): shedding fires on a `Clock` timer *after* the build
    * returns, so without a settle the reading is taken before any CST is shed.
    * Pass a value comfortably above the policy's `idleMs`.
    */
   settleMs?: number;
   /** Write a `.heapsnapshot` after the build (default false). */
   writeSnapshot?: boolean;
   /** Snapshot path (default `<cwd>/<workspace-basename>.heapsnapshot`). */
   snapshotPath?: string;
   /**
    * Capture sampled profiles around the build and (when `editCycles > 0`) the
    * churn, writing a full profiling session (manifest + digests) via
    * {@link ProfilingRun}. Off unless set. The two windows are the multiplier:
    * the churn allocation profile isolates what a *rebuild* re-allocates, which a
    * one-shot capture cannot.
    */
   profile?: ProfileCaptureOptions;
   /** Parent directory for the profiling session folder (default: OS temp dir). Only used with {@link profile}. */
   sessionOut?: string;
   /** Progress-line sink (default: no output — the result object carries the numbers). */
   log?: (line: string) => void;
}

/** Structured result of {@link measureModelMemory}. */
export interface MeasureModelMemoryResult {
   documentCount: number;
   buildMs: number;
   emptyHeapBytes: number;
   afterBuildHeapBytes: number;
   /** Heap growth across the rebuild-churn cycles; present only when `editCycles > 0`. */
   churnGrowthBytes?: number;
   /** Absolute path of the written heap snapshot; present only when `writeSnapshot`. */
   snapshotPath?: string;
   /** Absolute path of the profiling session directory (manifest + digests); present only when `profile` was set. */
   profilingSession?: string;
}

function gcAndHeap(): NodeJS.MemoryUsage {
   const gc = (globalThis as { gc?: () => void }).gc;
   if (gc) {
      // Two passes so the reading is post-GC (the second collects what the first freed).
      gc();
      gc();
   }
   return process.memoryUsage();
}

/**
 * Headless model-store memory measurement — the browser-/socket-free counterpart
 * to the in-app "dump server state" command. Boots a head's Langium services
 * in-process via {@link MeasureModelMemoryOptions.createServices}, builds a
 * workspace, and reports the model-store memory across scenarios:
 *   - empty baseline   : services created, no documents loaded.
 *   - after build      : parse + link + validate + index of the whole workspace.
 *   - rebuild churn     : re-run `DocumentBuilder.update` on unchanged content N
 *                        times; any monotonic growth is retention (a leak), not
 *                        new data — the "memory creeps up while editing" probe.
 *
 * Measures only the language-server / model layer (the dominant pod consumer);
 * not the Theia backend, GLSP GModel, or worker heaps. Pass `--expose-gc` to the
 * node process so the readings are post-GC. Pure framework code: the only
 * language-specific input is the service factory.
 */
export async function measureModelMemory(options: MeasureModelMemoryOptions): Promise<MeasureModelMemoryResult> {
   const log = options.log ?? ((): void => undefined);
   const report = (label: string): NodeJS.MemoryUsage => {
      const mem = gcAndHeap();
      log(`[${label}] heapUsed=${Format.bytes(mem.heapUsed)} rss=${Format.bytes(mem.rss)} external=${Format.bytes(mem.external)}`);
      return mem;
   };

   report('before-services');
   // Start the profiling session BEFORE creating services: it points
   // `HYDRANIUM_LOG_FILE` at the session's server.log, which the head's logger
   // reads only at construction time (inside createServices).
   const profilingRun = options.profile
      ? await ProfilingRun.start({ directory: options.sessionOut, mode: 'harness', workspace: options.workspace, capture: options.profile })
      : undefined;
   const { shared } = options.createServices();
   const empty = report('after-services-empty');

   const start = performance.now();
   const build = (): Promise<void> => buildWorkspaceProgrammatically(shared, options.workspace);
   await (profilingRun ? profilingRun.window('build', build) : build());
   const buildMs = performance.now() - start;
   const docs = shared.workspace.LangiumDocuments.all.toArray();
   const settleMs = options.settleMs ?? 0;
   if (settleMs > 0) {
      // Let timer-driven residency (idle eviction) fire before the reading.
      await new Promise<void>(resolve => setTimeout(resolve, settleMs));
      log(`(settled ${settleMs} ms for timer-driven residency before measuring)`);
   }
   const afterBuild = report('after-build');
   const adds = afterBuild.heapUsed - empty.heapUsed;
   log(`Documents: ${docs.length}, build ${Math.round(buildMs)} ms`);
   // An empty workspace is an accepted input, so the per-document figure is
   // omitted rather than divided by a substituted 1 — a `/doc` reading for no
   // documents is not a smaller number, it is a meaningless one.
   const perDoc = docs.length > 0 ? ` (~${Format.bytes(adds / docs.length)}/doc)` : '';
   log(`Workspace build adds ${Format.bytes(adds)} heap${perDoc}`);

   const result: MeasureModelMemoryResult = {
      documentCount: docs.length,
      buildMs,
      emptyHeapBytes: empty.heapUsed,
      afterBuildHeapBytes: afterBuild.heapUsed
   };

   const editCycles = options.editCycles ?? 0;
   if (editCycles > 0) {
      const suffix = options.churnDocSuffix;
      const uris = docs
         .filter(doc => (suffix ? doc.uri.path.endsWith(suffix) : true))
         // The churn re-runs `DocumentBuilder.update`, which re-reads each URI from
         // the file system. Only file-backed documents survive that — synthetic /
         // built-in docs (string-backed, served in-memory during the build, e.g. a
         // head's built-in type definitions) have no file and would ENOENT. Restrict
         // the churn set to documents that actually exist on disk.
         .filter(doc => doc.uri.scheme === 'file' && fs.existsSync(doc.uri.fsPath))
         .slice(0, options.editDocs ?? 25)
         .map(doc => doc.uri);
      log(`Rebuild churn: ${editCycles} cycles x ${uris.length} docs (unchanged content)...`);
      const churn = async (): Promise<number[]> => {
         const collected: number[] = [];
         for (let cycle = 1; cycle <= editCycles; cycle++) {
            await shared.workspace.DocumentBuilder.update(uris, []);
            collected.push(gcAndHeap().heapUsed);
         }
         return collected;
      };
      const heaps = await (profilingRun ? profilingRun.window('churn', churn) : churn());
      const growth = heaps[heaps.length - 1] - heaps[0];
      result.churnGrowthBytes = growth;
      const verdict = growth > 5 * 1024 * 1024 ? 'POSSIBLE RETENTION' : 'stable (no leak)';
      log(`Rebuild churn growth ${Format.bytes(growth)} over ${editCycles} cycles - ${verdict}`);
   }

   if (options.writeSnapshot) {
      const snapshotPath = options.snapshotPath ?? path.resolve(process.cwd(), `${path.basename(options.workspace)}.heapsnapshot`);
      v8.writeHeapSnapshot(snapshotPath);
      result.snapshotPath = snapshotPath;
      log(`Heap snapshot: ${snapshotPath}`);
   }

   if (profilingRun) {
      // Fold the non-profile artefacts the manifest catalogues into the same
      // session folder, from data already in hand (no extra build).
      profilingRun.attach('server-ast', 'server-ast.json', tallyAstGroundTruth(shared));
      profilingRun.attach('server-memory-report', 'server-memory-report.json', result);
      await profilingRun.finish();
      result.profilingSession = profilingRun.directory;
      log(`Profiling session: ${profilingRun.directory}`);
   }
   return result;
}
