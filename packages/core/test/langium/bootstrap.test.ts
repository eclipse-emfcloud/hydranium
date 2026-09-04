/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, expect, it } from 'vitest';
import type { LangiumServices, LangiumSharedServices } from '@hydranium/langium/lsp';
import {
   STRICT_BINDINGS_ENV,
   assertCoreSlotsBound,
   bootstrapLangium,
   assertDistinctFileRouting,
   assertReflectionCoversLanguages,
   bootstrapLangiumLanguages,
   warnOnUnexpectedBindings
} from '../../src/langium/bootstrap.js';
import type { ServerSharedServicesMinimal } from '../../src/langium/shared-services.js';
import { ExtendedServiceRegistry } from '../../src/langium/service-registry.js';
import { URI } from '@hydranium/langium';
import { makeNoopTracer } from '../../src/testing/index.js';

/** One `ServiceRegistry.register` call, recorded by the stub registry. */
type RegisterCall = { language: LangiumServices };

/**
 * Shared services tree, minimally shaped to satisfy `assertCoreSlotsBound`
 * and paired with {@link fullyBoundLanguage}. Each test builds a fresh pair
 * and then deletes whichever slot the assertion is expected to flag.
 *
 * Plain object stubs (rather than vi.fn / vi.mock) — these tests assert the
 * registration wiring through structural stubs and don't need spy / mock
 * semantics anyway.
 */
function fullyBoundShared(): LangiumSharedServices & ServerSharedServicesMinimal & { __registerCalls: RegisterCall[] } {
   const calls: RegisterCall[] = [];
   return {
      ServiceRegistry: { register: (language: LangiumServices) => calls.push({ language }) },
      Logger: {},
      Tracer: makeNoopTracer(),
      lsp: { configurationRoot: 'test-language' },
      workspace: {
         WorkspaceManager: {},
         ProjectManager: {},
         SelfSaveRegistry: {},
         TextDocuments: {},
         AstDocumentManager: {},
         BuildPipelineIntegration: {}
      },
      __registerCalls: calls
   } as unknown as LangiumSharedServices & ServerSharedServicesMinimal & { __registerCalls: RegisterCall[] };
}

function fullyBoundLanguage(): LangiumServices {
   return {
      references: {
         ScopeComputation: {},
         ScopeProvider: {},
         ElementKeyProvider: {},
         NameProvider: {}
      },
      serializer: {
         Serializer: {}
      }
   } as unknown as LangiumServices;
}

describe('assertCoreSlotsBound', () => {
   it('accepts a fully-bound pair of services trees', () => {
      expect(() => assertCoreSlotsBound(fullyBoundShared(), fullyBoundLanguage())).not.toThrow();
   });

   it('throws when a shared slot is undefined, naming the slot and the missing factory', () => {
      const shared = fullyBoundShared();
      delete (shared as unknown as { workspace: Record<string, unknown> }).workspace.BuildPipelineIntegration;
      expect(() => assertCoreSlotsBound(shared, fullyBoundLanguage())).toThrow(
         /shared\.workspace\.BuildPipelineIntegration.*createServerSharedModule/s
      );
   });

   it('throws when a language slot is undefined, naming the slot and the missing factory', () => {
      const language = fullyBoundLanguage();
      delete (language as unknown as { references?: unknown }).references;
      expect(() => assertCoreSlotsBound(fullyBoundShared(), language)).toThrow(
         /services\.references\.ScopeComputation.*createServerLanguageModule/s
      );
   });

   it('includes the expected composition-order hint in the error message', () => {
      const shared = fullyBoundShared();
      delete (shared as unknown as { Logger?: unknown }).Logger;
      expect(() => assertCoreSlotsBound(shared, fullyBoundLanguage())).toThrow(/Expected composition order/);
   });

   it('flags an empty workspace branch as a missing slot', () => {
      const shared = fullyBoundShared();
      (shared as unknown as { workspace: Record<string, unknown> }).workspace = {};
      expect(() => assertCoreSlotsBound(shared, fullyBoundLanguage())).toThrow(/shared\.workspace\.WorkspaceManager/);
   });

   it('throws when the lsp.configurationRoot slot is missing, naming the slot and the missing factory', () => {
      const shared = fullyBoundShared();
      delete (shared as unknown as { lsp?: unknown }).lsp;
      expect(() => assertCoreSlotsBound(shared, fullyBoundLanguage())).toThrow(/shared\.lsp\.configurationRoot.*createServerSharedModule/s);
   });

   it('throws when the serializer.Serializer slot is missing, naming the slot and the missing factory', () => {
      const language = fullyBoundLanguage();
      delete (language as unknown as { serializer?: unknown }).serializer;
      expect(() => assertCoreSlotsBound(fullyBoundShared(), language)).toThrow(
         /services\.serializer\.Serializer.*createServerLanguageModule/s
      );
   });
});

describe('bootstrapLangium', () => {
   it('registers the language, asserts core slots, runs eager accessors, and returns the pair', () => {
      const shared = fullyBoundShared();
      const language = fullyBoundLanguage();
      const eagerCalls: LangiumSharedServices[] = [];
      const result = bootstrapLangium(shared, language, [received => eagerCalls.push(received)]);
      expect(shared.__registerCalls).toEqual([{ language }]);
      expect(eagerCalls).toEqual([shared]);
      expect(result).toEqual({ shared, language });
   });

   it('registers the language before asserting so registry-dependent eager services see a populated registry', () => {
      // Contract: `ServiceRegistry.register(language)` runs first, then
      // `assertCoreSlotsBound` walks the slots (which may lazy-trigger
      // service construction). Adopters subclassing the registry to add typed
      // accessors rely on `register(language)` setting those accessors before
      // any assertion-triggered or eager construction reads from them.
      const shared = fullyBoundShared();
      delete (shared as unknown as { Logger?: unknown }).Logger;
      const language = fullyBoundLanguage();
      const eagerCalls: LangiumSharedServices[] = [];
      expect(() => bootstrapLangium(shared, language, [received => eagerCalls.push(received)])).toThrow(/Logger/);
      // Register was called before the assertion failure — populated registry on
      // failure is benign because the throw aborts the adopter's bootstrap chain.
      expect(shared.__registerCalls).toEqual([{ language }]);
      // Eager accessors run AFTER assertion, so a failed assertion still skips them.
      expect(eagerCalls).toEqual([]);
   });
});

describe('assertDistinctFileRouting', () => {
   function routing(languageId: string, fileExtensions: string[], fileNames?: string[]): LangiumServices {
      const language = fullyBoundLanguage() as unknown as Record<string, unknown>;
      language.LanguageMetaData = { languageId, fileExtensions, ...(fileNames ? { fileNames } : {}) };
      return language as unknown as LangiumServices;
   }

   it('accepts languages whose extensions, file names and ids are all distinct', () => {
      expect(() => assertDistinctFileRouting([routing('langA', ['.a', '.a2']), routing('langB', ['.b'], ['project.json'])])).not.toThrow();
   });

   it('throws naming both languages when two claim one extension', () => {
      // Langium would take last-wins with a bare console.warn — outside the
      // framework Logger, so invisible in the LSP channel — and every `.a`
      // file would then be parsed by the wrong grammar.
      expect(() => assertDistinctFileRouting([routing('langA', ['.a']), routing('langB', ['.a'])])).toThrow(
         /file extension '\.a'.*'langA'.*'langB'/s
      );
   });

   it('throws when two languages claim one file name', () => {
      expect(() => assertDistinctFileRouting([routing('a', ['.a'], ['project.json']), routing('b', ['.b'], ['project.json'])])).toThrow(
         /file name 'project\.json'/
      );
   });

   it('throws when two languages share an id, which makes one unreachable entirely', () => {
      // The id keys `languageIdMap`, so the loser drops out of every lookup
      // path at once — the declared-id rung and `getServicesById` included.
      expect(() => assertDistinctFileRouting([routing('same', ['.a']), routing('same', ['.b'])])).toThrow(/language id 'same'/);
   });

   it('accepts a single language repeating nothing', () => {
      expect(() => assertDistinctFileRouting([routing('only', ['.only'])])).not.toThrow();
   });

   it('runs from bootstrapLangiumLanguages before registration', () => {
      const shared = fullyBoundShared();
      expect(() => bootstrapLangiumLanguages(shared, [routing('a', ['.a']), routing('b', ['.a'])], [])).toThrow(/file extension '\.a'/);
      // Nothing was registered — the check runs first, so a collision never
      // reaches the registry where last-wins would already have resolved it.
      expect(shared.__registerCalls).toEqual([]);
   });
});

describe('bootstrapLangiumLanguages — shared-services back-fill', () => {
   it('hands the shared services to a registry that was constructed without them', () => {
      // An adopter rebinding the slot with a zero-argument `new MyRegistry()`
      // would otherwise silently lose Langium's declared-languageId lookup
      // rung, so bootstrap closes that hole rather than relying on the
      // binding to pass the shared services in.
      const shared = fullyBoundShared();
      const language = fullyBoundLanguage() as unknown as Record<string, unknown>;
      language.LanguageMetaData = { languageId: 'only', fileExtensions: ['.only'] };
      (shared.workspace as unknown as Record<string, unknown>).TextDocuments = {
         get: (uri: string | URI) => (uri.toString() === 'untitled:Untitled-1' ? { languageId: 'only' } : undefined)
      };
      const registry = new ExtendedServiceRegistry();
      (shared as unknown as { ServiceRegistry: unknown }).ServiceRegistry = registry;

      bootstrapLangiumLanguages(shared, [language as unknown as LangiumServices], []);

      // Extensionless: only the declared-id rung can answer it, and that rung
      // exists only because bootstrap handed the registry its shared services.
      expect(registry.getServices(URI.parse('untitled:Untitled-1'))).toBe(language);
   });

   it('leaves a registry alone when it neither has nor accepts shared services', () => {
      // The stub registry in `fullyBoundShared` has no `acceptSharedServices`;
      // bootstrap must not assume every binding is a framework subclass.
      const shared = fullyBoundShared();
      expect(() => bootstrapLangiumLanguages(shared, [fullyBoundLanguage()], [])).not.toThrow();
   });
});

describe('bootstrapLangiumLanguages', () => {
   it('registers every language and returns them in order', () => {
      const shared = fullyBoundShared();
      const langA = fullyBoundLanguage();
      const langB = fullyBoundLanguage();
      const result = bootstrapLangiumLanguages(shared, [langA, langB], []);
      expect(shared.__registerCalls).toEqual([{ language: langA }, { language: langB }]);
      expect(result).toEqual({ shared, languages: [langA, langB] });
   });

   it('registers ALL languages before the first eager accessor runs', () => {
      // The ordering contract: a shared service constructed eagerly (e.g.
      // BuildPipelineIntegration, which routes per language) must never see a
      // half-populated registry. A naive per-language
      // register-then-eager loop would run the first accessor after ONE
      // registration.
      const shared = fullyBoundShared();
      const languages = [fullyBoundLanguage(), fullyBoundLanguage(), fullyBoundLanguage()];
      const registeredWhenEagerRan: number[] = [];
      bootstrapLangiumLanguages(shared, languages, [received => registeredWhenEagerRan.push(received.__registerCalls.length)]);
      expect(registeredWhenEagerRan).toEqual([3]);
   });

   it('runs the eager set exactly once, not once per language', () => {
      // Running it per language would attach each service's documentBuilder
      // listeners N times and enforce every build phase N times.
      const shared = fullyBoundShared();
      const eagerCalls: LangiumSharedServices[] = [];
      bootstrapLangiumLanguages(shared, [fullyBoundLanguage(), fullyBoundLanguage()], [received => eagerCalls.push(received)]);
      expect(eagerCalls).toEqual([shared]);
   });

   it('validates the slots of every language, not just the first', () => {
      const shared = fullyBoundShared();
      const langB = fullyBoundLanguage();
      delete (langB as unknown as { serializer?: unknown }).serializer;
      expect(() => bootstrapLangiumLanguages(shared, [fullyBoundLanguage(), langB], [])).toThrow(
         /services\.serializer\.Serializer.*createServerLanguageModule/s
      );
   });

   it('skips the eager set when a later language fails slot validation', () => {
      const shared = fullyBoundShared();
      const langB = fullyBoundLanguage();
      delete (langB as unknown as { references?: unknown }).references;
      const eagerCalls: LangiumSharedServices[] = [];
      expect(() => bootstrapLangiumLanguages(shared, [fullyBoundLanguage(), langB], [received => eagerCalls.push(received)])).toThrow(
         /references\.ScopeComputation/
      );
      expect(eagerCalls).toEqual([]);
   });

   it('throws on an empty language list rather than deferring the error to the first build', () => {
      expect(() => bootstrapLangiumLanguages(fullyBoundShared(), [], [])).toThrow(/at least one language/);
   });
});

describe('assertReflectionCoversLanguages', () => {
   /** A language whose grammar produces exactly these types. */
   function languageProducing(languageId: string, ...types: string[]): LangiumServices {
      const language = fullyBoundLanguage() as unknown as Record<string, unknown>;
      language.LanguageMetaData = { languageId, fileExtensions: [] };
      language.Grammar = {
         $type: 'Grammar',
         rules: types.map(name => ({ $type: 'ParserRule', name, definition: { $type: 'Group', elements: [] } }))
      };
      return language as unknown as LangiumServices;
   }

   /** Shared tree whose reflection knows exactly these types, capturing `Logger.warn`. */
   function sharedKnowing(...types: string[]): LangiumSharedServices & ServerSharedServicesMinimal & { warns: string[] } {
      const shared = fullyBoundShared();
      const warns: string[] = [];
      (shared as unknown as { AstReflection: unknown }).AstReflection = { getAllTypes: () => types };
      (shared as unknown as { Logger: unknown }).Logger = { warn: (message: string) => warns.push(message) };
      return Object.assign(shared, { warns });
   }

   it('accepts a reflection that spans every registered language, silently', () => {
      const shared = sharedKnowing('Element', 'OtherElement');
      const languages = [languageProducing('langA', 'Element'), languageProducing('langB', 'OtherElement')];

      expect(() => assertReflectionCoversLanguages(shared, languages)).not.toThrow();
      expect(shared.warns).toEqual([]);
   });

   it('throws naming the language whose types the reflection knows nothing about', () => {
      // The clobbered-binding shape: two independently generated packages, so
      // only the last composed shared module's reflection survives.
      const shared = sharedKnowing('Element');
      const languages = [languageProducing('langA', 'Element'), languageProducing('langB', 'OtherElement')];

      expect(() => assertReflectionCoversLanguages(shared, languages)).toThrow(/'langB'.*OtherElement.*ONE langium-cli run/s);
   });

   it('warns rather than throwing on a partially-known grammar, which may be generator folding', () => {
      const shared = sharedKnowing('Element', 'OtherElement');
      const languages = [languageProducing('langA', 'Element'), languageProducing('langB', 'OtherElement', 'FoldedAwayFragment')];

      expect(() => assertReflectionCoversLanguages(shared, languages)).not.toThrow();
      expect(shared.warns).toHaveLength(1);
      expect(shared.warns[0]).toMatch(/'langB'.*FoldedAwayFragment/s);
   });

   it('warns on the realistic partial clobber, where a shared base masks the missing types', () => {
      // The case a none-are-known threshold misses entirely: both grammars
      // import a common base, so a reflection covering only the langA package
      // still recognises most of what the langB grammar produces. Its
      // DISTINCTIVE types are gone, and everything that reads them — isSubtype,
      // allElements, getTypeMetaData — silently answers empty.
      const shared = sharedKnowing('SharedBase', 'SharedMember', 'Element');
      const languages = [
         languageProducing('langA', 'SharedBase', 'SharedMember', 'Element'),
         languageProducing('langB', 'SharedBase', 'SharedMember', 'OtherElement')
      ];

      expect(() => assertReflectionCoversLanguages(shared, languages)).not.toThrow();
      expect(shared.warns).toHaveLength(1);
      expect(shared.warns[0]).toMatch(/missing 1 of the 3 types.*'langB'.*OtherElement/s);
   });

   it('elides a long missing list rather than printing every type', () => {
      const many = Array.from({ length: 12 }, (_, index) => `Type${index}`);
      const shared = sharedKnowing('Anchor');
      const languages = [languageProducing('langA', 'Anchor'), languageProducing('langB', 'Anchor', ...many)];

      assertReflectionCoversLanguages(shared, languages);
      expect(shared.warns[0]).toMatch(/Type0, Type1, Type2, Type3, Type4, Type5, Type6, Type7, … \(4 more\)/);
   });

   it('stays quiet for a single language, which nothing can clobber', () => {
      expect(() => assertReflectionCoversLanguages(sharedKnowing(), [languageProducing('only', 'Root')])).not.toThrow();
   });

   it('stays quiet when no reflection is bound at all — a different failure', () => {
      const languages = [languageProducing('langA', 'Element'), languageProducing('langB', 'OtherElement')];

      expect(() => assertReflectionCoversLanguages(fullyBoundShared(), languages)).not.toThrow();
   });
});

describe('warnOnUnexpectedBindings', () => {
   function captureLogger(): { shared: LangiumSharedServices & ServerSharedServicesMinimal; warns: string[] } {
      const warns: string[] = [];
      const shared = fullyBoundShared();
      (shared as unknown as { Logger: unknown }).Logger = { warn: (message: string) => warns.push(message) };
      return { shared, warns };
   }

   function withStrictEnv<T>(value: string | undefined, fn: () => T): T {
      const prev = process.env[STRICT_BINDINGS_ENV];
      if (value === undefined) {
         delete process.env[STRICT_BINDINGS_ENV];
      } else {
         process.env[STRICT_BINDINGS_ENV] = value;
      }
      try {
         return fn();
      } finally {
         if (prev === undefined) {
            delete process.env[STRICT_BINDINGS_ENV];
         } else {
            process.env[STRICT_BINDINGS_ENV] = prev;
         }
      }
   }

   it('is a no-op when the env var is unset, even with non-subclass bindings', () => {
      const { shared, warns } = captureLogger();
      withStrictEnv(undefined, () => warnOnUnexpectedBindings(shared, fullyBoundLanguage()));
      expect(warns).toEqual([]);
   });

   it('warns per slot when enabled and a slot is bound to a non-subclass, naming the slot and the framework base', () => {
      const { shared, warns } = captureLogger();
      withStrictEnv('1', () => warnOnUnexpectedBindings(shared, fullyBoundLanguage()));
      expect(warns.length).toBeGreaterThan(0);
      expect(warns.some(message => /references\.ScopeComputation.*HydraniumScopeComputation/.test(message))).toBe(true);
      expect(warns.some(message => /workspace\.WorkspaceManager.*HydraniumWorkspaceManager/.test(message))).toBe(true);
   });
});
