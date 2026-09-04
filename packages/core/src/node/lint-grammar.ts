/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { type AstReflection, GrammarAST } from '@hydranium/langium';
import { type ServerSharedServicesMinimal } from '../langium/shared-services.js';
import { type ReflectableLanguageServices } from './reflect-grammar.js';

/** The severity of a grammar-convention lint finding. */
export type LintSeverity = 'error' | 'warning';

/** One grammar-convention violation, flattened to a serialisable shape. */
export interface LintFinding {
   /** Stable rule id — a consumer may key on it, so it is part of the JSON contract. */
   rule: string;
   severity: LintSeverity;
   message: string;
   /** The language id the finding is scoped to, when language-specific. */
   language?: string;
   /** The AST node type the finding is about, when type-specific. */
   type?: string;
}

/** Per-severity tally — drives the exit code and the summary line. */
export interface LintCounts {
   error: number;
   warning: number;
}

/** The full result of a grammar-convention lint. */
export interface GrammarLintResult {
   /** Every violation found, in rule/discovery order. */
   findings: LintFinding[];
   counts: LintCounts;
   /** How many distinct cross-reference target types were checked for nameability. */
   checkedReferenceTargets: number;
   /** The name properties the lint treated as satisfying the nameability convention. */
   nameProperties: string[];
}

/** Options for {@link lintGrammar}. */
export interface LintGrammarOptions {
   /**
    * Create the language's shared services in-process. This is the only
    * language-specific input — a head passes its own `create<Lang>Services(fileSystem)`.
    */
   createServices: () => { shared: ServerSharedServicesMinimal };
   /**
    * Property names that satisfy the nameability convention. Defaults to the
    * framework default `['name']`; a head whose grammar carries the identifier on
    * a different property (e.g. `id`) passes its own set.
    */
   nameProperties?: readonly string[];
}

/** The framework's default name property (mirrors `NameProviderOptions.nameProperties`). */
const DEFAULT_NAME_PROPERTIES = ['name'] as const;

/** Invert every type's `superTypes` into a direct-subtype adjacency map. */
function directSubTypeMap(reflection: AstReflection): Map<string, string[]> {
   const map = new Map<string, string[]>();
   for (const name of reflection.getAllTypes()) {
      for (const superType of reflection.getTypeMetaData(name).superTypes) {
         const children = map.get(superType) ?? [];
         children.push(name);
         map.set(superType, children);
      }
   }
   return map;
}

/** The transitive closure `{ root } ∪ subtypes(root)`, walked over `directSubTypes` (cycle-safe). */
function typeClosure(root: string, directSubTypes: Map<string, string[]>): string[] {
   const seen = new Set<string>();
   const queue = [root];
   while (queue.length) {
      const current = queue.shift()!;
      if (seen.has(current)) {
         continue;
      }
      seen.add(current);
      queue.push(...(directSubTypes.get(current) ?? []));
   }
   return [...seen];
}

/** True when `type` declares at least one of the configured name properties. */
function isNameable(reflection: AstReflection, type: string, nameProperties: readonly string[]): boolean {
   const properties = reflection.getTypeMetaData(type).properties;
   return nameProperties.some(property => property in properties);
}

/**
 * Lint a head's grammar against the framework's conventions. Pure over its inputs
 * (the shared {@link AstReflection}, the per-language grammar services, and the
 * configured name properties) so it unit-tests without booting a grammar;
 * {@link lintGrammar} is the thin boot wrapper.
 *
 * Checks:
 * - **`reference-target-unnameable`** — every concrete (leaf) type reachable as a
 *   cross-reference target must carry a name property. Langium enforces that a
 *   referenced type *exists*, but not that it is *nameable*; the framework's
 *   name-based scoping can only resolve a reference to a named target, so an
 *   unnameable concrete target means references to it silently never resolve. Only
 *   leaves (no subtypes) are flagged — an abstract super type is not instantiated,
 *   so its own name property is irrelevant, and flagging it would be a false positive.
 * - **`no-entry-rule`** — a language whose grammar declares no entry parser rule
 *   cannot parse. Langium enforces this at grammar-generation time; the lint
 *   re-asserts it as a framework expectation for a completeness gate.
 */
export function collectGrammarLint(
   reflection: AstReflection,
   languages: readonly ReflectableLanguageServices[],
   nameProperties: readonly string[] = DEFAULT_NAME_PROPERTIES
): GrammarLintResult {
   const findings: LintFinding[] = [];

   for (const services of languages) {
      const hasEntryRule = services.Grammar.rules.some(rule => GrammarAST.isParserRule(rule) && rule.entry === true);
      if (!hasEntryRule) {
         findings.push({
            rule: 'no-entry-rule',
            severity: 'error',
            message: `Grammar '${services.LanguageMetaData.languageId}' declares no entry parser rule.`,
            language: services.LanguageMetaData.languageId
         });
      }
   }

   const directSubTypes = directSubTypeMap(reflection);

   // Collect every distinct cross-reference target type across all properties.
   const referenceTargets = new Set<string>();
   for (const type of reflection.getAllTypes()) {
      for (const property of Object.values(reflection.getTypeMetaData(type).properties)) {
         if (property.referenceType !== undefined) {
            referenceTargets.add(property.referenceType);
         }
      }
   }

   // Flag every unnameable concrete leaf reachable from a reference target (deduped).
   const unnameableLeaves = new Set<string>();
   for (const target of referenceTargets) {
      for (const candidate of typeClosure(target, directSubTypes)) {
         const isLeaf = (directSubTypes.get(candidate) ?? []).length === 0;
         if (isLeaf && !isNameable(reflection, candidate, nameProperties)) {
            unnameableLeaves.add(candidate);
         }
      }
   }
   for (const leaf of [...unnameableLeaves].sort((left, right) => left.localeCompare(right))) {
      findings.push({
         rule: 'reference-target-unnameable',
         severity: 'error',
         message:
            `Type '${leaf}' is a cross-reference target but carries no name property ` +
            `(expected one of: ${nameProperties.join(', ')}); references to it cannot resolve.`,
         type: leaf
      });
   }

   const counts: LintCounts = { error: 0, warning: 0 };
   for (const finding of findings) {
      counts[finding.severity] += 1;
   }
   return { findings, counts, checkedReferenceTargets: referenceTargets.size, nameProperties: [...nameProperties] };
}

/**
 * Headless grammar-convention lint — checks a head's grammar against the framework's
 * expectations (nameable cross-reference targets, an entry rule), no workspace build
 * required (the reflection and grammar are static once the head registers its
 * language). Boots a head's Langium services in-process, then runs
 * {@link collectGrammarLint}.
 *
 * Backs `hydranium-cli lint-grammar`, whose non-zero exit on errors makes it a CI
 * gate. Like the other headless harnesses the only language-specific input is the
 * service factory, so the framework code stays head-neutral.
 */
export function lintGrammar(options: LintGrammarOptions): GrammarLintResult {
   const { shared } = options.createServices();
   return collectGrammarLint(shared.AstReflection, shared.ServiceRegistry.all, options.nameProperties);
}
