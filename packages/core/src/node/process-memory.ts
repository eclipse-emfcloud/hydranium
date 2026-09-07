/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/*
 * Node-only process- and pod-level memory introspection plus heap-snapshot
 * writing. Everything here is generic OS-level code (V8 stats, cgroup v2/v1,
 * `/proc`); the only host-specific part is naming the processes, which a head
 * supplies through a `ProcessClassifier`.
 */

import { Format } from '@hydranium/protocol';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as v8 from 'node:v8';

/**
 * Format a one-shot memory snapshot of the CURRENT process (heap, rss, external, V8 limit).
 * Suited to a process that hosts no Langium documents (e.g. a host backend); for the
 * language-server process with document counts, see `formatServerState`.
 */
export function formatProcessMemory(label: string): string {
   const mem = process.memoryUsage();
   const heap = v8.getHeapStatistics();
   const heapPercent = Math.round((mem.heapUsed / heap.heap_size_limit) * 100);
   return [
      `${label}:`,
      `  heap      ${Format.bytes(mem.heapUsed)} used / ${Format.bytes(mem.heapTotal)} total / ` +
         `${Format.bytes(heap.heap_size_limit)} limit (${heapPercent}% of limit)`,
      `  rss       ${Format.bytes(mem.rss)}, external ${Format.bytes(mem.external)}, arrayBuffers ${Format.bytes(mem.arrayBuffers)}`,
      `  uptime    ${Math.round(process.uptime())}s, pid ${process.pid}`
   ].join('\n');
}

/**
 * Compose an absolute artifact file path of the form `<prefix>[-<label>].<ext>` inside
 * {@link directory} (e.g. the workspace folder, so it lands on the persistent volume in cloud and
 * is visible in the file explorer), falling back to the OS temp dir when the directory is missing
 * or does not exist. The {@link prefix} carries the origin-first stem (e.g. `server-cpu`) and, when
 * a non-empty {@link label} is given (a named capture window), it is sanitised (non-word characters
 * → `_`, truncated to 40 chars) and appended as `-<label>`; an empty label yields the bare
 * `<prefix>.<ext>` so the manifest `kind` equals the filename stem. No timestamp — a fresh session
 * directory per run keeps names stable and collision-free. Shared by the heap-snapshot writer and
 * the sampled-profile capture so heap / CPU / allocation artefacts land identically, differing only
 * by extension.
 */
export function snapshotFilePath(directory: string | undefined, label: string, prefix: string, ext: string): string {
   const safeLabel = label ? label.replace(/[^\w.-]+/g, '_').slice(0, 40) : '';
   const dir = directory && fs.existsSync(directory) ? directory : os.tmpdir();
   const stem = safeLabel ? `${prefix}-${safeLabel}` : prefix;
   return path.join(dir, `${stem}.${ext}`);
}

/**
 * Write a V8 heap snapshot of the CURRENT process to {@link directory}, falling back to the OS temp
 * dir when it is missing (see {@link snapshotFilePath}). `v8.writeHeapSnapshot` runs a full GC first and
 * briefly pauses the process; it also transiently inflates RSS while serialising. Returns the
 * absolute file path. The {@link prefix} (default `server-heap`, the origin-first stem) and
 * {@link label} are folded into the name.
 */
export function writeHeapSnapshotToDir(directory: string | undefined, label: string, prefix = 'server-heap'): string {
   const filePath = snapshotFilePath(directory, label, prefix, 'heapsnapshot');
   v8.writeHeapSnapshot(filePath);
   return filePath;
}

const CGROUP_ROOT = '/sys/fs/cgroup';

function readNumber(file: string): number | undefined {
   try {
      const text = fs.readFileSync(file, 'utf8').trim();
      if (text === 'max') {
         return Number.POSITIVE_INFINITY;
      }
      const value = Number(text);
      return Number.isFinite(value) ? value : undefined;
   } catch {
      return undefined;
   }
}

/** Parse a `key value` per-line file (cgroup memory.stat) into a map. */
function readKeyedBytes(file: string): Record<string, number> {
   const out: Record<string, number> = {};
   try {
      for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
         const [key, value] = line.trim().split(/\s+/);
         if (key && value !== undefined) {
            const num = Number(value);
            if (Number.isFinite(num)) {
               out[key] = num;
            }
         }
      }
   } catch {
      // file absent or unreadable; caller handles the empty map.
   }
   return out;
}

interface ProcInfo {
   pid: number;
   rssBytes: number;
   label: string;
}

interface RawProc extends ProcInfo {
   ppid: number;
}

/** A readable role for a process, whether it belongs to the app, and whether exactly one is expected. */
export interface ProcessRole {
   /** Human-readable role shown in the snapshot. */
   role: string;
   /** Whether this process is part of the application (vs. tooling/debugger), counted in the app total. */
   isApp: boolean;
   /**
    * Set when at most one instance of this role should exist; `formatPodMemory` warns when more than
    * one is found (e.g. a duplicated/ghost language server).
    */
   singletonExpected?: boolean;
}

/** Map a raw command line to a {@link ProcessRole}. A head supplies this to label its own processes. */
export type ProcessClassifier = (cmdline: string) => ProcessRole;

/** Generic fallback: every process is shown under the app heading, labelled by its (truncated) command line. */
const defaultProcessClassifier: ProcessClassifier = cmdline => ({ role: cmdline ? cmdline.slice(0, 60) : 'process', isApp: true });

/** Read /proc for every visible process: pid, ppid, RSS, and a command label. */
function readAllProcs(): RawProc[] {
   const procs: RawProc[] = [];
   let entries: string[] = [];
   try {
      entries = fs.readdirSync('/proc');
   } catch {
      return procs;
   }
   for (const entry of entries) {
      if (!/^\d+$/.test(entry)) {
         continue;
      }
      let status = '';
      try {
         status = fs.readFileSync(`/proc/${entry}/status`, 'utf8');
      } catch {
         continue;
      }
      const rssMatch = status.match(/^VmRSS:\s+(\d+)\s+kB/m);
      if (!rssMatch) {
         continue;
      }
      const ppid = Number(status.match(/^PPid:\s+(\d+)/m)?.[1] ?? 0);
      let label = '';
      try {
         label = fs.readFileSync(`/proc/${entry}/cmdline`, 'utf8').replace(/\0/g, ' ').trim();
      } catch {
         // fall back to the process name from status below.
      }
      if (!label) {
         label = status.match(/^Name:\s+(.+)$/m)?.[1] ?? `pid ${entry}`;
      }
      procs.push({ pid: Number(entry), ppid, rssBytes: Number(rssMatch[1]) * 1024, label });
   }
   return procs;
}

/**
 * Sum and list per-process RSS. When {@link rootPid} is given, restrict to that process and its
 * descendants (the app's own process tree), which keeps the figure meaningful in local dev where
 * /proc otherwise shows the whole machine. In a container's PID namespace the tree is effectively
 * all the pod's processes anyway.
 */
function collectProcessRss(rootPid?: number): { total: number; processes: ProcInfo[]; scoped: boolean } {
   const all = readAllProcs();
   let selected: RawProc[] = all;
   let scoped = false;
   if (rootPid !== undefined) {
      const childrenByPpid = new Map<number, RawProc[]>();
      for (const proc of all) {
         (childrenByPpid.get(proc.ppid) ?? childrenByPpid.set(proc.ppid, []).get(proc.ppid)!).push(proc);
      }
      const tree: RawProc[] = [];
      const queue = all.filter(proc => proc.pid === rootPid);
      while (queue.length > 0) {
         const proc = queue.shift()!;
         tree.push(proc);
         queue.push(...(childrenByPpid.get(proc.pid) ?? []));
      }
      if (tree.length > 0) {
         selected = tree;
         scoped = true;
      }
   }
   const total = selected.reduce((sum, proc) => sum + proc.rssBytes, 0);
   selected.sort((a, b) => b.rssBytes - a.rssBytes);
   return { total, processes: selected, scoped };
}

/** Options for {@link formatPodMemory}. */
export interface PodMemoryOptions {
   /** Map a process command line to a readable role; lets a head label its own processes. */
   classify?: ProcessClassifier;
   /** Heading for the in-app process group (default `Application`). */
   appLabel?: string;
}

/**
 * Format a pod/container-level memory snapshot read from the cgroup this process belongs to
 * (cgroup v2 `memory.current`/`peak`/`max`/`stat`, falling back to cgroup v1). This is the figure
 * the Kubernetes OOM-killer watches — it covers every process in the pod plus page cache and kernel
 * memory, so it is higher than any single `process.memoryUsage().rss`. Also sums per-process RSS so
 * the per-process split is visible. Explains itself when no cgroup memory controller is present
 * (e.g. local dev outside a container).
 */
export function formatPodMemory(options: PodMemoryOptions = {}): string {
   const classify = options.classify ?? defaultProcessClassifier;
   const appLabel = options.appLabel ?? 'Application';
   const lines: string[] = ['Pod memory snapshot:'];

   const v2Current = path.join(CGROUP_ROOT, 'memory.current');
   const v1Usage = path.join(CGROUP_ROOT, 'memory', 'memory.usage_in_bytes');

   if (fs.existsSync(v2Current)) {
      const current = readNumber(v2Current);
      const peak = readNumber(path.join(CGROUP_ROOT, 'memory.peak'));
      const max = readNumber(path.join(CGROUP_ROOT, 'memory.max'));
      const stat = readKeyedBytes(path.join(CGROUP_ROOT, 'memory.stat'));
      lines.push('  cgroup    v2');
      lines.push(`  current   ${current !== undefined ? Format.bytes(current) : 'n/a'}`);
      lines.push(`  peak      ${peak !== undefined ? Format.bytes(peak) : 'n/a (kernel too old for memory.peak)'}`);
      lines.push(`  limit     ${max === Number.POSITIVE_INFINITY ? 'unlimited' : max !== undefined ? Format.bytes(max) : 'n/a'}`);
      if (Object.keys(stat).length > 0) {
         lines.push(
            `  breakdown anon ${Format.bytes(stat.anon ?? 0)} (heaps/stacks), file ${Format.bytes(stat.file ?? 0)} (page cache), ` +
               `kernel ${Format.bytes(stat.kernel ?? stat.slab ?? 0)}, sock ${Format.bytes(stat.sock ?? 0)}`
         );
      }
   } else if (fs.existsSync(v1Usage)) {
      const v1 = path.join(CGROUP_ROOT, 'memory');
      const current = readNumber(v1Usage);
      const peak = readNumber(path.join(v1, 'memory.max_usage_in_bytes'));
      const limit = readNumber(path.join(v1, 'memory.limit_in_bytes'));
      const stat = readKeyedBytes(path.join(v1, 'memory.stat'));
      lines.push('  cgroup    v1');
      lines.push(`  current   ${current !== undefined ? Format.bytes(current) : 'n/a'}`);
      lines.push(`  peak      ${peak !== undefined ? Format.bytes(peak) : 'n/a'}`);
      // v1 reports a huge sentinel for "unlimited"; treat anything >= 2^60 as unlimited.
      lines.push(`  limit     ${limit !== undefined && limit < 2 ** 60 ? Format.bytes(limit) : 'unlimited'}`);
      if (Object.keys(stat).length > 0) {
         lines.push(
            `  breakdown rss ${Format.bytes(stat.rss ?? 0)}, cache ${Format.bytes(stat.cache ?? 0)} (page cache), ` +
               `kernel ${Format.bytes(stat.kernel ?? 0)}`
         );
      }
   } else {
      lines.push('  cgroup    no memory controller under /sys/fs/cgroup (not running in a container?)');
   }

   // Root at this process so local dev reports only the app's tree, not the whole machine.
   const { processes } = collectProcessRss(process.pid);
   if (processes.length > 0) {
      const classified = processes.map(proc => ({ ...proc, ...classify(proc.label) }));
      const appProcs = classified.filter(proc => proc.isApp);
      const otherProcs = classified.filter(proc => !proc.isApp);
      const appTotal = appProcs.reduce((sum, proc) => sum + proc.rssBytes, 0);

      lines.push('');
      lines.push(`  ${appLabel}: ${Format.bytes(appTotal)} across ${appProcs.length} process(es)`);
      for (const proc of appProcs) {
         lines.push(`    ${Format.bytes(proc.rssBytes).padStart(10)}  ${proc.role}  (pid ${proc.pid})`);
      }
      const singletonCounts = new Map<string, number>();
      for (const proc of appProcs) {
         if (proc.singletonExpected) {
            singletonCounts.set(proc.role, (singletonCounts.get(proc.role) ?? 0) + 1);
         }
      }
      for (const [role, count] of singletonCounts) {
         if (count > 1) {
            lines.push(`  WARNING: ${count} instances of "${role}" running - likely ghost process(es); expected 1`);
         }
      }
      if (otherProcs.length > 0) {
         const otherTotal = otherProcs.reduce((sum, proc) => sum + proc.rssBytes, 0);
         lines.push(`  Other (tooling/debugger, not counted above): ${Format.bytes(otherTotal)} across ${otherProcs.length} process(es)`);
      }
      lines.push('  Note: in a real pod the cgroup figure above is the OOM ceiling; this per-process');
      lines.push('  split is for attribution. Local dev may include debugger processes (excluded here).');
   }

   return lines.join('\n');
}
