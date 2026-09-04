/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

// Stub the Theia OutputChannel module before importing the SUT — the real module
// transitively pulls DOM globals unavailable under Vitest's node environment.
vi.mock('@theia/output/lib/browser/output-channel', () => ({
   OutputChannelManager: class OutputChannelManager {},
   OutputChannel: class OutputChannel {}
}));

import { describe, expect, it, vi } from 'vitest';
import {
   type HostMemoryDiagnosticsService,
   MemoryDiagnosticsContribution,
   type MemoryDiagnosticsOptions,
   type MemoryDiagnosticsService
} from '../../src/browser/memory-diagnostics-contribution';

interface FakeChannel {
   readonly lines: string[];
   appendLine(line: string): void;
   show(): void;
}
function makeChannels(): { getChannel(name: string): FakeChannel; channels: Map<string, FakeChannel> } {
   const channels = new Map<string, FakeChannel>();
   return {
      channels,
      getChannel(name: string): FakeChannel {
         let channel = channels.get(name);
         if (!channel) {
            channel = { lines: [], appendLine: (line: string) => channel!.lines.push(line), show: () => undefined };
            channels.set(name, channel);
         }
         return channel;
      }
   };
}

interface RegisteredCommand {
   command: { id: string; label: string; category?: string };
   handler: { execute: () => unknown };
}
function makeRegistry(): {
   registered: RegisteredCommand[];
   registerCommand: (command: RegisteredCommand['command'], handler: RegisteredCommand['handler']) => void;
} {
   const registered: RegisteredCommand[] = [];
   return { registered, registerCommand: (command, handler) => registered.push({ command, handler }) };
}

const OPTIONS: MemoryDiagnosticsOptions = { commandIdPrefix: 'test', category: 'Test', channelName: 'Test Memory' };

function makeContribution(
   diagnostics: Partial<MemoryDiagnosticsService>,
   hostDiagnostics?: Partial<HostMemoryDiagnosticsService>
): {
   contribution: MemoryDiagnosticsContribution;
   channels: ReturnType<typeof makeChannels>;
   messages: { info: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };
} {
   const channels = makeChannels();
   const messages = { info: vi.fn(), error: vi.fn() };
   const contribution = new MemoryDiagnosticsContribution();
   Object.assign(contribution, { diagnostics, hostDiagnostics, options: OPTIONS, channels, messageService: messages });
   return { contribution, channels, messages };
}

describe('MemoryDiagnosticsContribution', () => {
   it('registers branded commands for each diagnostics layer', () => {
      const { contribution } = makeContribution({});
      const registry = makeRegistry();
      contribution.registerCommands(registry as never);
      const ids = registry.registered.map(entry => entry.command.id);
      expect(ids).toEqual([
         'test.dumpServerState',
         'test.dumpPodMemory',
         'test.dumpFrontendState',
         'test.writeHeapSnapshot',
         'test.startProfiling',
         'test.stopProfiling',
         'test.recordProfile',
         'test.dumpLatency'
      ]);
      expect(registry.registered.every(entry => entry.command.category === 'Test')).toBe(true);
   });

   it('adds the backend (host) commands only when the host diagnostics service is bound', () => {
      const { contribution } = makeContribution({}, { dumpHostState: vi.fn(), writeHostHeapSnapshot: vi.fn() });
      const registry = makeRegistry();
      contribution.registerCommands(registry as never);
      const ids = registry.registered.map(entry => entry.command.id);
      expect(ids).toEqual([
         'test.dumpServerState',
         'test.dumpPodMemory',
         'test.dumpFrontendState',
         'test.writeHeapSnapshot',
         'test.startProfiling',
         'test.stopProfiling',
         'test.recordProfile',
         'test.dumpLatency',
         'test.dumpBackendState',
         'test.writeBackendHeapSnapshot'
      ]);
   });

   it('dumpBackendState appends the host snapshot to the channel and toasts a summary', async () => {
      const dumpHostState = vi.fn(async () => 'Host backend state:\n  heap      2.0 MB used');
      const { contribution, channels, messages } = makeContribution({}, { dumpHostState });
      const registry = makeRegistry();
      contribution.registerCommands(registry as never);

      await registry.registered.find(entry => entry.command.id === 'test.dumpBackendState')!.handler.execute();

      expect(dumpHostState).toHaveBeenCalledOnce();
      expect(channels.channels.get('Test Memory')?.lines.join('\n')).toContain('Host backend state');
      expect(messages.info).toHaveBeenCalled();
   });

   it('dumpServerState appends the snapshot to the channel and toasts a summary', async () => {
      const dumpServerState = vi.fn(async () => 'Server state snapshot:\n  heap      1.0 MB used');
      const { contribution, channels, messages } = makeContribution({ dumpServerState });
      const registry = makeRegistry();
      contribution.registerCommands(registry as never);

      await registry.registered.find(entry => entry.command.id === 'test.dumpServerState')!.handler.execute();

      expect(dumpServerState).toHaveBeenCalledOnce();
      expect(channels.channels.get('Test Memory')?.lines.join('\n')).toContain('Server state snapshot');
      expect(messages.info).toHaveBeenCalled();
   });

   it('startProfiling begins a capture and toasts (no pause wording)', async () => {
      const startProfiling = vi.fn(async () => undefined);
      const { contribution, messages } = makeContribution({ startProfiling });
      const registry = makeRegistry();
      contribution.registerCommands(registry as never);

      await registry.registered.find(entry => entry.command.id === 'test.startProfiling')!.handler.execute();

      expect(startProfiling).toHaveBeenCalledWith(expect.objectContaining({ cpu: true, allocation: true, gc: true, eventLoopDelay: true }));
      const toast = messages.info.mock.calls.map(call => String(call[0])).join(' ');
      expect(toast).toMatch(/profiling started/i);
      expect(toast).not.toMatch(/pause/i);
   });

   it('the start toast offers the stop action rather than naming the command in prose', async () => {
      const startProfiling = vi.fn(async () => undefined);
      const { contribution, messages } = makeContribution({ startProfiling });
      const registry = makeRegistry();
      contribution.registerCommands(registry as never);

      await registry.registered.find(entry => entry.command.id === 'test.startProfiling')!.handler.execute();

      // Exact text, not a `not.toContain`: the negative form passes just as well
      // on a toast that was never shown.
      expect(messages.info).toHaveBeenCalledOnce();
      const [text, options, ...actions] = messages.info.mock.calls[0];
      expect(text).toBe('Server profiling started — sampling does not stop the process.');
      expect(actions).toEqual([registry.registered.find(entry => entry.command.id === 'test.stopProfiling')!.command.label]);
      expect(options).toEqual({ timeout: 0 });
   });

   it('one label serves both the stop command and the toast action', async () => {
      const startProfiling = vi.fn(async () => undefined);
      const { contribution, messages } = makeContribution({ startProfiling });
      // Moving the single source of truth: two independent literals of equal
      // value satisfy an equality assertion, so only a mutation separates one
      // shared string from two that happen to agree.
      Object.assign(contribution, { stopProfilingLabel: 'Halt Sampling' });
      const registry = makeRegistry();
      contribution.registerCommands(registry as never);

      await registry.registered.find(entry => entry.command.id === 'test.startProfiling')!.handler.execute();

      expect(registry.registered.find(entry => entry.command.id === 'test.stopProfiling')!.command.label).toBe('Halt Sampling');
      expect(messages.info.mock.calls[0].slice(2)).toEqual(['Halt Sampling']);
   });

   it('choosing the start toast action runs the stop path to completion', async () => {
      const startProfiling = vi.fn(async () => undefined);
      const stopProfiling = vi.fn(async () => {
         // Settles on a macrotask, so a dispatch the command does not await
         // leaves the report undelivered when the command's own promise
         // resolves. A mock that settles within a microtask cannot tell the
         // two apart, because awaiting `execute()` drains those anyway.
         await new Promise(resolve => setTimeout(resolve, 0));
         return 'Profile report:\n  duration    4.20s';
      });
      const { contribution, channels, messages } = makeContribution({ startProfiling, stopProfiling });
      // Echoes back whichever action was offered, so an empty action list leaves
      // the choice undefined and the stop path unreached.
      messages.info.mockImplementation((...args: unknown[]) => Promise.resolve(args[2]));
      const registry = makeRegistry();
      contribution.registerCommands(registry as never);

      await registry.registered.find(entry => entry.command.id === 'test.startProfiling')!.handler.execute();

      expect(stopProfiling).toHaveBeenCalledOnce();
      // Defaulted rather than optional-chained to undefined: an undelivered
      // report leaves no channel at all, and `toContain` on undefined fails
      // with an argument-type complaint instead of naming what was missing.
      expect(channels.channels.get('Test Memory')?.lines.join('\n') ?? '').toContain('Profile report');
   });

   it('dismissing the start toast leaves the capture running', async () => {
      const startProfiling = vi.fn(async () => undefined);
      const stopProfiling = vi.fn(async () => 'Profile report:\n  duration    1.00s');
      const { contribution, messages } = makeContribution({ startProfiling, stopProfiling });
      messages.info.mockImplementation(() => Promise.resolve(undefined));
      const registry = makeRegistry();
      contribution.registerCommands(registry as never);

      await registry.registered.find(entry => entry.command.id === 'test.startProfiling')!.handler.execute();

      expect(stopProfiling).not.toHaveBeenCalled();
   });

   it('a failed start reports the error and offers no stop action', async () => {
      const startProfiling = vi.fn(async () => {
         throw new Error('inspector unavailable');
      });
      const { contribution, messages } = makeContribution({ startProfiling });
      const registry = makeRegistry();
      contribution.registerCommands(registry as never);

      await registry.registered.find(entry => entry.command.id === 'test.startProfiling')!.handler.execute();

      expect(messages.error).toHaveBeenCalledWith(expect.stringContaining('inspector unavailable'));
      expect(messages.info).not.toHaveBeenCalled();
   });

   it('stopProfiling appends the report to the channel and toasts a summary', async () => {
      const stopProfiling = vi.fn(async () => 'Profile report:\n  duration    1.23s');
      const { contribution, channels, messages } = makeContribution({ stopProfiling });
      const registry = makeRegistry();
      contribution.registerCommands(registry as never);

      await registry.registered.find(entry => entry.command.id === 'test.stopProfiling')!.handler.execute();

      expect(stopProfiling).toHaveBeenCalledOnce();
      expect(channels.channels.get('Test Memory')?.lines.join('\n')).toContain('Profile report');
      expect(messages.info).toHaveBeenCalled();
   });

   it('recordProfile starts, waits, stops, and reports', async () => {
      const startProfiling = vi.fn(async () => undefined);
      const stopProfiling = vi.fn(async () => 'Profile report:\n  duration    10.0s');
      const { contribution, channels } = makeContribution({ startProfiling, stopProfiling });
      Object.assign(contribution, { delay: () => Promise.resolve() });
      const registry = makeRegistry();
      contribution.registerCommands(registry as never);

      await registry.registered.find(entry => entry.command.id === 'test.recordProfile')!.handler.execute();

      expect(startProfiling).toHaveBeenCalledOnce();
      expect(stopProfiling).toHaveBeenCalledOnce();
      expect(channels.channels.get('Test Memory')?.lines.join('\n')).toContain('Profile report');
   });

   it('dumpLatency formats the report into the channel and toasts', async () => {
      const getLatency = vi.fn(async () => ({
         windowMs: 1000,
         methods: [{ method: 'data-server/getProjects', count: 3, p50Ms: 5, p99Ms: 9, maxMs: 9, totalMs: 18 }]
      }));
      const { contribution, channels, messages } = makeContribution({ getLatency });
      const registry = makeRegistry();
      contribution.registerCommands(registry as never);

      await registry.registered.find(entry => entry.command.id === 'test.dumpLatency')!.handler.execute();

      expect(getLatency).toHaveBeenCalledOnce();
      expect(channels.channels.get('Test Memory')?.lines.join('\n')).toContain('data-server/getProjects');
      expect(messages.info).toHaveBeenCalled();
   });

   it('dumpFrontendState uses the precise memory API when available', async () => {
      const perf = globalThis.performance as Performance & { measureUserAgentSpecificMemory?: unknown };
      perf.measureUserAgentSpecificMemory = async () => ({ bytes: 3 * 1024 * 1024, breakdown: [] });
      try {
         const { contribution, channels, messages } = makeContribution({});
         const registry = makeRegistry();
         contribution.registerCommands(registry as never);
         await registry.registered.find(entry => entry.command.id === 'test.dumpFrontendState')!.handler.execute();
         expect(channels.channels.get('Test Memory')?.lines.join('\n')).toContain('precise');
         expect(messages.info).toHaveBeenCalled();
      } finally {
         delete perf.measureUserAgentSpecificMemory;
      }
   });

   it('surfaces an error toast when a diagnostics call rejects', async () => {
      const dumpPodMemory = vi.fn(async () => {
         throw new Error('no cgroup');
      });
      const { contribution, messages } = makeContribution({ dumpPodMemory });
      const registry = makeRegistry();
      contribution.registerCommands(registry as never);

      await registry.registered.find(entry => entry.command.id === 'test.dumpPodMemory')!.handler.execute();

      expect(messages.error).toHaveBeenCalledWith(expect.stringContaining('no cgroup'));
   });
});
