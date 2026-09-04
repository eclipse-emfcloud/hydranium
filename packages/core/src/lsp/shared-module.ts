/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { type Module } from '@hydranium/langium';
import { type PartialLangiumSharedServices } from '@hydranium/langium/lsp';
import { LspLogger } from '../langium/diagnostics/lsp-logger.js';
import { type ServerModuleContext, type ServerSharedServices } from '../langium/module.js';
import { HydraniumDocumentUpdateHandler } from './hydranium-document-update-handler.js';

/**
 * Shared-tier slots contributed by the LSP-textual protocol head. Bound by
 * {@link createLspServerSharedModule}; consumer modules layered after it can
 * override any slot.
 *
 * - {@link LspLogger} replaces the shared tier's `NoopLogger` on the `Logger` slot,
 *   so a head composing this module actually emits. It routes through the LSP
 *   `window/logMessage` channel once a `Connection` is bound and to `stderr`
 *   before that (or in a headless head that never binds one), and its
 *   constructor is what applies the `HYDRANIUM_LOG_LEVEL` / `HYDRANIUM_LOG_FILE`
 *   env baselines — so binding it here is also what makes `hydranium-cli
 *   --log-level` reach the spawned server. Adopters wanting a different sink
 *   (an output channel, a structured logger) override the slot after this
 *   module.
 *
 * - {@link HydraniumDocumentUpdateHandler} wraps `didChangeWatchedFiles` to
 *   suppress echo events for the server's own writes via the shared
 *   `SelfSaveRegistry` slot, debounces `didChangeContent`, stamps build
 *   reasons through `markNextReason`, and dispatches a rebuild when the last
 *   client closes a document.
 *   Adopters with their own update-handler subclass should extend
 *   `HydraniumDocumentUpdateHandler` (not Langium's
 *   `DefaultDocumentUpdateHandler`) to preserve those behaviours.
 *
 * **Why this is a shared slot and not a per-language one.** Langium declares
 * `DocumentUpdateHandler` in `LangiumSharedLSPServices` — there is exactly one
 * per server, and `startLanguageServer` reads it off the shared tree. It is
 * parameterised by the CLIENT PROTOCOL (which LSP notifications arrive), not
 * by the grammar — the rule for which DI scope a service belongs to. Binding
 * it per language is inert: nothing reads a per-language
 * `lsp.DocumentUpdateHandler`, and under a multi-grammar composition a
 * per-language binding would attach N listener sets to the one document store.
 */
export interface LspServerAddedSharedServices {
   /* override */ Logger: LspLogger;
   lsp: {
      /* override */ DocumentUpdateHandler: HydraniumDocumentUpdateHandler;
   };
}

/**
 * Full shared-service surface visible to consumers that compose this head:
 * `@hydranium/core`'s shared bindings plus the LSP-textual additions. Use as
 * the `T` type parameter for the consumer's own
 * `Module<LspServerSharedServices, ...>` if its overrides depend on any
 * LSP-only shared slot.
 */
export type LspServerSharedServices = ServerSharedServices & LspServerAddedSharedServices;

/**
 * The LSP-textual protocol head's default shared module. Composes on top of
 * `createServerSharedModule` — as a later `inject(...)` argument, or as
 * `sharedModules.extra` when composing through `createIntegrationServices`;
 * the adopter's own shared module goes after it either way.
 *
 * `createServerSharedModule` MUST be merged before this one — the lsp-server
 * head only contributes LSP-textual-specific slots and relies on
 * `@hydranium/core`'s `SelfSaveRegistry` / `TextDocuments` / `DocumentBuilder`
 * bindings being present.
 *
 * Returned as a function (not a constant) so head defaults can read from the
 * construction context, mirroring `createLspServerLanguageModule`.
 */
export function createLspServerSharedModule(
   _context: ServerModuleContext
): Module<LspServerSharedServices, PartialLangiumSharedServices & LspServerAddedSharedServices> {
   return {
      Logger: services => new LspLogger(services),
      lsp: {
         DocumentUpdateHandler: services => new HydraniumDocumentUpdateHandler(services)
      }
   };
}
