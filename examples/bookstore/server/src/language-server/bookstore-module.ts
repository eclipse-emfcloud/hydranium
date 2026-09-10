/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

// DI bootstrap for Bookstore. Composes the framework defaults with adopter
// overrides via Langium's `inject()` (through the framework's
// `createIntegrationServices`). Each adopter module binds ONE slot — its
// language's `Serializer`, which the framework cannot default because a
// concrete syntax is grammar knowledge. Everything else (scope, naming, project
// management, build pipeline) boots on the framework defaults; scope
// computation, validation checks and AST extensions go in these same modules.
//
// Note which generated symbol comes from which name: the SHARED module is
// `BookstoreGeneratedSharedModule` (from `projectName`) and there is one of it,
// while the per-language `<Grammar>GeneratedModule` (from each `grammar`
// declaration) has one per grammar.
//
// A second grammar goes in the `additionalLanguages` option of
// `createIntegrationServices`, generated from this same `langium-config.json`.

import {
   createLspServerLanguageModule,
   createLspServerSharedModule,
   type LspServerAddedServices,
   type LspServerAddedSharedServices
} from '@hydranium/core/lsp';
import { createIntegrationServices, type ServerAddedServices, type ServerModuleContext, type ServerSharedServices } from '@hydranium/core';
import { type DeepPartial, EmptyFileSystem, type Module } from '@hydranium/langium';
import { type LangiumServices, type PartialLangiumServices, type PartialLangiumSharedServices } from '@hydranium/langium/lsp';
import { BookstoreGeneratedModule, BookstoreGeneratedSharedModule } from './generated/module.js';
import { BookstoreSerializer } from './bookstore-serializer.js';

export type BookstoreSharedServices = ServerSharedServices & LspServerAddedSharedServices;
export type BookstoreServices = LangiumServices &
   ServerAddedServices &
   LspServerAddedServices & {
      shared: BookstoreSharedServices;
   };

/** What a host or a test may vary about this composition. */
export interface BookstoreOptions {
   /**
    * Shared modules layered in after the framework's own bindings.
    *
    * The framework constructs most shared services with no options —
    * `DocumentBuilder: services => new HydraniumDocumentBuilder(services)` — so
    * rebinding the slot is the only way to boot one configured differently, and
    * a factory that hard-codes its composition leaves a test nowhere to do it.
    * That is what this is for: pass a module binding `workspace.DocumentBuilder`
    * to exercise a builder option, or to substitute a subclass.
    *
    * Composed LAST, after `BookstoreSharedModule`, so it wins over every other
    * tier including this file's own bindings — which is what makes it usable for
    * a slot the adopter overrides. Production code should not reach for it.
    */
   readonly extraSharedModules?: ReadonlyArray<Module<BookstoreSharedServices, DeepPartial<BookstoreSharedServices>>>;
}

const BookstoreSharedModule: Module<BookstoreSharedServices, PartialLangiumSharedServices> = {};

const BookstoreLanguageModule: Module<BookstoreServices, PartialLangiumServices & DeepPartial<ServerAddedServices>> = {
   serializer: {
      Serializer: services => new BookstoreSerializer(services)
   }
};

/** Compose the Langium DI tree for Bookstore — returns the shared + language services. */
export function createBookstoreServices(
   context: Partial<ServerModuleContext> = EmptyFileSystem,
   options: BookstoreOptions = {}
): {
   shared: BookstoreSharedServices;
   Bookstore: BookstoreServices;
} {
   const fullContext: ServerModuleContext = { ...EmptyFileSystem, ...context };
   const { shared, language } = createIntegrationServices<ServerModuleContext, BookstoreSharedServices, BookstoreServices>({
      context: fullContext,
      sharedModules: {
         generated: BookstoreGeneratedSharedModule,
         adopter: BookstoreSharedModule,
         extra: [createLspServerSharedModule(fullContext)],
         overrides: options.extraSharedModules
      },
      languageModules: {
         generated: BookstoreGeneratedModule,
         adopter: () => BookstoreLanguageModule,
         extra: [createLspServerLanguageModule(fullContext)]
      }
   });
   return { shared, Bookstore: language };
}
