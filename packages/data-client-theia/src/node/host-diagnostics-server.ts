/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { formatProcessMemory, writeHeapSnapshotToDir } from '@hydranium/protocol/node';
import {
   HOST_DIAGNOSTICS_PATH,
   type DumpHostStateArgs,
   type HostDiagnosticsProtocol,
   type WriteHostHeapSnapshotArgs
} from '@hydranium/protocol';
import { ConnectionHandler, RpcConnectionHandler } from '@theia/core';
import { ContainerModule, inject, injectable, optional } from '@theia/core/shared/inversify';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** What the host grants {@link HostDiagnosticsServer} beyond memory figures. */
export interface HostDiagnosticsOptions {
   /** Allow heap snapshots of the backend, which hold every client's data. Off by default. */
   readonly heapSnapshots?: boolean;
   /** A directory the host owns for snapshots. Omitted creates a private temporary one on first use. A client's directory is ignored. */
   readonly directory?: string;
}

/** The injection token for {@link HostDiagnosticsOptions}. */
export const HostDiagnosticsOptions = Symbol('HostDiagnosticsOptions');

/**
 * Host-process diagnostics, computed IN the Theia backend process this service
 * runs in (the parent / host, distinct from the data-server child that holds the
 * model store). Its memory figures are universal — `process.memoryUsage()`
 * always works — so the framework wires it by default. Heap snapshots wait for
 * {@link HostDiagnosticsOptions.heapSnapshots}. Each result is also written to the backend's
 * stdout so it reaches the pod log (`kubectl logs`), not only the RPC caller.
 */
@injectable()
export class HostDiagnosticsServer implements HostDiagnosticsProtocol {
   protected outputDirectory: string | undefined;

   // Injected rather than a constructor argument, so a subclass bound in its
   // place still resolves.
   @inject(HostDiagnosticsOptions) @optional() protected readonly options: HostDiagnosticsOptions = {};

   async dumpHostState(args: DumpHostStateArgs): Promise<string> {
      const snapshot = formatProcessMemory(args.label ? `Host backend state (${args.label})` : 'Host backend state');
      console.info(snapshot);
      return snapshot;
   }

   async writeHostHeapSnapshot(args: WriteHostHeapSnapshotArgs): Promise<string> {
      if (!this.options.heapSnapshots) {
         throw new Error('Backend heap snapshots are disabled by the host.');
      }
      const filePath = writeHeapSnapshotToDir(this.directory(), args.label ?? 'backend', 'heap-backend');
      console.info(`Host heap snapshot written to ${filePath}`);
      return filePath;
   }

   protected directory(): string {
      const directory = this.outputDirectory ?? this.options.directory ?? mkdtempSync(join(tmpdir(), 'hydranium-host-diagnostics-'));
      // Cleanup can remove it between snapshots, and a missing directory would
      // send the snapshot to the shared temporary directory.
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      this.outputDirectory = directory;
      return directory;
   }
}

/**
 * Theia backend module that exposes {@link HostDiagnosticsServer} as an ordinary
 * in-process RPC service at {@link HOST_DIAGNOSTICS_PATH} (not the socket-
 * forwarded data-server transport). The frontend reaches it with
 * `bindHostDiagnostics` (see `../browser`). Adopters
 * `export default createHostDiagnosticsBackendModule()` from a backend-module
 * entry point, passing `{ heapSnapshots: true }` only where every client may
 * inspect the backend process.
 */
export function createHostDiagnosticsBackendModule(options: HostDiagnosticsOptions = {}): ContainerModule {
   return new ContainerModule(bind => {
      bind(HostDiagnosticsOptions).toConstantValue(options);
      bind(HostDiagnosticsServer).toSelf().inSingletonScope();
      bind(ConnectionHandler)
         .toDynamicValue(context => new RpcConnectionHandler(HOST_DIAGNOSTICS_PATH, () => context.container.get(HostDiagnosticsServer)))
         .inSingletonScope();
   });
}
