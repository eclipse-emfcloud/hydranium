/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { startFlakyNetworkProxy } from '@hydranium/core/testing/playwright';
import { CONTROL_PORT, APP_PORT, PROXY_PORT } from './reconnect-ports.mjs';

/**
 * Starts the half-close proxy once for the whole run, and stops it afterwards.
 *
 * `globalSetup` rather than the config module, and that distinction cost a run
 * to learn: Playwright re-imports the config in every worker process, so a proxy
 * started at config scope tries to bind its ports once per worker and the second
 * one dies with EADDRINUSE. Global setup runs exactly once, in the main process,
 * before any worker forks.
 */
export default async function startProxy(): Promise<() => Promise<void>> {
   const proxy = await startFlakyNetworkProxy({
      listenPort: PROXY_PORT,
      targetPort: APP_PORT,
      controlPort: CONTROL_PORT
   });
   return () => proxy.close();
}
