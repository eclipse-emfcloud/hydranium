/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

export * from './glsp-app-module.js';
export * from './abstract-hydranium-glsp-diagram-module.js';
// Exported so an adopter binding their own GLSP server extends the framework's
// rather than upstream's — the server-container override discards a subclass of
// `DefaultGLSPServer`.
export * from './hydranium-glsp-server.js';
// The socket bringup lives in `@hydranium/glsp-server/node` and the worker
// bringup in `@hydranium/glsp-server/browser`, not here: each pulls the
// upstream build for its platform, which the portable `.` entry must stay free
// of. `glsp-framework-overrides.js` and `glsp-server-overrides.js` are
// deliberately NOT re-exported — they are the bindings those two bringups share,
// reached by relative import, and an adopter composing a container by hand wants
// the launcher rather than its internals.
