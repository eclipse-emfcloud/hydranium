/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * Diagnostics contract for the HOST (parent) process — the Theia backend
 * itself, the process that runs the data-client connection handlers and any
 * in-process services. Distinct from `DataServerDiagnosticsProtocol`,
 * which targets the separate data-server child (the heavy model store): the
 * host process is reached by an ordinary in-process Theia RPC service, NOT over
 * the data-server socket. Universal (`process.memoryUsage()` always works) and
 * cheap, so the framework wires it by default for every host that opts the
 * data-client backend module in.
 *
 * Returns are plain formatted strings — the caller (a command, a log sink, the
 * pod's stdout) decides how to surface them.
 */

/** Arguments for {@link HostDiagnosticsProtocol.dumpHostState}. */
export interface DumpHostStateArgs {
   /** Optional label folded into the snapshot heading (e.g. an ISO timestamp). */
   label?: string;
}

/** Arguments for {@link HostDiagnosticsProtocol.writeHostHeapSnapshot}. */
export interface WriteHostHeapSnapshotArgs {
   /** Optional label folded into the snapshot filename. */
   label?: string;
   /** Directory to write into; defaults to the OS temp dir when absent or not present on disk. */
   directory?: string;
}

/**
 * Memory diagnostics the running HOST (Theia backend) process exposes. Computed
 * in-process: the snapshots reflect the parent process, the counterpart to the
 * data-server child's `DataServerDiagnosticsProtocol`.
 */
export interface HostDiagnosticsProtocol {
   /**
    * Capture a host-process memory snapshot — heap, rss, external, V8 limit —
    * and return it formatted. The host hosts no Langium documents, so this is
    * the lighter `formatProcessMemory` view, not `formatServerState`.
    */
   dumpHostState(args: DumpHostStateArgs): Promise<string>;

   /**
    * Write a V8 heap snapshot of the host process to disk (full GC first;
    * briefly pauses the process) and return the absolute file path.
    */
   writeHostHeapSnapshot(args: WriteHostHeapSnapshotArgs): Promise<string>;
}

/**
 * Theia service path the host-diagnostics RPC service is registered under. An
 * ordinary in-process backend service (`RpcConnectionHandler`), unlike the
 * socket-forwarded `DATA_SERVER_PATH`.
 */
export const HOST_DIAGNOSTICS_PATH = '/hydranium/host-diagnostics';
