/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { Format } from '@hydranium/protocol';
import { DocumentState, type LangiumDocuments } from '@hydranium/langium';
import { isCstShed } from '../langium/residency/cst-residency-service.js';
import { performance } from 'node:perf_hooks';
import * as v8 from 'node:v8';

/** Cumulative samples kept across calls so each snapshot can report deltas. */
interface DeltaState {
   atMs: number;
   cpu: NodeJS.CpuUsage;
   elu: { idle: number; active: number };
}
let lastSample: DeltaState | undefined;

/**
 * A document held open by one or more clients, as reported by
 * `HydraniumTextDocuments.openDocuments()` (whose `OpenDocument` entries are
 * structurally assignable). The `uri` is pre-formatted by the caller (canonical
 * URI or a shortened form — the snapshot prints it as given).
 */
export interface OpenDocumentEntry {
   readonly uri: string;
   readonly clients: readonly string[];
}

/** Default for {@link ServerStateSnapshotOptions.openDocumentsListCap}. */
export const DEFAULT_OPEN_DOCUMENTS_LIST_CAP = 25;

/** Optional snapshot sections and their tuning knobs. */
export interface ServerStateSnapshotOptions {
   /**
    * Documents currently held open with the client ids holding them (from
    * `HydraniumTextDocuments.openDocuments()`). When set, the snapshot lists
    * them — the observable for client-release bugs: a document that lingers
    * here after its editor closed names the client that failed to close it,
    * and under a shedding policy it is exactly the set excluded from CST
    * shedding.
    */
   readonly openDocuments?: readonly OpenDocumentEntry[];
   /**
    * Open-document entries printed individually before the list is elided to
    * `… and N more`. Default {@link DEFAULT_OPEN_DOCUMENTS_LIST_CAP}.
    */
   readonly openDocumentsListCap?: number;
}

/**
 * Format a multi-line server-state snapshot — heap, rss, V8 stats, event-loop
 * utilisation, CPU usage, and document counts — and return it. Pure (the caller
 * logs the result, e.g. `tracer.info(formatServerState(...))`), matching
 * `formatProcessMemory` / `formatPodMemory`. Tracks deltas across calls so
 * subsequent snapshots show "since last snapshot" rates. Optional sections are
 * requested via `options` ({@link ServerStateSnapshotOptions}).
 */
export function formatServerState(documents?: LangiumDocuments, label?: string, options?: ServerStateSnapshotOptions): string {
   const now = performance.now();
   const mem = process.memoryUsage();
   const heap = v8.getHeapStatistics();
   const cpu = process.cpuUsage();
   const elu = (performance as { eventLoopUtilization?: () => { idle: number; active: number } }).eventLoopUtilization?.() ?? {
      idle: 0,
      active: 0
   };

   const heapPercent = Math.round((mem.heapUsed / heap.heap_size_limit) * 100);
   const lines: string[] = [];
   lines.push(label ? `Server state snapshot (${label}):` : 'Server state snapshot:');
   lines.push(`  uptime    ${formatDuration(process.uptime() * 1000)}`);
   lines.push(
      `  heap      ${Format.bytes(mem.heapUsed)} used / ${Format.bytes(mem.heapTotal)} total / ` +
         `${Format.bytes(heap.heap_size_limit)} limit (${heapPercent}% of limit)`
   );
   lines.push(
      `  rss       ${Format.bytes(mem.rss)}, external ${Format.bytes(mem.external)}, arrayBuffers ${Format.bytes(mem.arrayBuffers)}`
   );
   lines.push(
      `  v8        malloced ${Format.bytes(heap.malloced_memory)}, peak ${Format.bytes(heap.peak_malloced_memory)}, ` +
         `native contexts ${heap.number_of_native_contexts}, detached contexts ${heap.number_of_detached_contexts}`
   );
   if (lastSample) {
      const wallMs = now - lastSample.atMs;
      const userMs = (cpu.user - lastSample.cpu.user) / 1000;
      const systemMs = (cpu.system - lastSample.cpu.system) / 1000;
      const cpuPct = wallMs > 0 ? Math.round(((userMs + systemMs) / wallMs) * 100) : 0;
      const idleDelta = elu.idle - lastSample.elu.idle;
      const activeDelta = elu.active - lastSample.elu.active;
      const eluTotal = idleDelta + activeDelta;
      const eluPct = eluTotal > 0 ? Math.round((activeDelta / eluTotal) * 100) : 0;
      lines.push(
         `  cpu       user ${Math.round(userMs)}ms, system ${Math.round(systemMs)}ms ` + `in last ${Math.round(wallMs)}ms (${cpuPct}%)`
      );
      lines.push(
         `  loop      utilization ${eluPct}% (active ${Math.round(activeDelta)}ms / ` +
            `idle ${Math.round(idleDelta)}ms since last snapshot)`
      );
   } else {
      lines.push(
         `  cpu       user ${Math.round(cpu.user / 1000)}ms, system ${Math.round(cpu.system / 1000)}ms ` +
            '(cumulative since process start)'
      );
      const eluTotal = elu.idle + elu.active;
      const eluPct = eluTotal > 0 ? Math.round((elu.active / eluTotal) * 100) : 0;
      lines.push(`  loop      utilization ${eluPct}% (cumulative since process start)`);
   }
   if (documents) {
      const counts = countDocumentsByState(documents);
      const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
      const breakdown = Object.entries(counts)
         .filter(([, n]) => n > 0)
         .map(([state, n]) => `${state}: ${n}`)
         .join(', ');
      lines.push(`  documents ${total} tracked${breakdown ? ` (${breakdown})` : ''}`);
      // CST-residency breakdown — only meaningful (and only emitted) once a residency
      // policy has shed at least one document; silent under the always-keep default.
      const residency = countCstResidency(documents);
      if (residency.shed > 0) {
         lines.push(`  cst       ${residency.resident} resident, ${residency.shed} shed`);
      }
   }
   const openDocuments = options?.openDocuments;
   if (openDocuments !== undefined) {
      const listCap = options?.openDocumentsListCap ?? DEFAULT_OPEN_DOCUMENTS_LIST_CAP;
      lines.push(`  open      ${openDocuments.length} document(s) held by a client (excluded from CST shedding)`);
      for (const { uri, clients } of openDocuments.slice(0, listCap)) {
         lines.push(`            ${uri} [${clients.join(', ')}]`);
      }
      if (openDocuments.length > listCap) {
         lines.push(`            … and ${openDocuments.length - listCap} more`);
      }
   }

   lastSample = { atMs: now, cpu, elu };
   return lines.join('\n');
}

/**
 * Count documents whose CST is resident vs. shed by a residency policy
 * ({@link isCstShed}). A document can also be in neither bucket — not-yet-parsed
 * or a synthetic placeholder with no `$cstNode` at all (nothing to be "resident"
 * or "shed") — which is intentionally counted as neither; `resident + shed` is
 * therefore ≤ total tracked, with the remainder explained by the state breakdown
 * on the preceding `documents` line.
 */
function countCstResidency(documents: LangiumDocuments): { resident: number; shed: number } {
   let resident = 0;
   let shed = 0;
   for (const doc of documents.all) {
      if (isCstShed(doc)) {
         shed++;
      } else if (doc.parseResult?.value?.$cstNode !== undefined) {
         resident++;
      }
      // else: unparsed / synthetic — no CST, so neither resident nor shed.
   }
   return { resident, shed };
}

function countDocumentsByState(documents: LangiumDocuments): Record<string, number> {
   const counts: Record<string, number> = {};
   for (const doc of documents.all) {
      const stateName = DocumentState[doc.state] ?? `Unknown(${doc.state})`;
      counts[stateName] = (counts[stateName] ?? 0) + 1;
   }
   return counts;
}

function formatDuration(ms: number): string {
   if (ms < 1000) {
      return `${Math.round(ms)}ms`;
   }
   const totalSeconds = Math.floor(ms / 1000);
   const seconds = totalSeconds % 60;
   const totalMinutes = Math.floor(totalSeconds / 60);
   const minutes = totalMinutes % 60;
   const hours = Math.floor(totalMinutes / 60);
   if (hours > 0) {
      return `${hours}h ${minutes}m ${seconds}s`;
   }
   if (minutes > 0) {
      return `${minutes}m ${seconds}s`;
   }
   return `${seconds}s`;
}
