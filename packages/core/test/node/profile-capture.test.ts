/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import * as fs from 'node:fs';
import { Session } from 'node:inspector';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
   formatProfileReport,
   ProfileCapture,
   profileWorkload,
   summarizeEventLoopDelay,
   summarizeGc,
   type ProfileReport
} from '../../src/node/profile-capture.js';

/** A CPU-using, allocating, event-loop-yielding block so real captures see samples, GC, and ELD. */
async function busyWorkload(): Promise<number> {
   let acc = 0;
   const sink: number[][] = [];
   for (let index = 0; index < 40; index++) {
      const arr = new Array<number>(50_000).fill(index);
      for (const value of arr) {
         acc += value;
      }
      if (index % 4 === 0) {
         sink.length = 0;
      }
      sink.push(arr);
      await new Promise(resolve => setTimeout(resolve, 2));
   }
   return acc;
}

describe('summarizeGc (pure)', () => {
   it('maps numeric V8 gc kinds to names and tallies count + pause per kind', () => {
      const summary = summarizeGc([
         { kind: 1, durationMs: 2 },
         { kind: 1, durationMs: 3 },
         { kind: 4, durationMs: 10 }
      ]);
      expect(summary.count).toBe(3);
      expect(summary.totalPauseMs).toBe(15);
      expect(summary.byKind.scavenge).toEqual({ count: 2, pauseMs: 5 });
      expect(summary.byKind['mark-sweep-compact']).toEqual({ count: 1, pauseMs: 10 });
   });

   it('falls back to the numeric flag as a string for an unknown kind', () => {
      const summary = summarizeGc([{ kind: 99, durationMs: 1 }]);
      expect(summary.byKind['99']).toEqual({ count: 1, pauseMs: 1 });
   });

   it('returns a zero summary for no entries', () => {
      const summary = summarizeGc([]);
      expect(summary).toEqual({ count: 0, totalPauseMs: 0, byKind: {} });
   });
});

describe('summarizeEventLoopDelay (pure)', () => {
   it('converts histogram nanoseconds to milliseconds', () => {
      const eld = summarizeEventLoopDelay({
         count: 5,
         mean: 2_000_000,
         max: 8_000_000,
         percentile: percent => (percent === 99 ? 7_000_000 : 1_000_000)
      });
      expect(eld).toEqual({ meanMs: 2, p50Ms: 1, p99Ms: 7, maxMs: 8 });
   });

   it('returns undefined when the histogram recorded nothing (guards NaN)', () => {
      expect(summarizeEventLoopDelay({ count: 0, mean: NaN, max: 0, percentile: () => NaN })).toBeUndefined();
   });
});

describe('formatProfileReport (pure)', () => {
   const fullReport: ProfileReport = {
      durationMs: 1230,
      cpuProfilePath: '/tmp/cpu-build.cpuprofile',
      allocationProfilePath: '/tmp/alloc-build.heapprofile',
      gc: { count: 5, totalPauseMs: 42, byKind: { scavenge: { count: 3, pauseMs: 12 }, 'mark-sweep-compact': { count: 2, pauseMs: 30 } } },
      eventLoopDelay: { meanMs: 1.2, p50Ms: 0.9, p99Ms: 5, maxMs: 8 },
      cpuUsage: { userMs: 120, systemMs: 30 },
      memoryDelta: { rssBytes: 12 * 1024 * 1024, heapUsedBytes: 4 * 1024 * 1024 }
   };

   it('renders duration, cpu usage, memory delta, gc, event loop, and artefact paths', () => {
      const text = formatProfileReport(fullReport);
      expect(text).toContain('Profile report:');
      expect(text).toContain('user 120ms / system 30ms');
      expect(text).toContain('rss +12.0MB');
      expect(text).toContain('heapUsed +4.00MB');
      expect(text).toContain('scavenge ×3');
      expect(text).toContain('mark-sweep-compact ×2');
      expect(text).toContain('mean 1.2ms');
      expect(text).toContain('/tmp/cpu-build.cpuprofile');
      expect(text).toContain('/tmp/alloc-build.heapprofile');
   });

   it('signs a negative memory delta with a minus', () => {
      const text = formatProfileReport({ ...fullReport, memoryDelta: { rssBytes: -5 * 1024 * 1024, heapUsedBytes: 0 } });
      expect(text).toContain('rss -5.00MB');
   });

   it('uses a supplied label as the heading and omits absent dimensions', () => {
      const text = formatProfileReport(
         { durationMs: 10, cpuUsage: { userMs: 1, systemMs: 2 }, memoryDelta: { rssBytes: 0, heapUsedBytes: 0 } },
         'churn'
      );
      expect(text).toContain('churn:');
      expect(text).not.toContain('gc ');
      expect(text).not.toContain('event loop');
      expect(text).not.toContain('cpu profile');
   });
});

describe('ProfileCapture / profileWorkload (real inspector session)', () => {
   let dir: string;
   beforeAll(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hydranium-profile-'));
   });
   afterAll(() => {
      fs.rmSync(dir, { recursive: true, force: true });
   });

   it('captures a well-formed cpu profile and allocation profile', async () => {
      const { report } = await profileWorkload({ cpu: true, allocation: true, directory: dir, label: 'busy' }, busyWorkload);
      expect(report.cpuProfilePath).toBeDefined();
      expect(report.allocationProfilePath).toBeDefined();
      const cpu = JSON.parse(fs.readFileSync(report.cpuProfilePath!, 'utf8'));
      expect(Array.isArray(cpu.nodes)).toBe(true);
      expect(cpu.nodes.length).toBeGreaterThan(0);
      expect(cpu.samples.length).toBeGreaterThan(0);
      const alloc = JSON.parse(fs.readFileSync(report.allocationProfilePath!, 'utf8'));
      expect(alloc.head).toBeDefined();
   });

   it('reports cpu usage in milliseconds and memory as a delta, not an absolute', async () => {
      // `typeof x === 'number'` passes on an arithmetic result by construction,
      // so it pins neither the microsecond→millisecond divide nor the
      // start-vs-stop subtraction. These bounds do: dropping the `/1000` puts
      // cpu about a thousand times over the wall clock, and dropping the
      // subtraction reports the process's whole RSS instead of the window's
      // change. Both bounds are decades away from any plausible real value.
      const rssBefore = process.memoryUsage().rss;
      const { report } = await profileWorkload({ cpu: true, directory: dir, label: 'usage' }, busyWorkload);

      expect(report.durationMs).toBeGreaterThan(0);
      expect(report.cpuUsage.userMs).toBeGreaterThan(0);
      expect(report.cpuUsage.userMs + report.cpuUsage.systemMs).toBeLessThan(report.durationMs * 16);
      expect(Math.abs(report.memoryDelta.rssBytes)).toBeLessThan(rssBefore / 2);
      expect(Math.abs(report.memoryDelta.heapUsedBytes)).toBeLessThan(rssBefore / 2);
   });

   it('writes a heap snapshot when asked', async () => {
      const { report } = await profileWorkload({ heapSnapshot: true, directory: dir, label: 'snap' }, async () => 1);
      expect(report.heapSnapshotPath).toBeDefined();
      expect(fs.existsSync(report.heapSnapshotPath!)).toBe(true);
      expect(report.heapSnapshotPath!.endsWith('.heapsnapshot')).toBe(true);
   });

   it('reports gc using only mapped kind names', async () => {
      const { report } = await profileWorkload({ gc: true, directory: dir, label: 'gc' }, busyWorkload);
      expect(report.gc).toBeDefined();
      const known = new Set(['scavenge', 'mark-sweep-compact', 'incremental-marking', 'weak-callbacks']);
      for (const key of Object.keys(report.gc!.byKind)) {
         expect(known.has(key)).toBe(true);
      }
   });

   it('summarises the event-loop delay for a window that yields', async () => {
      const { report } = await profileWorkload({ eventLoopDelay: true, directory: dir, label: 'eld' }, busyWorkload);
      // Unconditional: an `if (report.eventLoopDelay)` wrapper makes the absent
      // case — the very case the NaN guard produces — pass silently.
      expect(report.eventLoopDelay).toBeDefined();
      expect(Number.isFinite(report.eventLoopDelay!.meanMs)).toBe(true);
      expect(Number.isFinite(report.eventLoopDelay!.p99Ms)).toBe(true);
   });

   it('omits the event-loop-delay summary for a purely synchronous window (the NaN guard)', async () => {
      // The NaN hazard exists ONLY here: the sampler is a 10ms timer, and a
      // window that never reaches the macrotask queue leaves the histogram at
      // `count === 0` / `mean === NaN`. The yielding fixture above cannot reach
      // this state, which is why it could not witness the guard.
      const { report } = await profileWorkload({ eventLoopDelay: true, directory: dir, label: 'eld-sync' }, async () => {
         let acc = 0;
         const until = Date.now() + 30;
         while (Date.now() < until) {
            acc++;
         }
         return acc;
      });

      expect(report.eventLoopDelay).toBeUndefined();
   });

   it('rejects a second concurrent capture and tracks isActive', async () => {
      const first = await ProfileCapture.start({ cpu: true });
      expect(ProfileCapture.isActive()).toBe(true);
      // The singleton guard's own message: `start` can reject for inspector
      // reasons that have nothing to do with a second concurrent capture.
      await expect(ProfileCapture.start({ cpu: true })).rejects.toThrow(/ProfileCapture is already active/);
      await first.stop(dir, 'cleanup');
      expect(ProfileCapture.isActive()).toBe(false);
   });

   it('releases the singleton after a successful workload', async () => {
      await profileWorkload({ cpu: true, directory: dir, label: 'release' }, async () => 1);
      expect(ProfileCapture.isActive()).toBe(false);
   });

   it('releases the singleton even when the workload throws', async () => {
      await expect(
         profileWorkload({ cpu: true, directory: dir, label: 'boom' }, async () => {
            throw new Error('boom');
         })
      ).rejects.toThrow('boom');
      expect(ProfileCapture.isActive()).toBe(false);
   });

   it('disconnects the session and releases the singleton when stop() fails to write', async () => {
      // A path whose parent is a FILE makes stop()'s mkdir/write throw — the error
      // path that must still disconnect the session and clear the active singleton.
      const blocker = path.join(dir, 'blocker-file');
      fs.writeFileSync(blocker, 'not a directory');
      const capture = await ProfileCapture.start({ cpu: true });
      const disconnectSpy = vi.spyOn(Session.prototype, 'disconnect');
      try {
         await expect(capture.stop(path.join(blocker, 'nested'), 'fail')).rejects.toThrow();
         expect(disconnectSpy, 'a failed stop() must disconnect the session').toHaveBeenCalled();
         expect(ProfileCapture.isActive()).toBe(false);
      } finally {
         disconnectSpy.mockRestore();
      }
      // The singleton is free: a subsequent capture starts and stops cleanly.
      const next = await ProfileCapture.start({ cpu: true });
      await next.stop(dir, 'after-stop-fail');
      expect(ProfileCapture.isActive()).toBe(false);
   });

   it('disconnects the session and releases the singleton when begin() fails', async () => {
      // Force the inspector round-trip to reject after the session connected — the
      // begin()-failure path that must tear the connected session down, not leak it.
      const failingPost = ((_method: string, _params: Record<string, unknown>, callback: (error: Error | null) => void): void =>
         callback(new Error('inspector down'))) as unknown as typeof Session.prototype.post;
      const postSpy = vi.spyOn(Session.prototype, 'post').mockImplementation(failingPost);
      const disconnectSpy = vi.spyOn(Session.prototype, 'disconnect');
      try {
         await expect(ProfileCapture.start({ cpu: true })).rejects.toThrow('inspector down');
         expect(disconnectSpy, 'a failed begin() must disconnect the connected session').toHaveBeenCalled();
         expect(ProfileCapture.isActive()).toBe(false);
      } finally {
         postSpy.mockRestore();
         disconnectSpy.mockRestore();
      }
      // With the inspector healthy again, a real capture starts and stops cleanly.
      const next = await ProfileCapture.start({ cpu: true });
      await next.stop(dir, 'after-begin-fail');
      expect(ProfileCapture.isActive()).toBe(false);
   });
});
