/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { createHostDiagnosticsBackendModule } from '@hydranium/data-client-theia/lib/node';

// Exposes the host-process (Theia backend) memory diagnostics as an in-process
// RPC service. That process is NOT the data-server child wired in
// order-flow-data-server-backend-module: this one is the Theia backend itself,
// reached over an ordinary Theia service rather than the data socket, which is
// why the two cannot share a proxy. Lights up the contribution's "Dump Backend
// State" / "Write Heap Snapshot (Backend)" commands via bindHostDiagnostics.
export default createHostDiagnosticsBackendModule();
