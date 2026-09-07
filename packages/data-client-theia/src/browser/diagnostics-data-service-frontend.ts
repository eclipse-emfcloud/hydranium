/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import type {
   DataServerDiagnosticsProtocol,
   DumpServerStateArgs,
   LatencyReport,
   StartProfilingArgs,
   StopProfilingArgs,
   WriteServerHeapSnapshotArgs
} from '@hydranium/protocol';
import { AbstractDataServiceFrontend } from './data-service-frontend';

/**
 * {@link AbstractDataServiceFrontend} specialised for a server that also exposes
 * the framework {@link DataServerDiagnosticsProtocol} (which the framework
 * `DataServer` implements by default). It implements each diagnostics method as
 * a readiness-gated pass-through — `await this.ensureConnected()`, then delegate
 * to `this.server` — so every adopter frontend gets the memory / state /
 * profiling / latency surface without hand-writing identical one-liner bodies.
 *
 * Extend this instead of {@link AbstractDataServiceFrontend} whenever the head's
 * `DataServer` keeps the default diagnostics registration; the `TServer` bound
 * carries `DataServerDiagnosticsProtocol`, so the delegates are type-checked
 * (no casts). A head that dropped the diagnostics methods via
 * `DataServerOptions.excludedMethods` should extend the plain base instead.
 */
export abstract class AbstractDiagnosticsDataServiceFrontend<
   TServer extends { waitForReady(): Promise<void> } & DataServerDiagnosticsProtocol,
   TClient extends object
>
   extends AbstractDataServiceFrontend<TServer, TClient>
   implements DataServerDiagnosticsProtocol
{
   async dumpServerState(args: DumpServerStateArgs): Promise<string> {
      await this.ensureConnected();
      return this.server.dumpServerState(args);
   }

   async writeHeapSnapshot(args: WriteServerHeapSnapshotArgs): Promise<string> {
      await this.ensureConnected();
      return this.server.writeHeapSnapshot(args);
   }

   async dumpPodMemory(): Promise<string> {
      await this.ensureConnected();
      return this.server.dumpPodMemory();
   }

   async startProfiling(args: StartProfilingArgs): Promise<void> {
      await this.ensureConnected();
      return this.server.startProfiling(args);
   }

   async stopProfiling(args: StopProfilingArgs): Promise<string> {
      await this.ensureConnected();
      return this.server.stopProfiling(args);
   }

   async getLatency(): Promise<LatencyReport> {
      await this.ensureConnected();
      return this.server.getLatency();
   }
}
