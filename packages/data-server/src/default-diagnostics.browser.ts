/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import type { DataServerDiagnosticsProvider, DataServerProfileCapture } from './diagnostics-provider.js';

/**
 * Message every method of the browser default rejects with.
 *
 * It **throws rather than no-ops** deliberately. A no-op would hand back an
 * empty snapshot, which reads as "the server is fine" — the same shape as a
 * real answer, and the failure mode this whole seam exists to avoid. Saying
 * plainly that the capability is absent is more useful than a plausible lie.
 */
function unavailable(method: string): Error {
   return new Error(
      `DataServer.${method} is not available in this host: a browser has no process to inspect. ` +
         'Heap snapshots, profiling, pod memory and server state are Node-only capabilities.'
   );
}

/**
 * Platform default for a browser host, selected by `package.json`'s `browser`
 * field in place of `default-diagnostics.js`.
 *
 * Free of Node imports by construction — that is its entire reason for
 * existing, and why the head's portable entry can be bundled at all.
 */
export function defaultDataServerDiagnostics(): DataServerDiagnosticsProvider {
   return {
      dumpServerState: () => Promise.reject(unavailable('dumpServerState')),
      writeHeapSnapshot: () => Promise.reject(unavailable('writeHeapSnapshot')),
      dumpPodMemory: () => Promise.reject(unavailable('dumpPodMemory')),
      startProfiling: (): Promise<DataServerProfileCapture> => Promise.reject(unavailable('startProfiling'))
   };
}
