/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import type { Grammar, LangiumSharedCoreServices, URI } from '@hydranium/langium';
import type { TextDocument } from 'vscode-languageserver-textdocument';
import type { ServerLanguageServices } from '../langium/language-module.js';
import { ExtendedServiceRegistry } from '../langium/service-registry.js';
import { makeNoopLanguageServices, type NoopLanguageServicesOverrides } from './make-noop-language-services.js';

/**
 * One language to register on a {@link StubServiceRegistry}. Only
 * {@link languageId} and {@link fileExtensions} are required — they are what
 * Langium's routing ladder actually reads.
 */
export interface StubLanguageDescriptor {
   /** The language's id, as `LanguageMetaData.languageId`. */
   readonly languageId: string;
   /** Extensions routed to this language, leading dot included (`'.fake'`). */
   readonly fileExtensions: readonly string[];
   /** Whole file names routed to this language (Langium's `fileNameMap` rung). */
   readonly fileNames?: readonly string[];
   /**
    * AST `$type`s this language's grammar produces. Synthesised into a minimal
    * `Grammar` — one entry-less parser rule per type — which is exactly what
    * `collectProducibleTypes` reads, so type→language routing
    * (`buildLanguageTypeIndex`, `DataServer.resolveReferenceLanguage`) resolves
    * against this stub the same way it does against generated grammars.
    *
    * Entry-less on purpose: `reachableParserRules` falls back to every parser
    * rule when a grammar declares no entry rule, so each listed type is
    * produced. A test that needs the reachability semantics itself (a rule
    * present but unreachable) should build a real grammar rather than list it
    * here.
    */
   readonly producedTypes?: readonly string[];
   /**
    * Per-language service slots the code under test reads (`references`,
    * `serializer`, `ast`, …). Forwarded to {@link makeNoopLanguageServices},
    * which supplies no-op defaults for the `shared` sub-tree only — an unlisted
    * per-language slot stays absent and reads `undefined`.
    */
   readonly services?: NoopLanguageServicesOverrides;
}

/** Optional configuration for {@link makeStubServiceRegistry}. */
export interface MakeStubServiceRegistryOptions {
   /**
    * Documents to declare open with a client-supplied `languageId`, as
    * `{ [uri]: languageId }`. Drives the FIRST rung of Langium's lookup ladder
    * (languageId, then file name, then extension) by standing in for the
    * `workspace.TextDocuments` provider the registry consults.
    */
   readonly openLanguageIds?: Readonly<Record<string, string>>;
}

/**
 * Test-facing view of a stub registry: the real
 * {@link ExtendedServiceRegistry} surface plus seeding/introspection helpers.
 */
export interface StubServiceRegistry extends ExtendedServiceRegistry<ServerLanguageServices> {
   /**
    * Narrows Langium's `readonly LangiumCoreServices[]` to the framework's
    * per-language type, so call sites reading a framework slot off a
    * registered language (`references`, `serializer`, …) stay cast-free.
    */
   readonly all: readonly ServerLanguageServices[];
   /** Registered stub language services by id, in registration order. */
   readonly languagesById: ReadonlyMap<string, ServerLanguageServices>;
   /**
    * Declare `uri` open under `languageId`, so `getServices(uri)` resolves by
    * the declared id rather than the extension. Pass an unregistered id to
    * exercise the fall-through to file name / extension.
    */
   seedOpen(uri: string, languageId: string): void;
   /** Undo a {@link seedOpen} — the document is no longer open. */
   seedClosed(uri: string): void;
}

/**
 * Minimal `Grammar` carrying one parser rule per produced `$type`. Shaped for
 * `collectProducibleTypes`, which reads `rules[].name` / `fragment` /
 * `dataType` / `returnType` / `inferredType` and walks each rule's contents —
 * an empty `Group` is a well-formed, action-free rule definition.
 */
function makeStubGrammar(producedTypes: readonly string[]): Grammar {
   return {
      $type: 'Grammar',
      rules: producedTypes.map(name => ({ $type: 'ParserRule', name, definition: { $type: 'Group', elements: [] } }))
   } as unknown as Grammar;
}

/**
 * A `TextDocumentProvider` over a plain uri→languageId map. Only `languageId`
 * is populated: it is the sole field `DefaultServiceRegistry.getServices` reads
 * off the returned document, so a fuller `TextDocument` shell would state a
 * fidelity the stub does not have.
 */
function makeLanguageIdProvider(openLanguageIds: Map<string, string>): { get(uri: string | URI): TextDocument | undefined } {
   return {
      get(uri) {
         const languageId = openLanguageIds.get(uri.toString());
         return languageId === undefined ? undefined : ({ languageId } as TextDocument);
      }
   };
}

/**
 * The framework's own {@link ExtendedServiceRegistry}, carrying stub languages
 * and the seeding hooks {@link StubServiceRegistry} adds.
 *
 * Private per the test-support convention for doubles that must subclass a real
 * production class (see `makeStubModelService`): the class is an implementation
 * detail, {@link makeStubServiceRegistry} is the entry point.
 */
class StubServiceRegistryImpl extends ExtendedServiceRegistry<ServerLanguageServices> implements StubServiceRegistry {
   readonly languagesById = new Map<string, ServerLanguageServices>();

   override get all(): readonly ServerLanguageServices[] {
      return super.all as readonly ServerLanguageServices[];
   }

   constructor(protected readonly openLanguageIds: Map<string, string>) {
      // Langium reads exactly one thing off this argument — `workspace.TextDocuments`
      // — and only to resolve an open document's declared languageId. Passing a
      // provider-only shell keeps the stub free of a full shared-services tree.
      super({ workspace: { TextDocuments: makeLanguageIdProvider(openLanguageIds) } } as unknown as LangiumSharedCoreServices);
   }

   override register(language: ServerLanguageServices): void {
      super.register(language);
      this.languagesById.set(language.LanguageMetaData.languageId, language);
   }

   seedOpen(uri: string, languageId: string): void {
      this.openLanguageIds.set(uri, languageId);
   }

   seedClosed(uri: string): void {
      this.openLanguageIds.delete(uri);
   }
}

/**
 * Build a {@link StubServiceRegistry} over the given stub languages.
 *
 * **The registry is REAL.** This double stubs the *languages*, not the
 * registry: the returned object is the framework's own
 * {@link ExtendedServiceRegistry}, so `getServices` walks Langium's actual
 * lookup ladder (declared languageId → file name → extension), throws
 * Langium's actual messages on a miss, and picks up `hasServices`,
 * `getServicesById` and `getServicesByExtension` for free. Hand-rolled
 * registry objects re-implement that ladder, and a re-implementation is
 * exactly the fixture-vs-reality gap that lets a multi-grammar defect pass
 * a green test.
 *
 * Pass the same descriptors to `makeTestServices`' `languages` option to
 * get the registry bound on a full shared-services tree.
 */
export function makeStubServiceRegistry(
   languages: readonly StubLanguageDescriptor[],
   options: MakeStubServiceRegistryOptions = {}
): StubServiceRegistry {
   const registry = new StubServiceRegistryImpl(new Map(Object.entries(options.openLanguageIds ?? {})));
   for (const descriptor of languages) {
      registry.register(
         makeNoopLanguageServices({
            // A real language always HAS the `references` group, so code
            // reading `language.references.X` off a routed language is right to
            // do so without a second optional chain. Seeding it empty keeps
            // that true for a descriptor that names no reference service; the
            // individual slots stay absent, so an unstubbed one still reads
            // `undefined` rather than silently answering. A descriptor
            // supplying `references` replaces this wholesale.
            references: {},
            ...descriptor.services,
            Grammar: makeStubGrammar(descriptor.producedTypes ?? []),
            LanguageMetaData: {
               languageId: descriptor.languageId,
               fileExtensions: [...descriptor.fileExtensions],
               ...(descriptor.fileNames ? { fileNames: [...descriptor.fileNames] } : {})
            }
         })
      );
   }
   return registry;
}
