/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

// Browser-only entry (`@hydranium/data-server/browser`). Holds the worker
// starter, whose connection comes from `vscode-jsonrpc/browser`. The portable
// `.` entry stays free of that import for the same reason it stays free of the
// node one: it must resolve under both platforms, and a build that names one
// has picked.
export * from './start-data-server-in-worker.js';
