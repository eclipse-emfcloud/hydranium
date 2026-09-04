/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

// Server-only entry (`@hydranium/glsp-server/node`). Holds the socket launcher,
// which binds GLSP's node `SocketServerLauncher` (`@eclipse-glsp/server/node`).
// The portable `.` entry stays free of that import so it bundles for the browser.
export * from './start-glsp-server.js';
