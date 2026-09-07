/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * Lifecycle handle for a protocol-head server (socket-based, stdio-based,
 * or otherwise) that the adopter starts during language-server bootstrap.
 *
 * The two promises encode the canonical two-phase startup pattern:
 * - {@link started} resolves once the head is accepting traffic — for a
 *   socket server, this means `net.Server.listen` resolved AND the bound
 *   port is known. Adopter bootstrap code awaits this before publishing
 *   the port and announcing readiness over the LSP connection.
 * - {@link stopped} resolves once the head has shut down cleanly — used
 *   primarily by tests waiting for tidy teardown.
 *
 * Either promise may reject if startup or shutdown encounters an error
 * the head can't recover from.
 */
export interface IntegratedServer {
   readonly started: Promise<void>;
   readonly stopped: Promise<void>;
}
