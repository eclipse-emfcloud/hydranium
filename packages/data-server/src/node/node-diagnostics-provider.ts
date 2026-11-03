/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import type { ServerSharedServices } from '@hydranium/core';
import { formatProfileReport, formatServerState, ProfileCapture, recordServerSummaryEntry } from '@hydranium/core/node';
import { formatPodMemory, writeHeapSnapshotToDir } from '@hydranium/protocol/node';
import type { DumpServerStateArgs, StartProfilingArgs, StopProfilingArgs, WriteServerHeapSnapshotArgs } from '@hydranium/protocol';
import type { DataServerDiagnosticsProvider, DataServerProfileCapture } from '../diagnostics-provider.js';

/**
 * The Node implementation of the data head's diagnostics, and the reason this
 * subpath exists.
 *
 * Everything here needs a process to inspect — a V8 heap snapshot, an inspector
 * session, `process.memoryUsage()`, cgroup files — so it is server-only by
 * nature. Keeping it out of the package's portable `.` entry is what lets a
 * browser bundle the data head at all.
 *
 * Snapshots are computed in THIS process on purpose: the data-server child holds
 * the model store, so they reflect the heap that actually carries the workspace
 * AST/CST — the process that OOMs.
 */
class NodeProfileCapture implements DataServerProfileCapture {
   constructor(
      protected readonly capture: ProfileCapture,
      protected readonly directory: string
   ) {}

   async stop(args: StopProfilingArgs): Promise<string> {
      const report = await this.capture.stop(this.directory, args.label ?? '');
      recordServerSummaryEntry(this.directory, args.label ?? '', report);
      return formatProfileReport(report, args.label ? `Profile report (${args.label})` : undefined);
   }
}

/** Server-controlled destination for diagnostic artifacts. */
export interface NodeDataServerDiagnosticsOptions {
   /** A directory owned by the host. Omitted creates a private temporary directory on first use. Client directory arguments are ignored. */
   readonly directory?: string;
}

class NodeDataServerDiagnostics implements DataServerDiagnosticsProvider {
   protected outputDirectory: string | undefined;

   constructor(protected readonly options: NodeDataServerDiagnosticsOptions) {}

   protected directory(): string {
      const directory = this.outputDirectory ?? this.options.directory ?? mkdtempSync(join(tmpdir(), 'hydranium-diagnostics-'));
      // Cleanup can remove a previous destination. Prepare it on every use so
      // artifact writers cannot fall back to the shared temporary directory.
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      this.outputDirectory = directory;
      return directory;
   }

   async dumpServerState(services: ServerSharedServices, args: DumpServerStateArgs): Promise<string> {
      const openDocuments = services.workspace.TextDocuments.openDocuments();
      return formatServerState(services.workspace, args.label, { openDocuments });
   }

   async writeHeapSnapshot(args: WriteServerHeapSnapshotArgs): Promise<string> {
      return writeHeapSnapshotToDir(this.directory(), args.label ?? '');
   }

   async dumpPodMemory(): Promise<string> {
      return formatPodMemory();
   }

   async startProfiling(args: StartProfilingArgs): Promise<DataServerProfileCapture> {
      // `ProfileCapture` is singleton-guarded — one inspector session per
      // process — so a second concurrent start rejects here rather than in the
      // caller, which is where the constraint actually lives.
      const directory = this.directory();
      return new NodeProfileCapture(await ProfileCapture.start(args), directory);
   }
}

/**
 * Enable process inspection on a connection the host has authorized for it.
 * Artifact destinations come from host options. Wire directory arguments cannot
 * grant filesystem access. The host must keep the output directory private,
 * since snapshots can contain secrets from every client in this process.
 */
export function nodeDataServerDiagnostics(options: NodeDataServerDiagnosticsOptions = {}): DataServerDiagnosticsProvider {
   return new NodeDataServerDiagnostics(options);
}

/**
 * The provider `--enable-diagnostics` asks for, writing to
 * `--diagnostics-directory <path>` when given, or `undefined` when the flag is
 * absent. A directory alone enables nothing. Other arguments are ignored, so
 * an entry passes its whole command line. An entry that parses `args` strictly
 * itself must declare both options too.
 */
export function diagnosticsFromArgs(args: readonly string[] = process.argv.slice(2)): DataServerDiagnosticsProvider | undefined {
   const { values, tokens } = parseArgs({
      args: [...args],
      options: { 'enable-diagnostics': { type: 'boolean' }, 'diagnostics-directory': { type: 'string' } },
      strict: false,
      allowPositionals: true,
      tokens: true
   });
   // Non-strict parsing types every value loosely and takes a following flag
   // as a value, so the shapes a strict parse rejects are checked here.
   const enabled = values['enable-diagnostics'];
   const directory = values['diagnostics-directory'];
   if (enabled !== undefined && typeof enabled !== 'boolean') {
      throw new Error('--enable-diagnostics takes no value');
   }
   const flagAsDirectory = tokens.some(
      token => token.kind === 'option' && token.name === 'diagnostics-directory' && !token.inlineValue && token.value?.startsWith('-')
   );
   if (flagAsDirectory || directory === '' || (directory !== undefined && typeof directory !== 'string')) {
      throw new Error('--diagnostics-directory requires a path');
   }
   // Resolved once, so a later working-directory change cannot move the output.
   return enabled ? nodeDataServerDiagnostics({ directory: directory === undefined ? undefined : resolve(directory) }) : undefined;
}
