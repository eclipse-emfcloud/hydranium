/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

// Environment-neutral connection primitives, shared by the browser connection
// source and the server connection service. Kept out of both tier barrels
// because each side binds the same buffer for its own half of the socket.
export * from './framed-socket-write-buffer';
export * from './connection-resilience-options';
