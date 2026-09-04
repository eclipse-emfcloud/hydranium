/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import {
   type AdditionalDocumentContribution,
   type AdditionalDocumentRegistry,
   type ServerSharedServices,
   virtualUri
} from '@hydranium/core';
import type { LangiumDocumentFactory } from '@hydranium/langium';

/**
 * URI of the `order-flow` stdlib virtual document. Adopter code that needs to
 * recognise stdlib content — "go to source" filtering, diagnostics, telemetry —
 * compares against this constant rather than matching on names.
 *
 * The `.domain` suffix is load-bearing. An indexed virtual document is built
 * through the ordinary pipeline, and the framework's service registry maps a
 * document to its language by **file extension**; a bare `virtual:order-flow-builtin`
 * would resolve to no language and fail the build.
 */
export const ORDER_FLOW_STDLIB_URI = virtualUri('order-flow-builtin', 'primitives.domain');

/**
 * The stdlib, written in the language's **own concrete syntax** and parsed by
 * the real parser (see {@link OrderFlowStdlibContribution}).
 *
 * Authoring it as text rather than hand-building an AST is the deliberate
 * choice. A code-built root has to be cast past the generated AST types and
 * skips the parser entirely, so nothing checks it against the grammar — a
 * grammar change can leave it silently malformed. Round-tripping through
 * `fromString` means the stdlib is grammar-valid by construction and this
 * constant stays readable as the language it describes.
 *
 * **No `project` header, and that is the mechanism.** The framework's scope
 * computation emits a document's exports at `tier: 'project'` when it belongs
 * to a project and at `tier: 'universal'` when it does not. A headerless
 * virtual document therefore lands at the universal tier, so these three
 * resolve from any project without a `requires` — which is exactly what a
 * language built-in should do, and what no adopter-authored file can express.
 *
 * The declarations are empty on purpose: they are opaque primitives, named
 * anchors for `Field.type` to resolve against, not modelled value types.
 *
 * An adopter with more than a handful of built-ins generates this module from
 * real source files rather than keeping the text inline, so the built-ins stay
 * editable as ordinary documents. At three primitives that indirection would
 * cost more than it saves.
 */
export const ORDER_FLOW_STDLIB_SOURCE = `valuetype String {}

valuetype Number {}

valuetype Boolean {}
`;

/**
 * Seeds the stdlib as a virtual document so the primitive types are globally
 * resolvable.
 *
 * Bound under the shared `additionalDocuments` group in `order-flow-module.ts`;
 * the framework's workspace manager drives it from `loadAdditionalDocuments`
 * at startup, and its virtual-aware `FileSystemProvider` keeps the document
 * re-read-safe.
 */
export class OrderFlowStdlibContribution implements AdditionalDocumentContribution {
   protected readonly factory: LangiumDocumentFactory;

   constructor(services: ServerSharedServices) {
      this.factory = services.workspace.LangiumDocumentFactory;
   }

   registerAdditionalDocuments(registry: AdditionalDocumentRegistry): void {
      registry.register(this.factory.fromString(ORDER_FLOW_STDLIB_SOURCE, ORDER_FLOW_STDLIB_URI));
   }
}
