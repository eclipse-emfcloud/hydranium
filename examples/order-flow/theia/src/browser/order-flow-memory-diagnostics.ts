/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { type MemoryDiagnosticsService } from '@hydranium/client-theia/lib/browser';
import type {
   DumpServerStateArgs,
   LatencyReport,
   StartProfilingArgs,
   StopProfilingArgs,
   WriteServerHeapSnapshotArgs
} from '@hydranium/protocol';
import { inject, injectable } from '@theia/core/shared/inversify';
import { OrderFlowDataConnection } from './order-flow-data-connection';

/**
 * The data head's process diagnostics, over the frontend's one connection.
 *
 * Every method carries no `clientId`, so this needs no session — it reads the
 * shared proxy per call, which is what keeps it correct across a reconnect.
 *
 * Sharing the connection also fixes a pairing the two-connection arrangement got
 * wrong: the server holds an active profile capture per connection, so a start
 * on one and a stop on the other rejected with "no capture is active" while one
 * was running.
 */
@injectable()
export class OrderFlowMemoryDiagnostics implements MemoryDiagnosticsService {
   @inject(OrderFlowDataConnection) protected readonly connection!: OrderFlowDataConnection;

   async dumpServerState(args: DumpServerStateArgs): Promise<string> {
      return (await this.connection.connected()).dumpServerState(args);
   }

   async writeHeapSnapshot(args: WriteServerHeapSnapshotArgs): Promise<string> {
      return (await this.connection.connected()).writeHeapSnapshot(args);
   }

   async dumpPodMemory(): Promise<string> {
      return (await this.connection.connected()).dumpPodMemory();
   }

   async startProfiling(args: StartProfilingArgs): Promise<void> {
      return (await this.connection.connected()).startProfiling(args);
   }

   async stopProfiling(args: StopProfilingArgs): Promise<string> {
      return (await this.connection.connected()).stopProfiling(args);
   }

   async getLatency(): Promise<LatencyReport> {
      return (await this.connection.connected()).getLatency();
   }
}
