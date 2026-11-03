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
export function createLspServerLanguageModule(_context: ServerModuleContext): Module<ServerLanguageServices, PartialLangiumServices> {
   return {
      lsp: {
         CompletionProvider: services => new HydraniumCompletionProvider(services)
      }
   };
}
