/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import type { Logger as ConnectionLogger } from 'vscode-jsonrpc/node';

/** Every connection line goes to stderr: stdout carries the command's output or the protocol stream. */
export const STDERR_CONNECTION_LOGGER: ConnectionLogger = {
   error: message => console.error(message),
   warn: message => console.error(message),
   info: message => console.error(message),
   log: message => console.error(message)
};
