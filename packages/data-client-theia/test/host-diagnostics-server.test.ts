/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

// The real `writeHeapSnapshotToDir` calls `v8.writeHeapSnapshot`, which runs a
// full GC and writes a file the size of the heap. What this service owns is
// the ARGUMENTS it derives, so both helpers are stood in for and asserted on.
const { formatProcessMemoryMock, writeHeapSnapshotToDirMock } = vi.hoisted(() => ({
   formatProcessMemoryMock: vi.fn((label: string) => `<memory for ${label}>`),
   writeHeapSnapshotToDirMock: vi.fn(() => '/tmp/snapshot.heapsnapshot')
}));

vi.mock('@hydranium/core/lib/node', () => ({
   formatProcessMemory: formatProcessMemoryMock,
   writeHeapSnapshotToDir: writeHeapSnapshotToDirMock
}));

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HOST_DIAGNOSTICS_PATH } from '@hydranium/protocol';
import { ConnectionHandler } from '@theia/core';
import { Container } from '@theia/core/shared/inversify';
import { createHostDiagnosticsBackendModule, HostDiagnosticsServer } from '../src/node/host-diagnostics-server';

describe('HostDiagnosticsServer', () => {
   beforeEach(() => {
      formatProcessMemoryMock.mockClear();
      writeHeapSnapshotToDirMock.mockClear();
   });

   it('folds a caller label into the dump heading', async () => {
      await new HostDiagnosticsServer().dumpHostState({ label: 'after import' });

      expect(formatProcessMemoryMock).toHaveBeenCalledWith('Host backend state (after import)');
   });

   it('uses the bare heading when the caller names no label', async () => {
      // An empty string is a label the caller did not choose, so it takes the
      // bare heading too — `Host backend state ()` would read as a bug.
      await new HostDiagnosticsServer().dumpHostState({});
      await new HostDiagnosticsServer().dumpHostState({ label: '' });

      expect(formatProcessMemoryMock).toHaveBeenNthCalledWith(1, 'Host backend state');
      expect(formatProcessMemoryMock).toHaveBeenNthCalledWith(2, 'Host backend state');
   });

   it('also writes the dump to stdout, so it reaches the pod log', async () => {
      // The RPC caller is not the only reader: a backend running in a pod is
      // read through `kubectl logs`, where an RPC-only result is invisible.
      const info = vi.spyOn(console, 'info').mockImplementation(() => {});
      try {
         const result = await new HostDiagnosticsServer().dumpHostState({});
         expect(info).toHaveBeenCalledWith(result);
      } finally {
         info.mockRestore();
      }
   });

   it('names the snapshot for the host rather than the model store', async () => {
      // The `heap-backend` prefix is what tells a host snapshot apart from the
      // data-server child's in a directory holding both.
      const info = vi.spyOn(console, 'info').mockImplementation(() => {});
      try {
         await new HostDiagnosticsServer().writeHostHeapSnapshot({ directory: '/tmp/x', label: 'peak' });
      } finally {
         info.mockRestore();
      }

      expect(writeHeapSnapshotToDirMock).toHaveBeenCalledWith('/tmp/x', 'peak', 'heap-backend');
   });

   it('falls back to a backend label when the caller names none', async () => {
      const info = vi.spyOn(console, 'info').mockImplementation(() => {});
      try {
         await new HostDiagnosticsServer().writeHostHeapSnapshot({});
      } finally {
         info.mockRestore();
      }

      expect(writeHeapSnapshotToDirMock).toHaveBeenCalledWith(undefined, 'backend', 'heap-backend');
   });
});

describe('createHostDiagnosticsBackendModule', () => {
   it('serves one singleton server on the path the frontend proxies', () => {
      // The path is shared with the frontend through `@hydranium/protocol`, so
      // what is worth pinning is that the handler is registered under the
      // shared constant rather than a literal that could drift from it.
      const container = new Container();
      container.load(createHostDiagnosticsBackendModule());

      const handlers = container.getAll<ConnectionHandler>(ConnectionHandler);
      expect(handlers.map(handler => handler.path)).toEqual([HOST_DIAGNOSTICS_PATH]);
      expect(container.get(HostDiagnosticsServer)).toBe(container.get(HostDiagnosticsServer));
   });
});
