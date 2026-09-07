/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, expect, it } from 'vitest';
import { NoopLogger } from '@hydranium/protocol';
import { EmptyFileSystem, inject, type Module } from '@hydranium/langium';
import { LspLogger } from '../../src/langium/diagnostics/lsp-logger.js';
import {
   createDefaultSharedModule,
   DefaultDocumentUpdateHandler,
   type LangiumSharedServices,
   type PartialLangiumSharedServices
} from '@hydranium/langium/lsp';
import { createServerSharedModule, type ServerModuleContext, type ServerSharedServices } from '../../src/langium/module.js';
import { HydraniumDocumentUpdateHandler } from '../../src/lsp/hydranium-document-update-handler.js';
import { createLspServerLanguageModule } from '../../src/lsp/language-module.js';
import { createLspServerSharedModule, type LspServerSharedServices } from '../../src/lsp/shared-module.js';
import { assertLspHeadComposed } from '../../src/lsp/start-language-server.js';

const CONTEXT: ServerModuleContext = { ...EmptyFileSystem };

type SharedModule = Module<LspServerSharedServices, PartialLangiumSharedServices>;

/**
 * Compose the shared tier exactly as the head's doc prescribes, minus the
 * grammar-generated module (nothing here reads `AstReflection` or
 * `LanguageMetaData`). `extra` layers modules after the head's, which is where
 * an adopter's own overrides go.
 */
function composeShared(...extra: SharedModule[]): LspServerSharedServices {
   return inject(
      createDefaultSharedModule(CONTEXT) as unknown as SharedModule,
      createServerSharedModule(CONTEXT) as unknown as SharedModule,
      createLspServerSharedModule(CONTEXT) as unknown as SharedModule,
      ...extra
   ) as unknown as LspServerSharedServices;
}

/**
 * The same tier with the head's shared module LEFT OUT — the mistake
 * `assertLspHeadComposed` exists to catch.
 */
function composeSharedWithoutHead(...extra: SharedModule[]): LspServerSharedServices {
   return inject(
      createDefaultSharedModule(CONTEXT) as unknown as SharedModule,
      createServerSharedModule(CONTEXT) as unknown as SharedModule,
      ...extra
   ) as unknown as LspServerSharedServices;
}

/** A connection needs only to exist: the guard defers to Langium when none is bound. */
const connectionModule = { lsp: { Connection: () => ({}) } } as unknown as SharedModule;

describe('createLspServerSharedModule', () => {
   it('binds the framework DocumentUpdateHandler on the slot startLanguageServer reads', () => {
      // `startLanguageServer` / `addDocumentUpdateHandler` reach for
      // `services.lsp.DocumentUpdateHandler` on the SHARED tree. Binding it
      // anywhere else leaves Langium's default in place with no error, so the
      // framework's echo suppression, debounce, `markNextReason` stamping and
      // last-client-close rebuild go silently inert.
      expect(composeShared().lsp.DocumentUpdateHandler).toBeInstanceOf(HydraniumDocumentUpdateHandler);
   });

   it('constructs without an adopter module, so a bare compose is enough', () => {
      const shared = composeShared();

      expect(() => shared.lsp.DocumentUpdateHandler).not.toThrow();
      // Constructing is not enough to witness the bindings. `inject` answers
      // `undefined` for an unbound slot and the constructor only ASSIGNS what it
      // reads, so an unbound SelfSaveRegistry / FileSystemProvider / TextDocuments
      // / Clock survives construction and first throws at a watched-file event,
      // arbitrarily far from the composition that caused it. Each slot the
      // constructor reads is therefore DEREFERENCED here, not merely fetched.
      expect(shared.workspace.SelfSaveRegistry.matches('/nothing.x', 0)).toBe(false);
      expect(typeof shared.workspace.FileSystemProvider.readFile).toBe('function');
      expect(typeof shared.workspace.TextDocuments.get).toBe('function');
      expect(typeof shared.Clock.now()).toBe('number');
      expect(typeof shared.Logger.info).toBe('function');
   });

   it('lets a module layered after it win (later-wins composition)', () => {
      class AdopterHandler extends HydraniumDocumentUpdateHandler {}
      const shared = composeShared({
         lsp: { DocumentUpdateHandler: (services: ServerSharedServices) => new AdopterHandler(services) }
      } as unknown as SharedModule);
      expect(shared.lsp.DocumentUpdateHandler).toBeInstanceOf(AdopterHandler);
   });

   it('replaces server-core NoopLogger with a real one on the Logger slot', () => {
      // Without this binding the framework's Logger implementation, the
      // `HYDRANIUM_LOG_LEVEL` / `HYDRANIUM_LOG_FILE` env baselines, the file
      // tee and the `hydranium-cli --log-level` flag are all unwired:
      // server-core defaults `Logger` to `NoopLogger`, so the head is silent
      // and the env is never even read (it is read in `LspLogger`'s
      // constructor).
      expect(composeShared().Logger).toBeInstanceOf(LspLogger);
      expect(composeSharedWithoutHead().Logger).toBeInstanceOf(NoopLogger);
   });

   it('lets an adopter replace the Logger, since the sink is their choice', () => {
      const adopterLogger = new NoopLogger();
      const shared = composeShared({ Logger: () => adopterLogger } as unknown as SharedModule);
      expect(shared.Logger).toBe(adopterLogger);
   });
});

describe('LSP head module tiers', () => {
   // Pins WHICH module owns the slot. A shared slot bound on the language tier
   // type-checks (the module's type parameter is an intersection) and then does
   // nothing — so the tier itself is the contract worth asserting, not just
   // that some module binds the handler somewhere.
   it('puts DocumentUpdateHandler on the shared module only', () => {
      const sharedLsp = createLspServerSharedModule(CONTEXT).lsp;
      const languageLsp = createLspServerLanguageModule(CONTEXT).lsp;
      expect(sharedLsp && 'DocumentUpdateHandler' in sharedLsp).toBe(true);
      expect(languageLsp && 'DocumentUpdateHandler' in languageLsp).toBe(false);
   });

   it('keeps CompletionProvider on the language module only', () => {
      const sharedLsp = createLspServerSharedModule(CONTEXT).lsp;
      const languageLsp = createLspServerLanguageModule(CONTEXT).lsp;
      expect(languageLsp && 'CompletionProvider' in languageLsp).toBe(true);
      expect(sharedLsp && 'CompletionProvider' in sharedLsp).toBe(false);
   });
});

describe('assertLspHeadComposed', () => {
   const assertOn = (shared: LspServerSharedServices): void => assertLspHeadComposed(shared as unknown as LangiumSharedServices);

   it('throws when the head shared module was left out', () => {
      // Pinning which module owns the slot (above) does not pin that a server
      // composing the LANGUAGE module also composed the shared one — and the
      // `as unknown as TShared` cast in `createIntegrationServices` means the
      // type system will not say so either.
      expect(() => assertOn(composeSharedWithoutHead(connectionModule))).toThrow(/createLspServerSharedModule/);
   });

   it('names what is actually on the slot', () => {
      expect(() => assertOn(composeSharedWithoutHead(connectionModule))).toThrow(/DefaultDocumentUpdateHandler/);
      // Guards the message against Langium renaming its default out from under it.
      expect(DefaultDocumentUpdateHandler.name).toBe('DefaultDocumentUpdateHandler');
   });

   it('passes for the documented composition', () => {
      expect(() => assertOn(composeShared(connectionModule))).not.toThrow();
   });

   it('passes for an adopter subclass, the documented way to extend the handler', () => {
      class AdopterHandler extends HydraniumDocumentUpdateHandler {}
      const shared = composeShared(connectionModule, {
         lsp: { DocumentUpdateHandler: (services: ServerSharedServices) => new AdopterHandler(services) }
      } as unknown as SharedModule);
      expect(() => assertOn(shared)).not.toThrow();
   });

   it('defers to Langium when no connection is bound', () => {
      // A missing connection is the more fundamental misconfiguration and has
      // its own error inside `startLanguageServer`; reporting it here as a
      // missing module would misname it.
      expect(() => assertOn(composeSharedWithoutHead())).not.toThrow();
   });
});
