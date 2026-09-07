/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, expect, it } from 'vitest';
import type { Grammar } from '@hydranium/langium';
import { buildLanguageTypeIndex, collectProducibleTypes, type TypedLanguage } from '../../src/langium/language-types.js';

// Grammar ASTs are built here as the minimal shapes the collector reads, not
// parsed from `.langium` text: parsing would pull Langium's grammar language
// into the framework's test deps (outside the pinned `@hydranium/langium`
// surface) for no extra signal at this level. What these hand-built shapes
// cannot show is that the collector agrees with REAL `langium-cli` output, so
// the counterpart check belongs where two generated grammars exist and one
// cross-references the other's types — which is an adopter, not the framework.

/** A parser rule whose produced type is the rule name (Langium's default inference). */
function rule(name: string, ...contents: object[]): object {
   return { $type: 'ParserRule', name, definition: { $type: 'Group', elements: contents } };
}

/** A parser rule with an explicit `returns X`. */
function returningRule(name: string, returns: string): object {
   return { $type: 'ParserRule', name, returnType: { ref: { name: returns } }, definition: { $type: 'Group', elements: [] } };
}

/** A parser rule with an `infers X`. */
function inferringRule(name: string, infers: string): object {
   return {
      $type: 'ParserRule',
      name,
      inferredType: { $type: 'InferredType', name: infers },
      definition: { $type: 'Group', elements: [] }
   };
}

/** An `{infer X}` action nested in a rule body. */
function action(infers: string): object {
   return { $type: 'Action', inferredType: { $type: 'InferredType', name: infers } };
}

/** A declared `type X = 'a' | 'b'` — literals only, so `langium-cli` emits a string-union alias. */
function literalUnionType(name: string): object {
   return {
      $type: 'Type',
      name,
      type: {
         $type: 'UnionType',
         types: [
            { $type: 'SimpleType', stringType: 'a' },
            { $type: 'SimpleType', stringType: 'b' }
         ]
      }
   };
}

/** A declared `type X = A | B` over AST node types, which `langium-cli` DOES reflect. */
function nodeUnionType(name: string, ...members: string[]): object {
   return {
      $type: 'Type',
      name,
      type: {
         $type: 'UnionType',
         types: members.map(member => ({ $type: 'SimpleType', typeRef: { ref: { name: member } } }))
      }
   };
}

/** A parser rule whose `returns` names a declared grammar `type` rather than an interface. */
function returningDeclaredType(name: string, declared: object): object {
   return { $type: 'ParserRule', name, returnType: { ref: declared }, definition: { $type: 'Group', elements: [] } };
}

/** A cross-reference to a type this grammar does NOT produce. */
function crossReference(target: string): object {
   return { $type: 'CrossReference', type: { ref: { name: target } } };
}

/** The entry rule — the only root reachability starts from. */
function entryRule(name: string, ...contents: object[]): object {
   return { $type: 'ParserRule', name, entry: true, definition: { $type: 'Group', elements: contents } };
}

/** A `fragment Foo: …` rule, which splices into its callers and gets no type of its own. */
function fragmentRule(name: string, ...contents: object[]): object {
   return { $type: 'ParserRule', name, fragment: true, definition: { $type: 'Group', elements: contents } };
}

/**
 * A containment call to another rule. `$container` is set because the collector
 * distinguishes a plain call from one inside a cross-reference by looking at it.
 */
function ruleCall(target: object): object {
   return { $type: 'RuleCall', rule: { ref: target }, $container: { $type: 'Group' } };
}

/** A cross-reference whose link target is a rule in this grammar. */
function crossReferenceTo(target: object): object {
   const reference: Record<string, unknown> = { $type: 'CrossReference', type: { ref: target } };
   reference.terminal = { $type: 'RuleCall', rule: { ref: target }, $container: reference };
   return reference;
}

function grammarOf(...rules: object[]): Grammar {
   return { $type: 'Grammar', rules } as unknown as Grammar;
}

function languageOf(languageId: string, grammar: Grammar): TypedLanguage {
   return { Grammar: grammar, LanguageMetaData: { languageId, fileExtensions: [], caseInsensitive: false, mode: 'development' } };
}

/** A grammar that links to a type from another grammar it cannot itself hold. */
const LANG_A = grammarOf(rule('Root'), rule('Element', crossReference('OtherElement')));
const LANG_B = grammarOf(rule('OtherRoot'), rule('OtherElement'));

describe('collectProducibleTypes', () => {
   it('takes a rule name, an explicit returns, and an infers', () => {
      const types = collectProducibleTypes(grammarOf(rule('Root'), returningRule('Named', 'Renamed'), inferringRule('Other', 'Inferred')));

      expect(types.has('Root')).toBe(true);
      expect(types.has('Renamed')).toBe(true);
      expect(types.has('Inferred')).toBe(true);
      // A rule that declares another type does not also produce its own name.
      expect(types.has('Named')).toBe(false);
      expect(types.has('Other')).toBe(false);
   });

   it('takes a type an action assigns mid-rule', () => {
      // `Expression: Primary ({infer Binary.left=current} '+' right=Primary)*;`
      const types = collectProducibleTypes(grammarOf(rule('Expression', action('Binary'))));

      expect(types.has('Expression')).toBe(true);
      expect(types.has('Binary')).toBe(true);
   });

   it('excludes a type the grammar only cross-references', () => {
      const types = collectProducibleTypes(LANG_A);

      expect(types.has('Element')).toBe(true);
      // The distinction the whole index rests on: a document of this language
      // can never hold one, though the type is reachable in the grammar and
      // present in its serialised form.
      expect(types.has('OtherElement')).toBe(false);
   });

   it('counts only rules reachable from the entry rule', () => {
      // Importing a grammar pulls ALL its rules in, so an imported rule no
      // document position can reach must not be attributed.
      const called = rule('Called');
      const grammar = grammarOf(entryRule('Root', ruleCall(called)), called, rule('ImportedButUnreachable'));

      const types = collectProducibleTypes(grammar);
      expect(types.has('Root')).toBe(true);
      expect(types.has('Called')).toBe(true);
      expect(types.has('ImportedButUnreachable')).toBe(false);
   });

   it('does not follow a cross-reference into the referenced rule', () => {
      // A `[LangB:ID]` cross-reference is a link target, not containment.
      const langB = rule('LangB');
      const grammar = grammarOf(entryRule('Root', crossReferenceTo(langB)), langB);

      expect(collectProducibleTypes(grammar).has('LangB')).toBe(false);
   });

   it('traverses a fragment for its calls without counting the fragment itself', () => {
      const inner = rule('Inner');
      const shared = fragmentRule('SharedContent', ruleCall(inner));
      const grammar = grammarOf(entryRule('Root', ruleCall(shared)), shared, inner);

      const types = collectProducibleTypes(grammar);
      expect(types.has('Inner')).toBe(true);
      // `langium-cli` generates no type for a fragment.
      expect(types.has('SharedContent')).toBe(false);
   });

   it('falls back to every parser rule when the grammar declares no entry rule', () => {
      // A grammar used only through imports has no defined reachability.
      const types = collectProducibleTypes(grammarOf(rule('One'), rule('Two')));

      expect(types.has('One')).toBe(true);
      expect(types.has('Two')).toBe(true);
   });

   it('ignores non-parser rules', () => {
      const types = collectProducibleTypes(grammarOf(rule('Root'), { $type: 'TerminalRule', name: 'ID' }));

      expect(types.has('ID')).toBe(false);
      expect(types.size).toBe(1);
   });

   it('excludes a rule returning a declared literal-union type', () => {
      // `type OpKind = '=' | '!='; OpKind returns OpKind: '=' | '!=';` — emitted
      // by langium-cli as a string-union alias, never reflected as a node type.
      // Its `dataType` is unset (the return type is a declared union, not a
      // primitive), so the data-type skip does not catch it.
      const opRule = returningDeclaredType('OpKind', literalUnionType('OpKind'));
      const types = collectProducibleTypes(grammarOf(entryRule('Root', ruleCall(opRule)), opRule));

      expect(types.has('OpKind')).toBe(false);
      expect(types.has('Root')).toBe(true);
   });

   it('counts a rule returning a declared union of node types', () => {
      // `type Expr = Binary | Unary` IS reflected, so dropping it would hide a
      // real coverage gap. The discriminator is a `typeRef` on the leaves.
      const exprRule = returningDeclaredType('Expr', nodeUnionType('Expr', 'Binary', 'Unary'));
      const types = collectProducibleTypes(grammarOf(entryRule('Root', ruleCall(exprRule)), exprRule));

      expect(types.has('Expr')).toBe(true);
   });
});

describe('buildLanguageTypeIndex', () => {
   it('attributes a type to the language whose grammar produces it', () => {
      const langA = languageOf('langA', LANG_A);
      const langB = languageOf('langB', LANG_B);
      const index = buildLanguageTypeIndex([langA, langB]);

      expect(index.languagesFor('Element')).toEqual([langA]);
      // Attributed to the producer alone, though the langA grammar links to it.
      expect(index.languagesFor('OtherElement')).toEqual([langB]);
   });

   it('reports every owner of a type both grammars produce', () => {
      const first = languageOf('first', grammarOf(rule('RootA'), rule('SharedType')));
      const second = languageOf('second', grammarOf(rule('RootB'), rule('SharedType')));
      const index = buildLanguageTypeIndex([first, second]);

      // Ambiguous by construction — a caller must not guess from this.
      expect(index.languagesFor('SharedType')).toEqual([first, second]);
      expect(index.languagesFor('RootA')).toEqual([first]);
   });

   it('answers empty for an unknown type and an unknown language', () => {
      const index = buildLanguageTypeIndex([languageOf('langA', LANG_A)]);

      expect(index.languagesFor('NoSuchType')).toEqual([]);
      expect(index.typesOf('no-such-language').size).toBe(0);
      expect(index.typesOf('langA').has('Element')).toBe(true);
   });
});
