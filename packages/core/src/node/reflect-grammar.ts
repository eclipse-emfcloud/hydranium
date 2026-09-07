/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { type AstReflection, type Grammar, type LanguageMetaData, GrammarAST, GrammarUtils } from '@hydranium/langium';
import { type ServerSharedServicesMinimal } from '../langium/shared-services.js';

/** One terminal rule of a language's grammar, flattened for the reflection dump. */
export interface TerminalReflection {
   /** The terminal rule name. */
   name: string;
   /** The compiled pattern source, when it could be resolved to a `RegExp`. */
   pattern?: string;
   /** Hidden terminals (e.g. whitespace, comments) are lexed but not parsed. */
   hidden: boolean;
}

/** A single registered language's grammar surface. */
export interface LanguageReflection {
   /** The language id from `LanguageMetaData` (matches the LSP `languageId`). */
   languageId: string;
   /** File extensions the language claims, each with a leading dot. */
   fileExtensions: string[];
   /** The grammar's entry parser rule name, when one is marked `entry`. */
   entryRule?: string;
   /** Terminal rules, in grammar declaration order. */
   terminals: TerminalReflection[];
}

/** A property of an AST node type, as the runtime reflection exposes it. */
export interface PropertyReflection {
   /** The property name on the AST node. */
   name: string;
   /** For a cross-reference property, the target type name; absent for containment/values. */
   referenceType?: string;
   /** True when the property is a (possibly-empty) array — reflection defaults it to `[]`. */
   array: boolean;
   /**
    * True when the reflection carries a default value for the property (arrays default to
    * `[]`, some scalars to a literal). Reflection cannot distinguish optional from
    * mandatory beyond this, so the dump reports only what it can prove.
    */
   hasDefault: boolean;
}

/** One AST node type from the shared reflection (the superset across all languages). */
export interface TypeReflection {
   /** The `$type` value / grammar rule or interface name. */
   name: string;
   /** Declared super types (grammar `returns` / interface `extends`). */
   superTypes: string[];
   /** Types whose `superTypes` list this type directly (inverted, so a hierarchy tree is buildable). */
   directSubTypes: string[];
   /** Properties with their reflection meta data, sorted by name. */
   properties: PropertyReflection[];
}

/**
 * The full grammar/AST reflection of a head — a serialisable snapshot of the
 * type system and per-language grammar surface. This is the JSON contract
 * `hydranium-cli reflect --json` emits; it is independent of the Langium runtime
 * types so tooling reads a stable schema and the CLI needs no runtime
 * `@hydranium/core` dependency.
 */
export interface GrammarReflection {
   /** Every registered language's grammar surface, in registration order. */
   languages: LanguageReflection[];
   /** Every AST node type (the shared reflection superset), sorted by name. */
   types: TypeReflection[];
}

/** Options for {@link reflectGrammar}. */
export interface ReflectGrammarOptions {
   /**
    * Create the language's shared services in-process. This is the only
    * language-specific input — a head passes its own `create<Lang>Services(fileSystem)`.
    */
   createServices: () => { shared: ServerSharedServicesMinimal };
}

/** The language-service shape {@link collectGrammarReflection} reads (grammar + meta data). */
export interface ReflectableLanguageServices {
   Grammar: Grammar;
   LanguageMetaData: LanguageMetaData;
}

/** Resolve a terminal rule's pattern source, tolerating rules `terminalRegex` cannot compile. */
function terminalPattern(rule: GrammarAST.TerminalRule): string | undefined {
   try {
      return GrammarUtils.terminalRegex(rule).source;
   } catch {
      // Some terminal rules (e.g. those referencing not-yet-resolvable fragments) can't be
      // compiled to a standalone RegExp; the dump still lists the terminal, just pattern-less.
      return undefined;
   }
}

/** Flatten one language's grammar to its {@link LanguageReflection}. */
function reflectLanguage(services: ReflectableLanguageServices): LanguageReflection {
   const { Grammar: grammar, LanguageMetaData: meta } = services;
   const terminals: TerminalReflection[] = grammar.rules.filter(GrammarAST.isTerminalRule).map(rule => ({
      name: rule.name,
      pattern: terminalPattern(rule),
      hidden: rule.hidden === true
   }));
   const entryRule = grammar.rules.find((rule): rule is GrammarAST.ParserRule => GrammarAST.isParserRule(rule) && rule.entry === true);
   return {
      languageId: meta.languageId,
      fileExtensions: [...meta.fileExtensions],
      entryRule: entryRule?.name,
      terminals
   };
}

/**
 * Flatten a head's runtime reflection + registered languages into a serialisable
 * {@link GrammarReflection}. Pure over its inputs (the shared {@link AstReflection}
 * and the per-language grammar/meta-data services) so it unit-tests without booting
 * a grammar; {@link reflectGrammar} is the thin boot wrapper.
 *
 * `directSubTypes` is derived by inverting every type's `superTypes` — the runtime
 * reflection only exposes the transitive `getAllSubTypes`, and direct edges make a
 * hierarchy tree buildable without re-deriving it.
 */
export function collectGrammarReflection(reflection: AstReflection, languages: readonly ReflectableLanguageServices[]): GrammarReflection {
   const typeNames = [...reflection.getAllTypes()].sort((left, right) => left.localeCompare(right));

   // Invert superTypes → direct subtypes in one pass.
   const directSubTypes = new Map<string, string[]>();
   for (const name of typeNames) {
      for (const superType of reflection.getTypeMetaData(name).superTypes) {
         const children = directSubTypes.get(superType) ?? [];
         children.push(name);
         directSubTypes.set(superType, children);
      }
   }

   const types: TypeReflection[] = typeNames.map(name => {
      const meta = reflection.getTypeMetaData(name);
      const properties: PropertyReflection[] = Object.values(meta.properties)
         .map(property => ({
            name: property.name,
            referenceType: property.referenceType,
            array: Array.isArray(property.defaultValue),
            hasDefault: property.defaultValue !== undefined
         }))
         .sort((left, right) => left.name.localeCompare(right.name));
      return {
         name,
         superTypes: [...meta.superTypes],
         directSubTypes: (directSubTypes.get(name) ?? []).sort((left, right) => left.localeCompare(right)),
         properties
      };
   });

   return {
      languages: languages.map(reflectLanguage),
      types
   };
}

/**
 * Headless grammar/AST reflection — a static snapshot of a head's type system and
 * grammar surface, no workspace build required (the reflection and grammar are
 * available as soon as {@link ReflectGrammarOptions.createServices} registers the
 * language). Boots a head's Langium services in-process, then flattens the shared
 * {@link AstReflection} and every registered language's grammar into a serialisable
 * {@link GrammarReflection}.
 *
 * Backs `hydranium-cli reflect`. Like the other headless harnesses the only
 * language-specific input is the service factory, so the framework code stays
 * head-neutral.
 */
export function reflectGrammar(options: ReflectGrammarOptions): GrammarReflection {
   const { shared } = options.createServices();
   return collectGrammarReflection(shared.AstReflection, shared.ServiceRegistry.all);
}
