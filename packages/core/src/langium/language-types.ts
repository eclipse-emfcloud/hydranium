/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { AstUtils, GrammarAST, type Grammar, type LanguageMetaData } from '@hydranium/langium';

/**
 * The two slots {@link buildLanguageTypeIndex} reads off a registered language.
 * Narrowed to exactly this rather than taking `LangiumCoreServices` so the
 * index is testable against a grammar plus an id, and so the signature states
 * what it actually touches. A real service tree satisfies it structurally.
 */
export interface TypedLanguage {
   readonly Grammar: Grammar;
   readonly LanguageMetaData: LanguageMetaData;
}

/**
 * Which registered language can produce a given AST `$type`.
 *
 * **Why this exists.** Langium routes languages by file extension, so a request
 * that names no document — an element id, or a synthetic node addressing a
 * directory URI during a create-element flow — has no URI to route by. What it
 * does carry is an AST type. The obvious resolver, `AstReflection`, cannot help:
 * Langium declares it in `LangiumGeneratedSharedCoreServices`, i.e. ONE
 * reflection per project covering every grammar, with no language attribution.
 * `Grammar`, on the other hand, is a per-language service — so the attribution
 * is recoverable from the grammars themselves.
 *
 * Build it once (grammar walks are not cheap) and query per request; the
 * registered set is fixed after bootstrap.
 */
export interface LanguageTypeIndex<TLanguage extends TypedLanguage = TypedLanguage> {
   /**
    * Languages whose grammar can produce `type`, in registration order.
    * Empty when no grammar produces it; more than one when several do (types
    * reached through a shared imported grammar), which is the caller's signal
    * that the type alone does not identify a language.
    */
   languagesFor(type: string): readonly TLanguage[];
   /** Every AST `$type` the language with this id can produce. */
   typesOf(languageId: string): ReadonlySet<string>;
}

/**
 * Parser rules a document of this language can actually reach — the entry rule
 * and everything transitively rule-called from it, fragments included (they are
 * traversed for their own calls even though they contribute no type).
 *
 * **Reachability, not mere presence.** Langium grammar imports pull the
 * imported grammar's rules into the importing grammar wholesale, so a grammar
 * that imports another purely for a cross-reference target ends up
 * *containing* all of that grammar's rules — including rules no document of
 * the importing language can hold. Walking from the entry rule is what
 * separates "this grammar mentions the rule" from "a document of this
 * language can contain such a node".
 *
 * Cross-references are deliberately NOT followed: a `[Target:ID]` assignment
 * names a link target, not containment.
 *
 * Falls back to every parser rule when the grammar declares no entry rule —
 * a grammar fragment used only through imports, where reachability is
 * undefined and over-reporting is safer than reporting nothing.
 */
function reachableParserRules(grammar: Grammar | undefined): GrammarAST.ParserRule[] {
   const parserRules = (grammar?.rules ?? []).filter(GrammarAST.isParserRule);
   const entry = parserRules.find(rule => rule.entry);
   if (!entry) {
      return parserRules;
   }
   const visited = new Set<GrammarAST.ParserRule>();
   const queue = [entry];
   while (queue.length > 0) {
      const rule = queue.pop()!;
      if (visited.has(rule)) {
         continue;
      }
      visited.add(rule);
      for (const node of AstUtils.streamAllContents(rule)) {
         // A rule call inside a cross-reference is the link's token, not
         // containment — `streamAllContents` would otherwise walk into it.
         if (GrammarAST.isRuleCall(node) && !GrammarAST.isCrossReference(node.$container)) {
            const called = node.rule.ref;
            if (called && GrammarAST.isParserRule(called)) {
               queue.push(called);
            }
         }
      }
   }
   return [...visited];
}

/**
 * Whether a declared grammar `type` resolves to literals and primitives only —
 * `type OpKind = '=' | '!='` — as opposed to unioning AST node types.
 *
 * Decided on the leaves: every `SimpleType` in the definition tree carries
 * exactly one of `stringType` (a keyword literal), `primitiveType`, or
 * `typeRef` (a reference to another grammar type). A single `typeRef` anywhere
 * means the type can denote a node, so it is not literal-only.
 *
 * Returns `false` when the definition has no `SimpleType` leaf at all, so a
 * shape this decision does not recognise leaves the rule counted rather than
 * silently dropped.
 */
function isLiteralOnlyType(declared: GrammarAST.Type): boolean {
   let sawLeaf = false;
   for (const node of [declared.type, ...AstUtils.streamAllContents(declared.type)]) {
      if (GrammarAST.isSimpleType(node)) {
         if (node.typeRef) {
            return false;
         }
         sawLeaf = true;
      }
   }
   return sawLeaf;
}

/**
 * The AST `$type`s a grammar can actually produce — the types of the parser
 * rules a document of the language can reach, plus the types assigned by
 * `{infer X}` / `{X}` actions inside those rules.
 *
 * **Produced, not mentioned.** A grammar that only cross-references a type
 * carries that type in its serialised grammar without any rule producing it —
 * a document of that language can never contain such a node. Collecting
 * mentions instead would report every language that merely links to a type,
 * which for a grammar pair that cross-references is most of them.
 *
 * Three rule kinds are skipped because none yields an AST node type:
 * - **fragments** (`fragment Foo: …`), which splice their assignments into the
 *   calling rule's object. `langium-cli` generates no type for them, so
 *   counting the rule name would invent types the `AstReflection` has never
 *   heard of — and a fragment shared through an imported grammar would be
 *   attributed to every language that imports it.
 * - **data-type rules** (`QualifiedName returns string: …`), which produce a
 *   primitive value rather than a node.
 * - **rules returning a declared literal-union type** — the
 *   `type OpKind = '=' | '!='; OpKind returns OpKind: '=' | '!=';` idiom.
 *   `langium-cli` emits these as TypeScript string-union aliases, never as
 *   reflected node types, so counting them made `assertReflectionCoversLanguages`
 *   warn on every boot of any grammar using the idiom, and put phantom entries
 *   in this index for types no document can ever contain. Such a rule's
 *   `dataType` is NOT set — the return type is a declared union, not a
 *   primitive — so the data-type skip does not catch it, and
 *   {@link isLiteralOnlyType} decides it instead.
 *
 * A declared type that unions AST node types (`type Expr = Binary | Unary`) is
 * deliberately still counted: `langium-cli` reflects those, so dropping them
 * would hide real coverage gaps rather than false ones.
 */
export function collectProducibleTypes(grammar: Grammar | undefined): Set<string> {
   const types = new Set<string>();
   // A real language always binds `Grammar` (Langium requires it in
   // `LangiumGeneratedCoreServices`, and `assertCoreSlotsBound` fails the boot
   // without it). Tolerated here anyway so a routing lookup degrades to "this
   // language produces nothing" rather than throwing a TypeError mid-request.
   for (const rule of reachableParserRules(grammar)) {
      if (rule.fragment || rule.dataType !== undefined) {
         continue;
      }
      const returnedType = rule.returnType?.ref;
      if (returnedType && GrammarAST.isType(returnedType) && isLiteralOnlyType(returnedType)) {
         continue;
      }
      // A parser rule's type: an explicit `returns X`, an `infer X`, else the
      // rule name (Langium's default inferred type).
      const declared = rule.returnType?.ref?.name ?? rule.inferredType?.name ?? rule.name;
      types.add(declared);
      // Actions rewrite the current object's type mid-rule, so they produce
      // types no rule signature mentions.
      for (const node of AstUtils.streamAllContents(rule)) {
         if (GrammarAST.isAction(node)) {
            const actionType = node.inferredType?.name ?? node.type?.ref?.name;
            if (actionType) {
               types.add(actionType);
            }
         }
      }
   }
   return types;
}

/**
 * Build a {@link LanguageTypeIndex} over the registered languages. Pure over
 * its input so it unit-tests against hand-built grammars without a boot.
 */
export function buildLanguageTypeIndex<TLanguage extends TypedLanguage>(languages: readonly TLanguage[]): LanguageTypeIndex<TLanguage> {
   const byType = new Map<string, TLanguage[]>();
   const byLanguage = new Map<string, ReadonlySet<string>>();
   for (const language of languages) {
      const types = collectProducibleTypes(language.Grammar);
      byLanguage.set(language.LanguageMetaData.languageId, types);
      for (const type of types) {
         const owners = byType.get(type);
         if (owners) {
            owners.push(language);
         } else {
            byType.set(type, [language]);
         }
      }
   }
   const none: readonly TLanguage[] = [];
   const empty: ReadonlySet<string> = new Set();
   return {
      languagesFor: type => byType.get(type) ?? none,
      typesOf: languageId => byLanguage.get(languageId) ?? empty
   };
}
