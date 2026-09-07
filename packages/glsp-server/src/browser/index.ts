/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

// Browser-only entry (`@hydranium/glsp-server/browser`). Holds the worker
// launcher, which binds GLSP's `WorkerServerLauncher` from
// `@eclipse-glsp/server/browser`. The portable `.` entry stays free of that
// import for the same reason it stays free of the node one: it must resolve
// under both platforms, and a build that names one has picked.
export * from './start-glsp-server-in-worker.js';
