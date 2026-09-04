/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/*
 * Compact, token-sized top-N text digests of the V8 sampled profiles a
 * ProfileCapture produces — the entry point a Claude skill reads instead of the
 * large raw profile JSON. Dependency-free top-N aggregation by design: the raw
 * `.cpuprofile` / `.heapprofile` are still emitted for the human DevTools path
 * (flamegraphs, drill-down); this only derives the "where did the time / bytes
 * go" summary, which is a self-time / self-size sum a skill can act on.
 */

import { Format } from '@hydranium/protocol';

export const DEFAULT_DIGEST_TOP_N = 15;

/** A V8 profile call frame (the subset the digests read). */
export interface DigestCallFrame {
   functionName: string;
   url: string;
   lineNumber: number;
}

/** A V8 CPU profile (`Profiler.stop` output — the subset the digest reads). */
export interface CpuProfile {
   nodes: { id: number; callFrame: DigestCallFrame }[];
   samples: number[];
   timeDeltas: number[];
}

/** A node of a V8 sampling-heap allocation profile. */
export interface AllocationNode {
   callFrame: DigestCallFrame;
   selfSize: number;
   children?: AllocationNode[];
}

/** A V8 sampling-heap allocation profile (`HeapProfiler.stopSampling` output). */
export interface AllocationProfile {
   head: AllocationNode;
}

export interface DigestOptions {
   /** How many functions to list (default {@link DEFAULT_DIGEST_TOP_N}). */
   topN?: number;
}

function basename(url: string): string {
   if (!url) {
      return 'native';
   }
   return url.split(/[/\\]/).pop() || url;
}

function frameKey(frame: DigestCallFrame): string {
   return `${frame.functionName || '(anonymous)'} (${basename(frame.url)}:${frame.lineNumber})`;
}

/** Render a ranked "self-metric by function" digest: the shared shape of both profile digests. */
function renderRanked(header: string, totals: Map<string, number>, topN: number, format: (value: number) => string): string {
   const total = [...totals.values()].reduce((sum, value) => sum + value, 0);
   const rows = [...totals.entries()].sort((a, b) => b[1] - a[1]).slice(0, topN);
   const lines = [`${header} — top ${rows.length} of ${totals.size} functions (${format(total)} sampled)`];
   for (const [key, value] of rows) {
      const percent = total > 0 ? (value / total) * 100 : 0;
      lines.push(`  ${format(value).padStart(10)}  ${percent.toFixed(1).padStart(5)}%  ${key}`);
   }
   return lines.join('\n') + '\n';
}

/**
 * Top-N functions by CPU self-time, aggregated by call frame. Each `timeDeltas[i]`
 * (the interval preceding sample `i`) is charged to the frame sampled at `i`, which
 * preserves the total sampled time but attributes an interval to the sample at its
 * end rather than DevTools' preceding-sample convention — fine for an approximate
 * top-N ranking, but expect minor per-frame differences from the DevTools view.
 */
export function digestCpuProfile(profile: CpuProfile, options: DigestOptions = {}): string {
   const frameById = new Map<number, DigestCallFrame>();
   for (const node of profile.nodes) {
      frameById.set(node.id, node.callFrame);
   }
   const microsByFrame = new Map<string, number>();
   profile.samples.forEach((nodeId, index) => {
      const frame = frameById.get(nodeId);
      if (frame) {
         microsByFrame.set(frameKey(frame), (microsByFrame.get(frameKey(frame)) ?? 0) + (profile.timeDeltas[index] ?? 0));
      }
   });
   return renderRanked('CPU self-time', microsByFrame, options.topN ?? DEFAULT_DIGEST_TOP_N, micros => `${(micros / 1000).toFixed(1)}ms`);
}

/** Top-N functions by allocation self-size, walking the sampling-heap tree and aggregating by call frame. */
export function digestAllocationProfile(profile: AllocationProfile, options: DigestOptions = {}): string {
   const bytesByFrame = new Map<string, number>();
   const visit = (node: AllocationNode): void => {
      if (node.selfSize > 0) {
         bytesByFrame.set(frameKey(node.callFrame), (bytesByFrame.get(frameKey(node.callFrame)) ?? 0) + node.selfSize);
      }
      for (const child of node.children ?? []) {
         visit(child);
      }
   };
   visit(profile.head);
   return renderRanked('Allocation', bytesByFrame, options.topN ?? DEFAULT_DIGEST_TOP_N, bytes => Format.bytes(bytes));
}
