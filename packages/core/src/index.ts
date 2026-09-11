/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

// Public API barrel for the head-neutral `.` entry point.
export * from './langium/ast-extension/index.js';
export * from './langium/build-phase-pass/index.js';
export * from './langium/bootstrap.js';
export * from './langium/config/index.js';
export * from './langium/integration-services.js';
export * from './langium/diagnostics/index.js';
export * from './langium/document-builder/index.js';
export * from './langium/integrity/index.js';
export * from './langium/language-module.js';
export * from './langium/model-service/index.js';
export * from './langium/module.js';
export * from './langium/shared-services.js';
export * from './langium/keys/index.js';
export * from './langium/documentation/index.js';
export * from './langium/labeling/index.js';
export * from './langium/naming/index.js';
export * from './langium/project/index.js';
export * from './langium/residency/index.js';
export * from './langium/scope/index.js';
export * from './langium/serialization/index.js';
export * from './langium/transfer/index.js';
export * from './langium/update-rewrite/index.js';
export * from './langium/validation/index.js';
export * from './langium/workspace/index.js';
export * from './langium/service-registry.js';
export * from './langium/language-types.js';
export * from './launcher/index.js';
export * from './locale/index.js';
// The renderer only. The `./messages` subpath additionally enumerates this
// package's own declarations, which the root barrel already re-exports through
// the modules that raise them.
export * from './messages/renderer.js';
export * from './documents/index.js';
export * from './util/index.js';
