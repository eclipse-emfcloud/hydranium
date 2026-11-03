/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import type { DataServerDiagnosticsProvider } from './diagnostics-provider.js';

/** Reject privileged requests until the host explicitly supplies a diagnostics provider. */
export function defaultDataServerDiagnostics(): DataServerDiagnosticsProvider {
   const unavailable = (): Promise<never> => Promise.reject(new Error('Server diagnostics are disabled by the host.'));
   return {
      dumpServerState: unavailable,
      writeHeapSnapshot: unavailable,
      dumpPodMemory: unavailable,
      startProfiling: unavailable
   };
}
