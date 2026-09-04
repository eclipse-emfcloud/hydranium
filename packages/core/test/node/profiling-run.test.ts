/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import * as fs from 'node:fs';
import type * as NodeFs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DEFAULT_LOG_FILE_ENV, LatencyCollector } from '@hydranium/protocol';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ProfilingRun, recordServerSummaryEntry } from '../../src/node/profiling-run.js';
import type { ProfileReport } from '../../src/node/profile-capture.js';

/**
 * The container probe reads two cgroup paths off the real filesystem, so on any
 * given host it answers the same way whatever the code does — which is why a
 * `typeof … === 'boolean'` assertion is all a live-fs test can honestly make.
 * The mock delegates to the real module and exists only so `existsSync` can be
 * driven to both answers; every test restores it.
 */
vi.mock('node:fs', async importOriginal => {
   const actual = await importOriginal<typeof NodeFs>();
   return { ...actual, existsSync: vi.fn(actual.existsSync) };
});

afterEach(async () => {
   const actual = await vi.importActual<typeof NodeFs>('node:fs');
   vi.mocked(fs.existsSync).mockImplementation(actual.existsSync);
});

/** A light CPU-using, allocating, yielding block — enough for the inspector to see something. */
async function workload(): Promise<number> {
   let acc = 0;
   for (let index = 0; index < 10; index++) {
      const arr = new Array<number>(10_000).fill(index);
      for (const value of arr) {
         acc += value;
      }
      await new Promise(resolve => setTimeout(resolve, 2));
   }
   return acc;
}

describe('ProfilingRun', () => {
   let parent: string;
   beforeAll(() => {
      parent = fs.mkdtempSync(path.join(os.tmpdir(), 'hydranium-run-'));
   });
   afterAll(() => {
      fs.rmSync(parent, { recursive: true, force: true });
   });

   it('creates a timestamped session directory under the given parent', async () => {
      const run = await ProfilingRun.start({ directory: parent });
      expect(fs.existsSync(run.directory)).toBe(true);
      expect(path.dirname(run.directory)).toBe(parent);
      expect(path.basename(run.directory)).toMatch(/^profiling-/);
      await run.finish();
   });

   it('creates a missing parent directory given explicitly rather than falling back to temp', async () => {
      const explicit = path.join(parent, 'nested', 'out');
      const run = await ProfilingRun.start({ directory: explicit, sessionId: 'profiling-explicit' });
      expect(run.directory).toBe(path.join(explicit, 'profiling-explicit'));
      expect(fs.existsSync(run.directory)).toBe(true);
      await run.finish();
   });

   it('captures a window and records its cpu profile as a session-relative artifact', async () => {
      const run = await ProfilingRun.start({ directory: parent, sessionId: 'profiling-cpu', capture: { cpu: true } });
      const result = await run.window('build', workload);
      expect(typeof result).toBe('number');
      const manifest = await run.finish();
      const cpu = manifest.artifacts.find(artifact => artifact.kind === 'server-cpu');
      expect(cpu).toBeDefined();
      expect(cpu!.window).toBe('build');
      expect(path.isAbsolute(cpu!.path)).toBe(false);
      expect(fs.existsSync(path.join(run.directory, cpu!.path))).toBe(true);
   });

   it('writes manifest.json with schemaVersion, sessionId, environment and artifacts', async () => {
      const run = await ProfilingRun.start({
         directory: parent,
         sessionId: 'profiling-fixed',
         mode: 'app',
         container: true,
         commit: 'abc123',
         workspace: '/ws',
         capture: { cpu: true }
      });
      await run.window('build', workload);
      const manifest = await run.finish();
      expect(manifest.schemaVersion).toBe(1);
      expect(manifest.sessionId).toBe('profiling-fixed');
      expect(manifest.environment).toMatchObject({
         mode: 'app',
         container: true,
         commit: 'abc123',
         workspace: '/ws',
         node: process.version
      });
      expect(manifest.environment.windows).toEqual([{ label: 'build', ms: expect.any(Number) }]);
      expect(manifest.artifacts.some(artifact => artifact.kind === 'server-summary' && artifact.path === 'server-summary.json')).toBe(true);
      const onDisk = JSON.parse(fs.readFileSync(path.join(run.directory, 'manifest.json'), 'utf8'));
      expect(onDisk.sessionId).toBe('profiling-fixed');
   });

   it('records multiple windows in one session', async () => {
      const run = await ProfilingRun.start({ directory: parent, sessionId: 'profiling-multi', capture: { allocation: true } });
      await run.window('cold', workload);
      await run.window('churn', workload);
      const manifest = await run.finish();
      expect(manifest.environment.windows.map(window => window.label)).toEqual(['cold', 'churn']);
      const allocs = manifest.artifacts.filter(artifact => artifact.kind === 'server-alloc');
      expect(allocs.map(artifact => artifact.window).sort()).toEqual(['churn', 'cold']);
   });

   it('writes a server-summary.json holding each window report', async () => {
      const run = await ProfilingRun.start({ directory: parent, sessionId: 'profiling-summary', capture: { cpu: true } });
      await run.window('build', workload);
      const manifest = await run.finish();
      const summary = JSON.parse(fs.readFileSync(path.join(run.directory, 'server-summary.json'), 'utf8'));

      // `typeof … === 'number'` degenerates "holds the window's report" to "the
      // key exists". Tying the entry back to the manifest's own record of the
      // window is what makes an empty or mismatched entry visible.
      expect(Object.keys(summary)).toEqual(['build']);
      expect(summary.build.durationMs).toBe(manifest.environment.windows[0].ms);
      expect(summary.build.cpuProfilePath).toContain('server-cpu');
      expect(summary.build.cpuUsage).toMatchObject({ userMs: expect.any(Number), systemMs: expect.any(Number) });
   });

   it('defaults mode to harness and derives node from the running process', async () => {
      const run = await ProfilingRun.start({ directory: parent, sessionId: 'profiling-default' });
      const manifest = await run.finish();
      expect(manifest.environment.mode).toBe('harness');
      expect(manifest.environment.node).toBe(process.version);
   });

   it('derives container from the cgroup memory controller when not supplied', async () => {
      // `typeof … === 'boolean'` is satisfied by `return false` as readily as by
      // the probe, and on a bare CI host the probe answers `false` anyway — so
      // the cgroup paths have to be stubbed for either answer to mean anything.
      for (const present of ['/sys/fs/cgroup/memory.current', '/sys/fs/cgroup/memory/memory.usage_in_bytes']) {
         vi.mocked(fs.existsSync).mockImplementation(target => target === present);
         const run = await ProfilingRun.start({ directory: parent, sessionId: `profiling-cgroup-${path.basename(present)}` });
         const manifest = await run.finish();
         expect(manifest.environment.container).toBe(true);
      }

      vi.mocked(fs.existsSync).mockImplementation(() => false);
      const absent = await ProfilingRun.start({ directory: parent, sessionId: 'profiling-cgroup-absent' });
      expect((await absent.finish()).environment.container).toBe(false);
   });

   it('lets an explicit container: false win over the probe', async () => {
      // `??`, not `||`: an adopter that knows it is not containerised must be
      // able to say so even where the cgroup files exist.
      vi.mocked(fs.existsSync).mockImplementation(() => true);
      const run = await ProfilingRun.start({ directory: parent, sessionId: 'profiling-not-container', container: false });
      expect((await run.finish()).environment.container).toBe(false);
   });

   it('emits a cpu digest beside the profile and points the artifact at it', async () => {
      const run = await ProfilingRun.start({ directory: parent, sessionId: 'profiling-digest', capture: { cpu: true } });
      await run.window('build', workload);
      const manifest = await run.finish();
      const cpu = manifest.artifacts.find(artifact => artifact.kind === 'server-cpu');
      expect(cpu!.digest).toBeDefined();
      expect(path.isAbsolute(cpu!.digest!)).toBe(false);
      const digestText = fs.readFileSync(path.join(run.directory, cpu!.digest!), 'utf8');
      expect(digestText).toContain('CPU self-time');
   });

   it('writes server-latency.json and a server-latency artifact when a collector is attached', async () => {
      const latency = new LatencyCollector();
      latency.record('data-server/getProjects', 5);
      const run = await ProfilingRun.start({ directory: parent, sessionId: 'profiling-latency', latency });
      const manifest = await run.finish();
      const artifact = manifest.artifacts.find(entry => entry.kind === 'server-latency');
      expect(artifact?.path).toBe('server-latency.json');
      const written = JSON.parse(fs.readFileSync(path.join(run.directory, 'server-latency.json'), 'utf8'));
      expect(written.methods.some((methodLatency: { method: string }) => methodLatency.method === 'data-server/getProjects')).toBe(true);
   });

   it('omits the server-latency artifact when no collector is attached', async () => {
      const run = await ProfilingRun.start({ directory: parent, sessionId: 'profiling-nolatency' });
      const manifest = await run.finish();
      expect(manifest.artifacts.some(entry => entry.kind === 'server-latency')).toBe(false);
   });

   it('points HYDRANIUM_LOG_FILE at the session server.log and records the artifact when logging occurred', async () => {
      const run = await ProfilingRun.start({ directory: parent, sessionId: 'profiling-serverlog' });
      expect(process.env[DEFAULT_LOG_FILE_ENV]).toBe(path.join(run.directory, 'server.log'));
      // Simulate the head having logged during the run (the real tee writes here).
      fs.writeFileSync(run.serverLogPath, 'log line\n');
      const manifest = await run.finish();
      expect(manifest.artifacts.some(entry => entry.kind === 'server-log' && entry.path === 'server.log')).toBe(true);
   });

   it('omits the server-log artifact when nothing was logged, and restores the previous log env', async () => {
      const before = process.env[DEFAULT_LOG_FILE_ENV];
      const run = await ProfilingRun.start({ directory: parent, sessionId: 'profiling-nolog' });
      const manifest = await run.finish();
      expect(manifest.artifacts.some(entry => entry.kind === 'server-log')).toBe(false);
      expect(process.env[DEFAULT_LOG_FILE_ENV]).toBe(before);
   });

   it('attaches an arbitrary json artifact into the session', async () => {
      const run = await ProfilingRun.start({ directory: parent, sessionId: 'profiling-attach' });
      run.attach('server-memory-report', 'server-memory-report.json', { docs: 5 });
      const manifest = await run.finish();
      expect(manifest.artifacts.find(entry => entry.kind === 'server-memory-report')?.path).toBe('server-memory-report.json');
      expect(JSON.parse(fs.readFileSync(path.join(run.directory, 'server-memory-report.json'), 'utf8')).docs).toBe(5);
   });

   it('rejects a window after the run is finished', async () => {
      const run = await ProfilingRun.start({ directory: parent, sessionId: 'profiling-closed' });
      await run.finish();
      await expect(run.window('late', workload)).rejects.toThrow();
   });
});

describe('recordServerSummaryEntry', () => {
   let dir: string;
   beforeAll(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hydranium-summary-'));
   });
   afterAll(() => {
      fs.rmSync(dir, { recursive: true, force: true });
   });

   const report = (durationMs: number): ProfileReport => ({
      durationMs,
      cpuUsage: { userMs: 1, systemMs: 1 },
      memoryDelta: { rssBytes: 10, heapUsedBytes: 5 }
   });

   it('writes server-summary.json keyed by window label (empty label → app)', () => {
      recordServerSummaryEntry(dir, '', report(100));
      const summary = JSON.parse(fs.readFileSync(path.join(dir, 'server-summary.json'), 'utf8'));
      expect(summary.app.durationMs).toBe(100);
   });

   it('merges a second window into the existing summary rather than overwriting', () => {
      recordServerSummaryEntry(dir, 'churn', report(42));
      const summary = JSON.parse(fs.readFileSync(path.join(dir, 'server-summary.json'), 'utf8'));
      expect(summary.app.durationMs).toBe(100);
      expect(summary.churn.durationMs).toBe(42);
   });
});
