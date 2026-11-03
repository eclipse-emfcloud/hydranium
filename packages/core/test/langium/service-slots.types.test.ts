/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, expect, it } from 'vitest';
import type { ScopeComputation, WorkspaceLock } from '@hydranium/langium';
import type { CompletionProvider, DocumentUpdateHandler } from '@hydranium/langium/lsp';
import type { Logger } from '@hydranium/protocol';
import type { ServerAddedSharedServices, ServerSharedServices } from '../../src/langium/module.js';
import type { ServerAddedServices, ServerLanguageServices } from '../../src/langium/language-module.js';
import type { LspServerAddedSharedServices } from '../../src/lsp/shared-module.js';

type PublicContract<T> = T extends object ? Pick<T, keyof T> : T;
type PublicSlots<T> = { [K in keyof T]: PublicContract<T[K]> };

function acceptsIndependentServices(
   workspace: PublicSlots<ServerAddedSharedServices['workspace']>,
   references: PublicSlots<ServerAddedServices['references']>,
   languageWorkspace: PublicSlots<ServerAddedServices['workspace']>,
   lsp: PublicSlots<ServerLanguageServices['lsp']>,
   sharedLsp: PublicSlots<LspServerAddedSharedServices['lsp']>,
   logger: Pick<ServerSharedServices['Logger'], keyof ServerSharedServices['Logger']>
): void {
   const sharedSlots: ServerAddedSharedServices['workspace'] = workspace;
   const referenceSlots: ServerAddedServices['references'] = references;
   const languageSlots: ServerAddedServices['workspace'] = languageWorkspace;
   const lspSlots: ServerLanguageServices['lsp'] = lsp;
   const sharedLspSlots: LspServerAddedSharedServices['lsp'] = sharedLsp;
   const loggerSlot: ServerSharedServices['Logger'] = logger;
   void [sharedSlots, referenceSlots, languageSlots, lspSlots, sharedLspSlots, loggerSlot];
}

function acceptsInheritedContracts(lock: WorkspaceLock, scope: ScopeComputation, completion: CompletionProvider, logger: Logger): void {
   const lockSlot: ServerSharedServices['workspace']['WorkspaceLock'] = lock;
   const scopeSlot: ServerLanguageServices['references']['ScopeComputation'] = scope;
   const completionSlot: ServerLanguageServices['lsp']['CompletionProvider'] = completion;
   const loggerSlot: ServerSharedServices['Logger'] = logger;
   void [lockSlot, scopeSlot, completionSlot, loggerSlot];
}

function requiresFlush(handler: DocumentUpdateHandler): void {
   // @ts-expect-error settling a server needs a handler that can drain its pending changes
   const slot: LspServerAddedSharedServices['lsp']['DocumentUpdateHandler'] = handler;
   void slot;
}

describe('service slots', () => {
   it('accepts public contracts without implementation inheritance', () => {
      expect(acceptsIndependentServices).toBeTypeOf('function');
      expect(acceptsInheritedContracts).toBeTypeOf('function');
      expect(requiresFlush).toBeTypeOf('function');
   });
});
