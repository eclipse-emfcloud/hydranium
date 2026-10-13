/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

// Worker-only entry (`@hydranium/core/browser`). Compiled as its own project
// against `lib.webworker`, so a worker global such as `indexedDB` or
// `postMessage` resolves here and nowhere else in the package: the portable
// `.` barrel must stay free of DOM and worker globals, since it also loads in a
// plain Node consumer.
export * from './host-heads-in-worker.js';
export * from './indexeddb-file-system-store.js';
export * from './start-language-server-in-worker.js';
