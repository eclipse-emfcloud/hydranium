/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import type { LatencyReport, ProfileCaptureOptions } from '@hydranium/protocol';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
   assembleProfilingManifest,
   DEFAULT_PROFILE_E2E_ENV,
   e2eProfilingServerEnv,
   type E2EProfilingHooks,
   finishE2EProfiling,
   isE2EProfilingEnabled,
   startE2EProfiling,
   withE2EProfiling
} from '../../../src/testing/playwright/e2e-profiling.js';
import type { CdpSession, EvaluatablePage } from '../../../src/testing/playwright/browser-capture-bridge.js';
import { DEFAULT_LATENCY_ENV } from '../../../src/node/latency-from-env.js';

const CAPTURED_BROWSER_STATE = {
   runtime: { source: 'performance.memory', after: { jsHeapUsedBytes: 10, jsHeapTotalBytes: 20, jsHeapLimitBytes: 40 } },
   timeline: [{ name: 'jank', entryType: 'longtask', startTimeMs: 5, durationMs: 120 }]
};

/** A fake page whose `evaluate` returns the canned browser state (the bridge's page function is not really run). */
function fakePage(): EvaluatablePage {
   return {
      async evaluate<R>(): Promise<R> {
         return CAPTURED_BROWSER_STATE as R;
      }
   };
}

/** A fake CDP session: getMetrics returns the canned counters, takeHeapSnapshot emits one chunk. */
function fakeCdp(metrics: Record<string, number> = { Nodes: 25 }): CdpSession {
   const listeners = new Map<string, ((payload: unknown) => void)[]>();
   return {
      async send(method: string): Promise<unknown> {
         if (method === 'Performance.getMetrics') {
            return { metrics: Object.entries(metrics).map(([name, value]) => ({ name, value })) };
         }
         if (method === 'HeapProfiler.takeHeapSnapshot') {
            for (const handler of listeners.get('HeapProfiler.addHeapSnapshotChunk') ?? []) {
               handler({ chunk: '{}' });
            }
         }
         return {};
      },
      on(event: string, handler: (payload: unknown) => void): void {
         listeners.set(event, [...(listeners.get(event) ?? []), handler]);
      },
      off(event: string, handler: (payload: unknown) => void): void {
         listeners.set(
            event,
            (listeners.get(event) ?? []).filter(existing => existing !== handler)
         );
      }
   };
}

const EMPTY_LATENCY: LatencyReport = {
   windowMs: 123,
   methods: [{ method: 'data-server/getProjects', count: 3, p50Ms: 1, p99Ms: 2, maxMs: 2, totalMs: 4 }]
};

/** Recording hooks standing in for an adopter's model-service RPC calls. */
function recordingHooks(): E2EProfilingHooks & { started?: ProfileCaptureOptions; stoppedDir?: string; latencyCalls: number } {
   return {
      latencyCalls: 0,
      async startProfiling(options: ProfileCaptureOptions): Promise<void> {
         this.started = options;
      },
      async stopProfiling(directory: string): Promise<string> {
         this.stoppedDir = directory;
         // Simulate the server writing a profile artefact into the shared session dir.
         writeFileSync(join(directory, 'server.cpuprofile'), JSON.stringify({ nodes: [], samples: [], timeDeltas: [] }));
         return 'Profile report (server)';
      },
      async getLatency(): Promise<LatencyReport> {
         this.latencyCalls++;
         return EMPTY_LATENCY;
      }
   };
}

describe('assembleProfilingManifest', () => {
   let dir: string;
   beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'hydranium-e2e-'));
   });
   afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
   });

   it('indexes the gathered artefacts and writes manifest.json', () => {
      writeFileSync(join(dir, 'server.cpuprofile'), '{}');
      writeFileSync(join(dir, 'server.cpuprofile.txt'), 'CPU self-time digest');
      writeFileSync(join(dir, 'server-latency.json'), '{}');
      writeFileSync(join(dir, 'server.log'), 'log line\n');
      writeFileSync(join(dir, 'browser-console.log'), '[browser] [warning] x\n');
      writeFileSync(join(dir, 'browser-runtime.json'), '{}');
      writeFileSync(join(dir, 'browser-timeline.json'), '[]');
      const manifest = assembleProfilingManifest(dir, { commit: 'abc123', workspace: '/ws' });
      const kinds = manifest.artifacts.map(artifact => artifact.kind).sort();
      expect(kinds).toEqual(['browser-console', 'browser-runtime', 'browser-timeline', 'server-cpu', 'server-latency', 'server-log']);
      const cpu = manifest.artifacts.find(artifact => artifact.kind === 'server-cpu');
      expect(cpu?.digest).toBe('server.cpuprofile.txt');
      expect(manifest.environment).toMatchObject({ mode: 'app', commit: 'abc123', workspace: '/ws', node: process.version });
      expect(manifest.sessionId).toBe(basename(dir));
      const onDisk = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
      expect(onDisk.artifacts.some((artifact: { kind: string }) => artifact.kind === 'browser-runtime')).toBe(true);
   });

   it('does not index the manifest itself or loose digest text files as artefacts', () => {
      writeFileSync(join(dir, 'server.log'), 'x\n');
      const manifest = assembleProfilingManifest(dir);
      // Re-assembling must not pick up the manifest.json it just wrote.
      const again = assembleProfilingManifest(dir);
      expect(again.artifacts.some(artifact => artifact.path === 'manifest.json')).toBe(false);
      expect(manifest.artifacts.map(artifact => artifact.kind)).toEqual(['server-log']);
   });

   it('indexes a browser .heapsnapshot distinctly from the server heap snapshot', () => {
      writeFileSync(join(dir, 'browser-heap.heapsnapshot'), '{}');
      writeFileSync(join(dir, 'server-heap.heapsnapshot'), '{}');
      writeFileSync(join(dir, 'browser-runtime.json'), '{}');
      const manifest = assembleProfilingManifest(dir);
      const kinds = manifest.artifacts.map(artifact => artifact.kind).sort();
      expect(kinds).toEqual(['browser-heap', 'browser-runtime', 'server-heap']);
   });
});

describe('finishE2EProfiling', () => {
   let dir: string;
   beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'hydranium-e2e-'));
   });
   afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
   });

   it('stops server profiling into the session dir, writes latency + browser state, and assembles a manifest', async () => {
      const hooks = recordingHooks();
      const manifest = await finishE2EProfiling({ page: fakePage(), sessionDir: dir, hooks });
      expect(hooks.stoppedDir).toBe(dir);
      expect(hooks.latencyCalls).toBe(1);
      expect(JSON.parse(readFileSync(join(dir, 'server-latency.json'), 'utf8')).methods[0].method).toBe('data-server/getProjects');
      expect(JSON.parse(readFileSync(join(dir, 'browser-runtime.json'), 'utf8')).source).toBe('performance.memory');
      const kinds = manifest.artifacts.map(artifact => artifact.kind).sort();
      expect(kinds).toEqual(['browser-runtime', 'browser-timeline', 'server-cpu', 'server-latency']);
   });

   it('grades browser-runtime to two-point cdp-performance with a delta via CDP', async () => {
      const manifest = await finishE2EProfiling({
         page: fakePage(),
         sessionDir: dir,
         hooks: recordingHooks(),
         cdp: fakeCdp({ Nodes: 25, JSHeapUsedSize: 500 }),
         browserRuntimeBefore: { nodes: 10, jsHeapUsedBytes: 300 }
      });
      const report = JSON.parse(readFileSync(join(dir, 'browser-runtime.json'), 'utf8'));
      expect(report.source).toBe('cdp-performance');
      expect(report.after).toMatchObject({ nodes: 25, jsHeapUsedBytes: 500 });
      expect(report.before).toMatchObject({ nodes: 10, jsHeapUsedBytes: 300 });
      expect(report.delta).toMatchObject({ nodes: 15, jsHeapUsedBytes: 200 });
      // CDP has no heap-limit metric — the performance.memory ceiling from the page
      // read (fakePage's canned runtime) is folded into the CDP after-sample.
      expect(report.after.jsHeapLimitBytes).toBe(40);
      expect(report.delta.jsHeapLimitBytes).toBeUndefined();
      expect(manifest.artifacts.map(artifact => artifact.kind)).toContain('browser-runtime');
   });

   it('writes only the after sample when no prior runtime sample was captured', async () => {
      await finishE2EProfiling({ page: fakePage(), sessionDir: dir, hooks: recordingHooks(), cdp: fakeCdp({ Nodes: 9 }) });
      const report = JSON.parse(readFileSync(join(dir, 'browser-runtime.json'), 'utf8'));
      expect(report.after.nodes).toBe(9);
      expect(report.before).toBeUndefined();
      expect(report.delta).toBeUndefined();
   });

   it('captures a browser heap snapshot when browserHeapSnapshot is set', async () => {
      const manifest = await finishE2EProfiling({
         page: fakePage(),
         sessionDir: dir,
         hooks: recordingHooks(),
         cdp: fakeCdp(),
         browserHeapSnapshot: true
      });
      expect(manifest.artifacts.map(artifact => artifact.kind)).toContain('browser-heap');
   });

   it('folds a given server.log and browser-console.log into the bundle', async () => {
      const externalServerLog = join(dir, 'src-server.log');
      const externalBrowserLog = join(dir, 'src-browser.log');
      writeFileSync(externalServerLog, 'backend line\n');
      writeFileSync(externalBrowserLog, '[browser] [warning] frontend line\n');
      const manifest = await finishE2EProfiling({
         page: fakePage(),
         sessionDir: dir,
         hooks: recordingHooks(),
         serverLogPath: externalServerLog,
         browserLogPath: externalBrowserLog
      });
      expect(readFileSync(join(dir, 'server.log'), 'utf8')).toBe('backend line\n');
      expect(readFileSync(join(dir, 'browser-console.log'), 'utf8')).toContain('frontend line');
      const kinds = manifest.artifacts.map(artifact => artifact.kind).sort();
      expect(kinds).toContain('server-log');
      expect(kinds).toContain('browser-console');
   });
});

describe('startE2EProfiling', () => {
   let dir: string;
   beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'hydranium-e2e-'));
   });
   afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
   });

   it('empties a reused session dir before capture so stale artefacts do not accumulate', async () => {
      writeFileSync(join(dir, 'server-cpu.cpuprofile'), '{}');
      writeFileSync(join(dir, 'manifest.json'), '{}');
      const hooks = recordingHooks();
      await startE2EProfiling({ page: fakePage(), sessionDir: dir, hooks });
      expect(existsSync(join(dir, 'server-cpu.cpuprofile'))).toBe(false);
      expect(existsSync(join(dir, 'manifest.json'))).toBe(false);
      expect(existsSync(dir)).toBe(true);
   });
});

describe('withE2EProfiling', () => {
   let dir: string;
   const previous = process.env[DEFAULT_PROFILE_E2E_ENV];
   beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'hydranium-e2e-'));
   });
   afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
      if (previous === undefined) {
         delete process.env[DEFAULT_PROFILE_E2E_ENV];
      } else {
         process.env[DEFAULT_PROFILE_E2E_ENV] = previous;
      }
   });

   it('brackets the scenario between start and finish when enabled', async () => {
      process.env[DEFAULT_PROFILE_E2E_ENV] = '1';
      expect(isE2EProfilingEnabled()).toBe(true);
      const hooks = recordingHooks();
      const order: string[] = [];
      const manifest = await withE2EProfiling({ page: fakePage(), sessionDir: dir, hooks }, async () => {
         order.push('scenario');
         expect(hooks.started).toBeDefined();
      });
      expect(order).toEqual(['scenario']);
      expect(hooks.stoppedDir).toBe(dir);
      expect(manifest?.artifacts.some(artifact => artifact.kind === 'server-latency')).toBe(true);
   });

   it('runs the scenario without capturing when disabled', async () => {
      delete process.env[DEFAULT_PROFILE_E2E_ENV];
      const hooks = recordingHooks();
      let ran = false;
      const manifest = await withE2EProfiling({ page: fakePage(), sessionDir: dir, hooks }, async () => {
         ran = true;
      });
      expect(ran).toBe(true);
      expect(manifest).toBeUndefined();
      expect(hooks.started).toBeUndefined();
      expect(hooks.stoppedDir).toBeUndefined();
   });

   it('still assembles the bundle and re-throws when the scenario throws', async () => {
      process.env[DEFAULT_PROFILE_E2E_ENV] = '1';
      const hooks = recordingHooks();
      await expect(
         withE2EProfiling({ page: fakePage(), sessionDir: dir, hooks }, async () => {
            throw new Error('scenario boom');
         })
      ).rejects.toThrow('scenario boom');
      // finish still ran: the bundle was assembled for the failing run.
      expect(hooks.stoppedDir).toBe(dir);
      expect(existsSync(join(dir, 'manifest.json'))).toBe(true);
   });

   it('re-throws the scenario error, not a teardown failure that follows it', async () => {
      process.env[DEFAULT_PROFILE_E2E_ENV] = '1';
      const hooks = recordingHooks();
      hooks.stopProfiling = async (): Promise<string> => {
         throw new Error('teardown boom');
      };
      // The real assertion failure must win over a profiling-infra failure in finish.
      await expect(
         withE2EProfiling({ page: fakePage(), sessionDir: dir, hooks }, async () => {
            throw new Error('scenario boom');
         })
      ).rejects.toThrow('scenario boom');
   });

   it('propagates a teardown failure when the scenario itself succeeded', async () => {
      process.env[DEFAULT_PROFILE_E2E_ENV] = '1';
      const hooks = recordingHooks();
      hooks.stopProfiling = async (): Promise<string> => {
         throw new Error('teardown boom');
      };
      await expect(withE2EProfiling({ page: fakePage(), sessionDir: dir, hooks }, async () => undefined)).rejects.toThrow('teardown boom');
   });
});

describe('e2eProfilingServerEnv', () => {
   it('returns nothing when profiling is off, so an unconditional spread is inert', () => {
      expect(e2eProfilingServerEnv({})).toEqual({});
   });

   it('turns the latency seam on alongside the profiling flag', () => {
      // `finishE2EProfiling` reads latency over RPC, but the collector answering
      // it is installed from this env in the SERVER process — a child inherits
      // only what its launcher hands it, so profiling alone yields an empty
      // `server-latency.json` rather than an error.
      expect(e2eProfilingServerEnv({ [DEFAULT_PROFILE_E2E_ENV]: '1' })).toEqual({
         [DEFAULT_PROFILE_E2E_ENV]: '1',
         [DEFAULT_LATENCY_ENV]: '1'
      });
   });

   it('passes an explicitly-set latency value through instead of overwriting it', () => {
      expect(e2eProfilingServerEnv({ [DEFAULT_PROFILE_E2E_ENV]: 'session-7', [DEFAULT_LATENCY_ENV]: 'verbose' })).toEqual({
         [DEFAULT_PROFILE_E2E_ENV]: 'session-7',
         [DEFAULT_LATENCY_ENV]: 'verbose'
      });
   });
});
