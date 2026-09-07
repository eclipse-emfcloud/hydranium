/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { formatProcessMemory, writeHeapSnapshotToDir } from '@hydranium/core/lib/node';
import {
   HOST_DIAGNOSTICS_PATH,
   type DumpHostStateArgs,
   type HostDiagnosticsProtocol,
   type WriteHostHeapSnapshotArgs
} from '@hydranium/protocol';
import { ConnectionHandler, RpcConnectionHandler } from '@theia/core';
import { ContainerModule, injectable } from '@theia/core/shared/inversify';

/**
 * Host-process diagnostics, computed IN the Theia backend process this service
 * runs in (the parent / host, distinct from the data-server child that holds the
 * model store). Universal — `process.memoryUsage()` always works — so the
 * framework wires it by default. Each result is also written to the backend's
 * stdout so it reaches the pod log (`kubectl logs`), not only the RPC caller.
 */
@injectable()
export class HostDiagnosticsServer implements HostDiagnosticsProtocol {
   async dumpHostState(args: DumpHostStateArgs): Promise<string> {
      const snapshot = formatProcessMemory(args.label ? `Host backend state (${args.label})` : 'Host backend state');
      console.info(snapshot);
      return snapshot;
   }

   async writeHostHeapSnapshot(args: WriteHostHeapSnapshotArgs): Promise<string> {
      const filePath = writeHeapSnapshotToDir(args.directory, args.label ?? 'backend', 'heap-backend');
      console.info(`Host heap snapshot written to ${filePath}`);
      return filePath;
   }
}

/**
 * Theia backend module that exposes {@link HostDiagnosticsServer} as an ordinary
 * in-process RPC service at {@link HOST_DIAGNOSTICS_PATH} (not the socket-
 * forwarded data-server transport). The frontend reaches it with
 * `bindHostDiagnostics` (see `../browser`). Adopters
 * `export default createHostDiagnosticsBackendModule()` from a backend-module
 * entry point.
 */
export function createHostDiagnosticsBackendModule(): ContainerModule {
   return new ContainerModule(bind => {
      bind(HostDiagnosticsServer).toSelf().inSingletonScope();
      bind(ConnectionHandler)
         .toDynamicValue(context => new RpcConnectionHandler(HOST_DIAGNOSTICS_PATH, () => context.container.get(HostDiagnosticsServer)))
         .inSingletonScope();
   });
}
