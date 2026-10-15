/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

// Internal to the package: its index does not re-export this module.

/** The settle requests whose failure the handler logged, by client and request id. */
const loggedFailures = new Set<string>();

/** Mark the failure of `requestId` from `clientId` logged, before its rejection is sent. */
export function markSettleFailureLogged(clientId: string, requestId: string): void {
   loggedFailures.add(`${clientId}\n${requestId}`);
}

/** Whether the failure of `requestId` from `clientId` was logged; forgets the mark. */
export function takeSettleFailureLogged(clientId: string, requestId: string): boolean {
   return loggedFailures.delete(`${clientId}\n${requestId}`);
}
