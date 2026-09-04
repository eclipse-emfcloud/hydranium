/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * `@hydranium/core/testing` — the framework's BROWSER-NEUTRAL test-support
 * surface: Langium-layer doubles for the shared-services slots, the harness that
 * composes them into a services tree, the fake AST / document / reflection
 * builders, the snapshot and URI-policy conformance primitives, the
 * structured-write pipeline driver, and a re-export of `langium/test`.
 *
 * Neutrality is gated (`scripts/check-neutral-bundles.mjs`). The test support
 * that needs a real filesystem or a Node stream transport — the scratch
 * workspace, the golden corpus, the LSP transport and its harness — lives at
 * `@hydranium/core/testing/node`, on the same rule the package surface uses:
 * the portable name is the short one.
 */

export * from './ast-snapshot.js';
export * from './document-uri-policy-conformance.js';
export * from './fake-description.js';
export * from './fake-document.js';
export * from './fake-reflection.js';
export * from './langium-test-helpers.js';
export * from './make-noop-language-services.js';
export * from './make-noop-shared-services.js';
export * from './make-test-services.js';
export * from './make-test-tracer.js';
export * from './parse-semantic-root.js';
export * from './run-update-pipeline.js';
export * from './stub-document-builder.js';
export * from './stub-index-manager.js';
export * from './stub-langium-documents.js';
export * from './stub-model-service.js';
export * from './stub-ast-document-manager.js';
export * from './stub-project-manager.js';
export * from './stub-self-save-registry.js';
export * from './stub-service-registry.js';
export * from './stub-hydranium-text-documents.js';
export * from './stub-writable-file-system.js';
