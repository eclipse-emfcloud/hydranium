/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/*
 * Generic Langium/LSP concept classifier — the default contribution every run
 * loads. Its `classify(node)` returns a Langium concept label or `undefined` to
 * defer to the next classifier / the engine fallback. Recognises class instances
 * by constructor and plain objects by their property-name set; AST nodes and
 * descriptions are sub-labelled by `$type` / element kind so the report can
 * break down by element. No application-specific vocabulary — heads contribute
 * their own classifier alongside this one.
 */

import { derefStringProp, has, propertySet, stringProp } from './concepts.mjs';

/** Concepts that own memory and act as exclusive-retained attribution anchors.
 *  (CST/AST node/AstNodeDescription are matched by prefix in `isAnchor`.) */
const ANCHOR_CONCEPTS = ['Range', 'Position', 'DocumentSegment', 'MultiMap', 'Map', 'LangiumDocument', 'ParseResult', 'Reference'];

/**
 * CST node constructors → their role, so CST drills down like AST
 * (`CST:leaf`/`CST:composite`/`CST:root`/`CST:container`). Generic Langium names,
 * no language coupling. A bundled server may prefix `_`, hence the lookup strips
 * a leading underscore.
 */
const CST_ROLE = {
   LeafCstNodeImpl: 'leaf',
   CompositeCstNodeImpl: 'composite',
   RootCstNodeImpl: 'root',
   CstNodeContainer: 'container'
};

/**
 * AST node $types from Langium's OWN grammar language. These appear in a
 * language-server heap (the parsed .langium grammar) but never in an adopter's
 * document model, so a `--validate` cross-check treats them as expected
 * snapshot-only rather than a discrepancy. Generic Langium, not app-specific.
 */
const LANGIUM_GRAMMAR_TYPES = [
   'Grammar',
   'GrammarImport',
   'AbstractRule',
   'ParserRule',
   'TerminalRule',
   'InfixRule',
   'Type',
   'Interface',
   'AbstractType',
   'Action',
   'Alternatives',
   'Group',
   'UnorderedGroup',
   'Assignment',
   'RuleCall',
   'CrossReference',
   'Keyword',
   'RegexToken',
   'TerminalAlternatives',
   'TerminalGroup',
   'TerminalRuleCall',
   'CharacterRange',
   'NegatedToken',
   'UntilToken',
   'Wildcard',
   'EndOfFile',
   'SimpleType',
   'ReferenceType',
   'ArrayType',
   'UnionType',
   'TypeAttribute',
   'ParameterReference',
   'ReturnType',
   'NamedArgument',
   'Parameter',
   'Conjunction',
   'Disjunction',
   'Negation',
   'BooleanLiteral',
   'NumberLiteral',
   'StringLiteral'
];

/** @type {import('./concepts.mjs').ConceptClassifier} */
export const langiumClassifier = {
   classify(node) {
      const { type, name } = node;
      if (type !== 'object') {
         return undefined; // primitives are the engine's baseline
      }

      // Class instances: recognised by constructor name.
      if (name && name !== 'Object') {
         const cstRole = CST_ROLE[name.startsWith('_') ? name.slice(1) : name];
         if (cstRole) {
            // A leaf is a single token; sub-label by its token type
            // (`_tokenType.name` — `ID`, `STRING`, or the keyword text), so the
            // CST breakdown shows which tokens dominate (e.g. trivia vs identifiers).
            if (cstRole === 'leaf') {
               const token = derefStringProp(node, '_tokenType', 'name')?.trim();
               if (!token) {
                  return 'CST:leaf';
               }
               // Token names are either identifier-like (terminals `ID`/`STRING`,
               // keywords `name`/`value`) or punctuation (`:`/`{`/`;`). Bucket
               // punctuation together: per-mark counts are noise, and a literal `:`
               // would corrupt the `:`-delimited label path (and `>` the ` > `
               // display) if embedded as a segment.
               return /^[A-Za-z_][\w-]*$/.test(token) ? `CST:leaf:${token}` : 'CST:leaf:(punctuation)';
            }
            return `CST:${cstRole}`;
         }
         // Any class whose name ends in AstNodeDescription is a description wrapper;
         // the prefix is the scope layer (Local, Global, ...). Labelled
         // `AstNodeDescription:<layer>` so it nests under the description family at
         // L2 (the bases sit at `AstNodeDescription:base:<kind>`). Generic: no app names.
         if (name.endsWith('AstNodeDescription')) {
            const layer = name.slice(0, -'AstNodeDescription'.length) || 'base';
            return `AstNodeDescription:${layer}`;
         }
         // Index manager is an attribution anchor but keeps its real name; Map/MultiMap
         // stay their own names too (referrer edges show which are the scope index).
         if (name.endsWith('IndexManager') || name === 'MultiMap' || name === 'Map') {
            return name;
         }
         return undefined; // defer (engine → class:<name>, or a later classifier)
      }

      // Plain object literal: classify by property-name set.
      const props = propertySet(node);
      if (props.size === 0) {
         // A Position {line,character} whose numeric fields are inline SMIs has NO
         // property edges on the heap, so it looks empty. Recover it from an
         // incoming Range `start`/`end` edge — otherwise the millions of Range
         // endpoints misbucket as 'empty object {}' (the biggest single
         // misclassification on a large workspace).
         for (const edge of node.referrers) {
            if (edge.type === 'property' && (edge.name_or_index === 'start' || edge.name_or_index === 'end')) {
               return 'Position';
            }
         }
         return undefined; // defer → engine 'empty object {}'
      }
      if (props.has('$type')) {
         return `AST node:${stringProp(node, '$type') ?? 'unknown'}`;
      }
      if (props.size === 2 && has(props, 'start', 'end')) {
         return 'Range';
      }
      if (has(props, 'line', 'character')) {
         return 'Position';
      }
      if (has(props, 'parseResult', 'uri') || has(props, 'localSymbols', 'parseResult', 'uri')) {
         return 'LangiumDocument';
      }
      if (has(props, 'value', 'lexerErrors', 'parserErrors')) {
         return 'ParseResult';
      }
      if (has(props, 'name', 'nameSegment', 'documentUri', 'node', 'selectionSegment')) {
         // The base description payload carries `type` = the described node's element
         // kind. Labelled `AstNodeDescription:base:<kind>` so it nests under the
         // description family: L2 `base` aggregates all payloads (alongside the L2
         // scope-wrapper layers above), L3 `<kind>` is the per-element-kind split.
         return `AstNodeDescription:base:${stringProp(node, 'type') ?? 'unknown'}`;
      }
      if (has(props, '$refText', 'ref')) {
         return 'Reference';
      }
      if (has(props, 'range') && props.size <= 3) {
         return 'DocumentSegment';
      }
      return undefined; // defer → engine 'other Object shape'
   },

   anchorConcepts: ANCHOR_CONCEPTS,
   grammarTypes: LANGIUM_GRAMMAR_TYPES,

   // Matches both the raw per-node labels (`AST node:Class`, used as exclusive-
   // retained attribution anchors) and the bare group (`AST node`, used to pick
   // top concepts for the retainer-path sample). `AstNodeDescription` prefix
   // already covers the group and every layer/base path.
   isAnchor(label) {
      return (
         label.startsWith('AST node') || label.startsWith('AstNodeDescription') || label.startsWith('CST') || label.endsWith('IndexManager')
      );
   },

   descriptions: {
      'AST node':
         'Parsed abstract-syntax-tree nodes, split by `$type` (includes the Langium grammar AST since the parsed grammar shares the heap).',
      AstNodeDescription:
         'Scope-index entries. `base` is the payload (one per exported symbol, split by element kind); `Local`/`Global`/… are thin per-scope-layer wrappers that delegate to a base.',
      CST: 'Concrete-syntax-tree nodes: `leaf` = a token (sub-split by token type — `ID`, `STRING`, keyword text, with all punctuation bucketed as `(punctuation)`), `composite` = a grammar rule, `root` = a document root, `container` = a child-node array.',
      Range: 'LSP text ranges (`start`/`end` Position pairs) attached to CST nodes and document segments.',
      Position:
         'LSP `{line, character}` endpoints of Ranges (their numeric fields are inline, so they carry no heap properties of their own).'
   }
};
