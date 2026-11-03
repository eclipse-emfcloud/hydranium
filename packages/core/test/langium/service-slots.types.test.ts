/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, expect, it } from 'vitest';
import type { LangiumDocumentFactory, ScopeComputation, WorkspaceLock } from '@hydranium/langium';
import type { CompletionProvider, DocumentUpdateHandler } from '@hydranium/langium/lsp';
import type { Logger } from '@hydranium/protocol';
import type { ServerAddedSharedServices, ServerSharedServices } from '../../src/langium/module.js';
import type { ServerAddedServices, ServerLanguageServices } from '../../src/langium/language-module.js';
import type { ServerSharedServicesMinimal } from '../../src/langium/shared-services.js';
import type { HydraniumLangiumDocumentFactory } from '../../src/langium/workspace/hydranium-langium-document-factory.js';
import type { HydraniumWorkspaceLock } from '../../src/langium/workspace/hydranium-workspace-lock.js';
import type { HydraniumDocumentBuilder } from '../../src/langium/document-builder/document-builder.js';
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

function acceptsInheritedContracts(scope: ScopeComputation, completion: CompletionProvider, logger: Logger): void {
   const scopeSlot: ServerLanguageServices['references']['ScopeComputation'] = scope;
   const completionSlot: ServerLanguageServices['lsp']['CompletionProvider'] = completion;
   const loggerSlot: ServerSharedServices['Logger'] = logger;
   void [scopeSlot, completionSlot, loggerSlot];
}

function requiresCancellationTracking(lock: WorkspaceLock, replacement: PublicContract<HydraniumWorkspaceLock>): void {
   // @ts-expect-error a resolved write can have been cancelled, so recovery needs the counter
   const full: ServerSharedServices['workspace']['WorkspaceLock'] = lock;
   // @ts-expect-error the minimal services must preserve cancellation tracking too
   const minimal: ServerSharedServicesMinimal['workspace']['WorkspaceLock'] = lock;
   const fullReplacement: ServerSharedServices['workspace']['WorkspaceLock'] = replacement;
   const minimalReplacement: ServerSharedServicesMinimal['workspace']['WorkspaceLock'] = replacement;
   void [full, minimal, fullReplacement, minimalReplacement];
}

function requiresFlush(handler: DocumentUpdateHandler): void {
   // @ts-expect-error settling a server needs a handler that can drain its pending changes
   const slot: LspServerAddedSharedServices['lsp']['DocumentUpdateHandler'] = handler;
   void slot;
}

function requiresLanguageExplicitFactory(factory: LangiumDocumentFactory, replacement: HydraniumLangiumDocumentFactory): void {
   // @ts-expect-error empty-document probes can select a language independently of the URI
   const full: ServerSharedServices['workspace']['LangiumDocumentFactory'] = factory;
   // @ts-expect-error the minimal services must carry the same language-explicit contract
   const minimal: ServerSharedServicesMinimal['workspace']['LangiumDocumentFactory'] = factory;
   const fullReplacement: ServerSharedServices['workspace']['LangiumDocumentFactory'] = replacement;
   const minimalReplacement: ServerSharedServicesMinimal['workspace']['LangiumDocumentFactory'] = replacement;
   void [full, minimal, fullReplacement, minimalReplacement];
}

function acceptsBuilderWithoutNotificationHooks(builder: Omit<HydraniumDocumentBuilder, 'notifyDocumentPhase' | 'notifyBuildPhase'>): void {
   const full: ServerSharedServices['workspace']['DocumentBuilder'] = builder;
   const minimal: ServerSharedServicesMinimal['workspace']['DocumentBuilder'] = builder;
   void [full, minimal];
}

describe('service slots', () => {
   it('accepts public contracts without implementation inheritance', () => {
      expect(acceptsIndependentServices).toBeTypeOf('function');
      expect(acceptsInheritedContracts).toBeTypeOf('function');
      expect(requiresFlush).toBeTypeOf('function');
      expect(requiresCancellationTracking).toBeTypeOf('function');
      expect(requiresLanguageExplicitFactory).toBeTypeOf('function');
      expect(acceptsBuilderWithoutNotificationHooks).toBeTypeOf('function');
   });
});
