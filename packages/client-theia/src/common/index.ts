/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

// Environment-neutral primitives that the browser and the server tiers each
// bind for their own side, such as the buffer for each half of the socket.
// Kept out of both tier barrels for that reason.
export * from './framed-socket-write-buffer';
export * from './connection-resilience-options';
export * from './clock';
