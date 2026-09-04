/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import {
   formatLatencyReport,
   type DataServerDiagnosticsProtocol,
   type HostDiagnosticsProtocol,
   type StartProfilingArgs
} from '@hydranium/protocol';
import { captureBrowserRuntime, formatBrowserRuntime } from './browser-capture';
import { CommandContribution, MessageService, type Command, type CommandRegistry } from '@theia/core';
import { inject, injectable, optional, type interfaces } from '@theia/core/shared/inversify';
import { OutputChannelManager, type OutputChannel } from '@theia/output/lib/browser/output-channel';

/**
 * Per-product branding for {@link MemoryDiagnosticsContribution}. Bound by the
 * adopter so the command ids, palette category, and output channel carry the
 * product name. The framework supplies the behaviour; only these strings vary.
 */
export interface MemoryDiagnosticsOptions {
   /** Prefix for the registered command ids: `<commandIdPrefix>.dumpServerState`. */
   readonly commandIdPrefix: string;
   /** Command-palette category. */
   readonly category: string;
   /** Output channel the full snapshots are appended to (View > Output). */
   readonly channelName: string;
}
export const MemoryDiagnosticsOptions = Symbol('MemoryDiagnosticsOptions');

/**
 * The server-process diagnostics the commands call. Equals
 * {@link DataServerDiagnosticsProtocol} (`dumpServerState` / `writeHeapSnapshot`
 * / `dumpPodMemory`); the adopter binds its data-server frontend proxy (which
 * exposes those methods after connecting) to this symbol. Kept as a distinct
 * symbol so the contribution stays decoupled from any concrete frontend type.
 */
export type MemoryDiagnosticsService = DataServerDiagnosticsProtocol;
export const MemoryDiagnosticsService = Symbol('MemoryDiagnosticsService');

/**
 * Optional host (parent) process diagnostics — the Theia backend itself, reached
 * by an ordinary in-process RPC service ({@link HostDiagnosticsProtocol}), NOT
 * the data-server socket. When bound, the contribution adds the "Dump Backend
 * State" and "Write Heap Snapshot (Backend)" commands; left unbound, those two
 * commands are simply not registered. `@hydranium/data-client-theia`'s
 * `bindHostDiagnostics` binds the frontend proxy.
 */
export type HostMemoryDiagnosticsService = HostDiagnosticsProtocol;
export const HostMemoryDiagnosticsService = Symbol('HostMemoryDiagnosticsService');

/**
 * Memory-diagnostics commands, one per layer reachable from the frontend. Full
 * multi-line snapshots are appended to the configured output channel; a one-line
 * summary is toasted.
 *  - "Dump Server State"      - the data-server process (heap/rss/event-loop/CPU/documents), via RPC.
 *  - "Dump Pod Memory"        - cgroup current/peak/limit + process-tree RSS (the figure that OOMs a pod), via RPC.
 *  - "Dump Frontend State"    - the browser tab's JS heap (Chrome `performance.memory`), client-side.
 *  - "Write Heap Snapshot"    - a V8 heap snapshot of the data-server process, via RPC.
 *  - "Start/Stop Profiling"   - a windowed CPU/allocation/GC/event-loop sampled profile of the data-server, via RPC.
 *  - "Record Performance Profile" - the same, wrapped over a fixed window (start, wait, stop, report).
 *  - "Dump RPC/LSP Latency"   - per-method latency/throughput collected on the server, via RPC.
 *
 * Generic: the adopter binds {@link MemoryDiagnosticsOptions} (branding) and
 * {@link MemoryDiagnosticsService} (its connected data-server frontend) and adds
 * this class as a `CommandContribution` — see {@link bindMemoryDiagnostics}.
 */
@injectable()
export class MemoryDiagnosticsContribution implements CommandContribution {
   @inject(MemoryDiagnosticsService) protected readonly diagnostics: MemoryDiagnosticsService;
   @inject(MemoryDiagnosticsOptions) protected readonly options: MemoryDiagnosticsOptions;
   @inject(MessageService) protected readonly messageService: MessageService;
   @inject(OutputChannelManager) protected readonly channels: OutputChannelManager;
   @inject(HostMemoryDiagnosticsService) @optional() protected readonly hostDiagnostics?: HostMemoryDiagnosticsService;

   /** Dimensions the profiling commands capture — the server samples only what is named. */
   protected readonly profileDimensions: StartProfilingArgs = { cpu: true, allocation: true, gc: true, eventLoopDelay: true };
   /** Window length for the "Record Performance Profile" command. */
   protected readonly recordDurationMs = 10_000;
   /**
    * Label of the stop-profiling command, and of the action its start toast
    * offers. One field for both: two literals naming one command can be
    * localized apart, leaving a button or an instruction that names a command
    * the user cannot find.
    */
   protected readonly stopProfilingLabel: string = 'Stop Profiling (Server)';

   registerCommands(registry: CommandRegistry): void {
      const { category } = this.options;
      registry.registerCommand(this.command('dumpServerState', 'Dump Server State', category), {
         execute: () => this.report('server state', () => this.diagnostics.dumpServerState({ label: new Date().toISOString() }), ['heap'])
      });
      registry.registerCommand(this.command('dumpPodMemory', 'Dump Pod Memory', category), {
         execute: () => this.report('pod memory', () => this.diagnostics.dumpPodMemory(), ['current', 'rss sum'])
      });
      registry.registerCommand(this.command('dumpFrontendState', 'Dump Frontend State', category), {
         execute: () => this.dumpFrontendState()
      });
      registry.registerCommand(this.command('writeHeapSnapshot', 'Write Heap Snapshot (Server)', category), {
         execute: () => this.writeSnapshot('server', label => this.diagnostics.writeHeapSnapshot({ label }))
      });
      // Sampled profiling of the server process — sampling does NOT pause it (unlike
      // the heap snapshot). Start/Stop are the manual pair; Record wraps a fixed window.
      registry.registerCommand(this.command('startProfiling', 'Start Profiling (Server)', category), {
         execute: () => this.startProfiling()
      });
      registry.registerCommand(this.command('stopProfiling', this.stopProfilingLabel, category), {
         execute: () => this.stopProfiling()
      });
      registry.registerCommand(
         this.command('recordProfile', `Record Performance Profile (Server, ${Math.round(this.recordDurationMs / 1000)}s)`, category),
         {
            execute: () => this.recordProfile()
         }
      );
      registry.registerCommand(this.command('dumpLatency', 'Dump RPC/LSP Latency (Server)', category), {
         execute: () => this.report('RPC/LSP latency', async () => formatLatencyReport(await this.diagnostics.getLatency()), ['window'])
      });
      // Host (Theia backend) process commands — registered only when the
      // optional host-diagnostics service is bound (see HostMemoryDiagnosticsService).
      const hostDiagnostics = this.hostDiagnostics;
      if (hostDiagnostics) {
         registry.registerCommand(this.command('dumpBackendState', 'Dump Backend State', category), {
            execute: () => this.report('backend state', () => hostDiagnostics.dumpHostState({ label: new Date().toISOString() }), ['heap'])
         });
         registry.registerCommand(this.command('writeBackendHeapSnapshot', 'Write Heap Snapshot (Backend)', category), {
            execute: () => this.writeSnapshot('backend', label => hostDiagnostics.writeHostHeapSnapshot({ label }))
         });
      }
   }

   protected command(id: string, label: string, category: string): Command {
      return { id: `${this.options.commandIdPrefix}.${id}`, label, category };
   }

   /** Run a snapshot call, append the full result to the channel, toast the first matching summary line. */
   protected async report(what: string, produce: () => Promise<string>, summaryKeys: string[]): Promise<void> {
      try {
         const snapshot = await produce();
         this.channel().appendLine(snapshot);
         this.channel().appendLine('');
         this.messageService.info(this.summarize(snapshot, what, summaryKeys), { timeout: 5000 });
      } catch (error) {
         this.messageService.error(`Failed to dump ${what}: ${this.errorMessage(error)}`);
      }
   }

   protected async writeSnapshot(target: string, produce: (label: string) => Promise<string>): Promise<void> {
      try {
         this.messageService.info(`Writing ${target} heap snapshot — this briefly pauses that process...`, { timeout: 3000 });
         const filePath = await produce(new Date().toISOString());
         this.channel().appendLine(`Heap snapshot (${target}) written to ${filePath}`);
         this.messageService.info(`Heap snapshot (${target}) written to ${filePath}`, { timeout: 8000 });
      } catch (error) {
         this.messageService.error(`Failed to write ${target} heap snapshot: ${this.errorMessage(error)}`);
      }
   }

   /** Begin an open-ended capture; the toast's stop action ends it and reports. */
   protected async startProfiling(): Promise<void> {
      try {
         await this.diagnostics.startProfiling(this.profileDimensions);
      } catch (error) {
         this.messageService.error(`Failed to start profiling: ${this.errorMessage(error)}`);
         return;
      }
      // No timeout: the capture runs as long as the user wants it to, and an
      // auto-dismissing toast takes the stop affordance with it. Awaiting the
      // toast is what keeps the action live, so this resolves only once the
      // user acts on it or dismisses it.
      const chosen = await this.messageService.info(
         'Server profiling started — sampling does not stop the process.',
         { timeout: 0 },
         this.stopProfilingLabel
      );
      if (chosen === this.stopProfilingLabel) {
         await this.stopProfiling();
      }
   }

   /** End the capture and report it. Shared, so the toast action and the command cannot diverge in behaviour. */
   protected stopProfiling(): Promise<void> {
      return this.report('profile', () => this.diagnostics.stopProfiling({ label: new Date().toISOString() }), ['duration']);
   }

   /** Capture a fixed-length window: start, wait, stop, and report the result. */
   protected async recordProfile(): Promise<void> {
      try {
         await this.diagnostics.startProfiling(this.profileDimensions);
      } catch (error) {
         this.messageService.error(`Failed to start profiling: ${this.errorMessage(error)}`);
         return;
      }
      this.messageService.info(`Recording a ${Math.round(this.recordDurationMs / 1000)}s server performance profile...`, { timeout: 4000 });
      await this.delay(this.recordDurationMs);
      await this.stopProfiling();
   }

   /** Isolated so tests can drive the record window without a real timer. */
   protected delay(ms: number): Promise<void> {
      return new Promise(resolve => setTimeout(resolve, ms));
   }

   protected async dumpFrontendState(): Promise<void> {
      const text = formatBrowserRuntime(await captureBrowserRuntime());
      this.channel().appendLine(text);
      this.messageService.info(text, { timeout: 6000 });
   }

   protected channel(): OutputChannel {
      const channel = this.channels.getChannel(this.options.channelName);
      channel.show({ preserveFocus: true });
      return channel;
   }

   /** Pull the first line starting with one of `keys` for a one-line toast; full text is in the channel. */
   protected summarize(snapshot: string, what: string, keys: string[]): string {
      const lines = snapshot.split('\n');
      for (const key of keys) {
         const line = lines.find(entry => entry.trim().startsWith(key));
         if (line) {
            return `Captured ${what} —${line.replace(new RegExp(`^\\s*${key}\\s*`), ` ${key} `)}`;
         }
      }
      return `Captured ${what} (see the ${this.options.channelName} output channel)`;
   }

   protected errorMessage(error: unknown): string {
      return error instanceof Error ? error.message : String(error);
   }
}

/**
 * Bind {@link MemoryDiagnosticsContribution} as a `CommandContribution` with the
 * given branding. The adopter still binds {@link MemoryDiagnosticsService} to its
 * connected data-server frontend separately (the framework cannot — the concrete
 * frontend is adopter-defined). Call from a Theia frontend `ContainerModule`.
 */
export function bindMemoryDiagnostics(bind: interfaces.Bind, options: MemoryDiagnosticsOptions): void {
   bind(MemoryDiagnosticsOptions).toConstantValue(options);
   bind(MemoryDiagnosticsContribution).toSelf().inSingletonScope();
   bind(CommandContribution).toService(MemoryDiagnosticsContribution);
}
