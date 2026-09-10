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
import { CommandContribution, MessageService, nls, type Command, type CommandRegistry } from '@theia/core';
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
 * What a `report` call captured, as a code rather than a prose fragment. The
 * sentences it appears in are authored once per code, because a fragment
 * substituted into a sentence is itself translatable text and a translator
 * given the sentence alone cannot inflect around a hole.
 */
export type DiagnosticsSubject = 'server-state' | 'pod-memory' | 'latency' | 'backend-state' | 'profile';

/** Which process a heap snapshot is taken of; a code, for the reason {@link DiagnosticsSubject} is one. */
export type HeapSnapshotTarget = 'server' | 'backend';

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
   protected readonly stopProfilingLabel: string = nls.localize(
      'hydranium/client-theia/command-stop-profiling-server',
      'Stop Profiling (Server)'
   );

   registerCommands(registry: CommandRegistry): void {
      const { category } = this.options;
      registry.registerCommand(
         this.command({
            id: 'dumpServerState',
            label: nls.localize('hydranium/client-theia/command-dump-server-state', 'Dump Server State'),
            category
         }),
         {
            execute: () =>
               this.report('server-state', () => this.diagnostics.dumpServerState({ label: new Date().toISOString() }), ['heap'])
         }
      );
      registry.registerCommand(
         this.command({
            id: 'dumpPodMemory',
            label: nls.localize('hydranium/client-theia/command-dump-pod-memory', 'Dump Pod Memory'),
            category
         }),
         {
            execute: () => this.report('pod-memory', () => this.diagnostics.dumpPodMemory(), ['current', 'rss sum'])
         }
      );
      registry.registerCommand(
         this.command({
            id: 'dumpFrontendState',
            label: nls.localize('hydranium/client-theia/command-dump-frontend-state', 'Dump Frontend State'),
            category
         }),
         {
            execute: () => this.dumpFrontendState()
         }
      );
      registry.registerCommand(
         this.command({
            id: 'writeHeapSnapshot',
            label: nls.localize('hydranium/client-theia/command-write-heap-snapshot-server', 'Write Heap Snapshot (Server)'),
            category
         }),
         {
            execute: () => this.writeSnapshot('server', label => this.diagnostics.writeHeapSnapshot({ label }))
         }
      );
      // Sampled profiling of the server process — sampling does NOT pause it (unlike
      // the heap snapshot). Start/Stop are the manual pair; Record wraps a fixed window.
      registry.registerCommand(
         this.command({
            id: 'startProfiling',
            label: nls.localize('hydranium/client-theia/command-start-profiling-server', 'Start Profiling (Server)'),
            category
         }),
         {
            execute: () => this.startProfiling()
         }
      );
      registry.registerCommand(this.command({ id: 'stopProfiling', label: this.stopProfilingLabel, category }), {
         execute: () => this.stopProfiling()
      });
      registry.registerCommand(
         this.command({
            id: 'recordProfile',
            // The window length rides the substitution path rather than a
            // template literal: an extractor reads the source text, so an
            // interpolated default is never in the catalogue at all.
            label: nls.localize(
               'hydranium/client-theia/command-record-profile',
               'Record Performance Profile (Server, {0}s)',
               this.recordDurationSeconds()
            ),
            category
         }),
         {
            execute: () => this.recordProfile()
         }
      );
      registry.registerCommand(
         this.command({
            id: 'dumpLatency',
            label: nls.localize('hydranium/client-theia/command-dump-latency', 'Dump RPC/LSP Latency (Server)'),
            category
         }),
         {
            execute: () => this.report('latency', async () => formatLatencyReport(await this.diagnostics.getLatency()), ['window'])
         }
      );
      // Host (Theia backend) process commands — registered only when the
      // optional host-diagnostics service is bound (see HostMemoryDiagnosticsService).
      const hostDiagnostics = this.hostDiagnostics;
      if (hostDiagnostics) {
         registry.registerCommand(
            this.command({
               id: 'dumpBackendState',
               label: nls.localize('hydranium/client-theia/command-dump-backend-state', 'Dump Backend State'),
               category
            }),
            {
               execute: () =>
                  this.report('backend-state', () => hostDiagnostics.dumpHostState({ label: new Date().toISOString() }), ['heap'])
            }
         );
         registry.registerCommand(
            this.command({
               id: 'writeBackendHeapSnapshot',
               label: nls.localize('hydranium/client-theia/command-write-heap-snapshot-backend', 'Write Heap Snapshot (Backend)'),
               category
            }),
            {
               execute: () => this.writeSnapshot('backend', label => hostDiagnostics.writeHostHeapSnapshot({ label }))
            }
         );
      }
   }

   /**
    * Takes an object rather than positional arguments so that `label` — the one
    * user-facing member — is addressable by name. A lint rule guarding the
    * localization of labels has only syntax to work with, and a selector for an
    * argument position would equally catch `id`, which must stay a bare literal.
    */
   protected command(spec: { id: string; label: string; category: string }): Command {
      return { id: `${this.options.commandIdPrefix}.${spec.id}`, label: spec.label, category: spec.category };
   }

   /** The record window as whole seconds, for the label and the toast that must agree on it. */
   protected recordDurationSeconds(): number {
      return Math.round(this.recordDurationMs / 1000);
   }

   /** Run a snapshot call, append the full result to the channel, toast the first matching summary line. */
   protected async report(subject: DiagnosticsSubject, produce: () => Promise<string>, summaryKeys: string[]): Promise<void> {
      try {
         const snapshot = await produce();
         this.channel().appendLine(snapshot);
         this.channel().appendLine('');
         this.messageService.info(this.summarize(snapshot, subject, summaryKeys), { timeout: 5000 });
      } catch (error) {
         this.messageService.error(this.dumpFailedMessage(subject, this.errorMessage(error)));
      }
   }

   protected async writeSnapshot(target: HeapSnapshotTarget, produce: (label: string) => Promise<string>): Promise<void> {
      try {
         this.messageService.info(this.writingSnapshotMessage(target), { timeout: 3000 });
         const filePath = await produce(new Date().toISOString());
         // One sentence, shown in both places: two literals of equal value can be
         // localized apart, leaving the channel and the toast naming different files.
         const written = this.wroteSnapshotMessage(target, filePath);
         this.channel().appendLine(written);
         this.messageService.info(written, { timeout: 8000 });
      } catch (error) {
         this.messageService.error(this.writeSnapshotFailedMessage(target, this.errorMessage(error)));
      }
   }

   /** Begin an open-ended capture; the toast's stop action ends it and reports. */
   protected async startProfiling(): Promise<void> {
      try {
         await this.diagnostics.startProfiling(this.profileDimensions);
      } catch (error) {
         this.messageService.error(this.startProfilingFailedMessage(this.errorMessage(error)));
         return;
      }
      // No timeout: the capture runs as long as the user wants it to, and an
      // auto-dismissing toast takes the stop affordance with it. Awaiting the
      // toast is what keeps the action live, so this resolves only once the
      // user acts on it or dismisses it.
      const chosen = await this.messageService.info(
         nls.localize('hydranium/client-theia/profiling-started', 'Server profiling started — sampling does not stop the process.'),
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

   /** One authored sentence for both start paths; identical literals in two places drift apart under translation. */
   protected startProfilingFailedMessage(detail: string): string {
      return nls.localize('hydranium/client-theia/error-start-profiling', 'Failed to start profiling: {0}', detail);
   }

   /** Capture a fixed-length window: start, wait, stop, and report the result. */
   protected async recordProfile(): Promise<void> {
      try {
         await this.diagnostics.startProfiling(this.profileDimensions);
      } catch (error) {
         this.messageService.error(this.startProfilingFailedMessage(this.errorMessage(error)));
         return;
      }
      this.messageService.info(
         nls.localize(
            'hydranium/client-theia/recording-profile',
            'Recording a {0}s server performance profile...',
            this.recordDurationSeconds()
         ),
         { timeout: 4000 }
      );
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
   protected summarize(snapshot: string, subject: DiagnosticsSubject, keys: string[]): string {
      const lines = snapshot.split('\n');
      for (const key of keys) {
         const line = lines.find(entry => entry.trim().startsWith(key));
         if (line) {
            return this.capturedDetailMessage(subject, line.replace(new RegExp(`^\\s*${key}\\s*`), ` ${key} `));
         }
      }
      return this.capturedChannelMessage(subject);
   }

   /**
    * The captured-with-detail toast. The detail is a machine-formatted figure,
    * so it is safe as a substitution parameter; the subject is not, hence one
    * authored sentence per subject.
    */
   protected capturedDetailMessage(subject: DiagnosticsSubject, detail: string): string {
      switch (subject) {
         case 'server-state':
            return nls.localize('hydranium/client-theia/captured-server-state-detail', 'Captured server state —{0}', detail);
         case 'pod-memory':
            return nls.localize('hydranium/client-theia/captured-pod-memory-detail', 'Captured pod memory —{0}', detail);
         case 'latency':
            return nls.localize('hydranium/client-theia/captured-latency-detail', 'Captured RPC/LSP latency —{0}', detail);
         case 'backend-state':
            return nls.localize('hydranium/client-theia/captured-backend-state-detail', 'Captured backend state —{0}', detail);
         case 'profile':
            return nls.localize('hydranium/client-theia/captured-profile-detail', 'Captured profile —{0}', detail);
      }
   }

   /** The captured-without-detail toast; the channel name is adopter branding, not translatable text. */
   protected capturedChannelMessage(subject: DiagnosticsSubject): string {
      const channelName = this.options.channelName;
      switch (subject) {
         case 'server-state':
            return nls.localize(
               'hydranium/client-theia/captured-server-state-channel',
               'Captured server state (see the {0} output channel)',
               channelName
            );
         case 'pod-memory':
            return nls.localize(
               'hydranium/client-theia/captured-pod-memory-channel',
               'Captured pod memory (see the {0} output channel)',
               channelName
            );
         case 'latency':
            return nls.localize(
               'hydranium/client-theia/captured-latency-channel',
               'Captured RPC/LSP latency (see the {0} output channel)',
               channelName
            );
         case 'backend-state':
            return nls.localize(
               'hydranium/client-theia/captured-backend-state-channel',
               'Captured backend state (see the {0} output channel)',
               channelName
            );
         case 'profile':
            return nls.localize(
               'hydranium/client-theia/captured-profile-channel',
               'Captured profile (see the {0} output channel)',
               channelName
            );
      }
   }

   /** The failed-to-dump toast; the detail is a technical error string, safe as a parameter. */
   protected dumpFailedMessage(subject: DiagnosticsSubject, detail: string): string {
      switch (subject) {
         case 'server-state':
            return nls.localize('hydranium/client-theia/error-dump-server-state', 'Failed to dump server state: {0}', detail);
         case 'pod-memory':
            return nls.localize('hydranium/client-theia/error-dump-pod-memory', 'Failed to dump pod memory: {0}', detail);
         case 'latency':
            return nls.localize('hydranium/client-theia/error-dump-latency', 'Failed to dump RPC/LSP latency: {0}', detail);
         case 'backend-state':
            return nls.localize('hydranium/client-theia/error-dump-backend-state', 'Failed to dump backend state: {0}', detail);
         case 'profile':
            return nls.localize('hydranium/client-theia/error-dump-profile', 'Failed to dump profile: {0}', detail);
      }
   }

   protected writingSnapshotMessage(target: HeapSnapshotTarget): string {
      switch (target) {
         case 'server':
            return nls.localize(
               'hydranium/client-theia/writing-heap-snapshot-server',
               'Writing server heap snapshot — this briefly pauses that process...'
            );
         case 'backend':
            return nls.localize(
               'hydranium/client-theia/writing-heap-snapshot-backend',
               'Writing backend heap snapshot — this briefly pauses that process...'
            );
      }
   }

   protected wroteSnapshotMessage(target: HeapSnapshotTarget, filePath: string): string {
      switch (target) {
         case 'server':
            return nls.localize('hydranium/client-theia/wrote-heap-snapshot-server', 'Heap snapshot (server) written to {0}', filePath);
         case 'backend':
            return nls.localize('hydranium/client-theia/wrote-heap-snapshot-backend', 'Heap snapshot (backend) written to {0}', filePath);
      }
   }

   protected writeSnapshotFailedMessage(target: HeapSnapshotTarget, detail: string): string {
      switch (target) {
         case 'server':
            return nls.localize(
               'hydranium/client-theia/error-write-heap-snapshot-server',
               'Failed to write server heap snapshot: {0}',
               detail
            );
         case 'backend':
            return nls.localize(
               'hydranium/client-theia/error-write-heap-snapshot-backend',
               'Failed to write backend heap snapshot: {0}',
               detail
            );
      }
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
