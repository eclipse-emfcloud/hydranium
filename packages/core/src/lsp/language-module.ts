/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { type Module } from '@hydranium/langium';
import { type ServerLanguageServices } from '../langium/language-module.js';
import { type ServerModuleContext } from '../langium/module.js';
import { type PartialLangiumServices } from '@hydranium/langium/lsp';
import { HydraniumCompletionProvider } from './completion/hydranium-completion-provider.js';

/**
 * Language-level slots contributed by the LSP-textual protocol head.
 * Bound by {@link createLspServerLanguageModule}; consumer modules
 * layered after it can override any slot.
 *
 * - {@link HydraniumCompletionProvider} upgrades Langium's default
 *   `TextEdit` to an `InsertReplaceEdit` so the user's
 *   `editor.suggest.insertMode` preference is honoured.
 *
 * The head's SHARED-tier slots are bound by
 * `createLspServerSharedModule` instead: `lsp.DocumentUpdateHandler`
 * exists once per server rather than once per grammar, so binding it here is
 * inert — nothing reads a per-language one.
 */
export interface LspServerAddedServices {
   lsp: {
      /* override */ CompletionProvider: HydraniumCompletionProvider;
   };
}

/**
 * Full language-service surface visible to consumers that compose this
 * head: `@hydranium/core`'s bindings plus the LSP-textual additions. Use as
 * the `T` type parameter for the consumer's own
 * `Module<LspServerLanguageServices, ...>` if its overrides depend on
 * any LSP-only slot.
 */
export type LspServerLanguageServices = ServerLanguageServices & LspServerAddedServices;

/**
 * The LSP-textual protocol head's default language module. Composes on
 * top of `createServerLanguageModule` — as a later `inject(...)`
 * argument, or as `languageModules.extra` when composing through
 * `createIntegrationServices`; the adopter's own language module goes after
 * it either way.
 *
 * `createServerLanguageModule` MUST be merged before this one — the
 * lsp-server head only contributes LSP-textual-specific slots and
 * relies on `@hydranium/core`'s references / naming bindings being present.
 */
export function createLspServerLanguageModule(
   _context: ServerModuleContext
): Module<LspServerLanguageServices, PartialLangiumServices & LspServerAddedServices> {
   return {
      lsp: {
         CompletionProvider: services => new HydraniumCompletionProvider(services)
      }
   };
}
