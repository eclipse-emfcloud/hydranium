/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import type { ConnectionProvider } from '@eclipse-glsp/client';
import { sendByMethodName } from '@hydranium/protocol';

/** The connection GLSP's client sends over, typed by GLSP's own copy of `vscode-jsonrpc`. */
export type GlspMessageConnection = Exclude<ConnectionProvider, (...args: never[]) => unknown>;

/**
 * `connection`, wrapped with `sendByMethodName` and typed as the connection
 * GLSP's client takes. Passed straight to `connectionProvider`, the wrapper
 * reads its result type from that option's union, which older TypeScript
 * versions do not resolve, and the assignment fails.
 */
export function glspConnection(connection: Parameters<typeof sendByMethodName>[0]): GlspMessageConnection {
   return sendByMethodName(connection);
}
