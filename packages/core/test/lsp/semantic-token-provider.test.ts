/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, expect, it } from 'vitest';
import { type AstNode, type CstNode, type LangiumDocument, type Reference, type ReferenceInfo } from '@hydranium/langium';
import { CancellationToken, SemanticTokenTypes } from 'vscode-languageserver';
import {
   AbstractHydraniumSemanticTokenProvider,
   type HydraniumSemanticTokenProviderOptions,
   type SemanticTokenKind
} from '../../src/lsp/semantic-token-provider.js';
import type { ServerLanguageServices } from '../../src/langium/language-module.js';
import { makeFakeAstNode, makeFakeDocument } from '../../src/testing/index.js';

type AnyNode = AstNode & Record<string, unknown>;

/** What the acceptor was called with, flattened for assertion. */
interface Accepted {
   readonly property?: string;
   readonly index?: number;
   readonly cst?: CstNode;
   readonly type: string;
   readonly modifier?: string | string[];
}

/**
 * The base reaches for `references.NameProvider` and `shared.AstReflection`;
 * the upstream constructor additionally subscribes to
 * `shared.workspace.TextDocuments.onDidClose` and `shared.lsp.LanguageServer.onInitialize`.
 * `getReferenceType` is driven off a `$type`-keyed map so a test can declare
 * what the grammar says a reference points at without a real reflection.
 */
function makeServices(referenceTypes: Record<string, string> = {}, nameProperties: readonly string[] = ['name']): ServerLanguageServices {
   return {
      references: {
         NameProvider: {
            getNameProperty: (node?: AstNode) => {
               const indexed = node as unknown as Record<string, unknown> | undefined;
               return nameProperties.find(property => typeof indexed?.[property] === 'string');
            }
         }
      },
      shared: {
         AstReflection: {
            getReferenceType: (info: ReferenceInfo) => referenceTypes[`${info.container.$type}.${String(info.property)}`] ?? 'UnknownType'
         },
         workspace: { TextDocuments: { onDidClose: () => undefined } },
         lsp: { LanguageServer: { onInitialize: () => undefined } }
      }
   } as unknown as ServerLanguageServices;
}

/** Concrete provider under test: one `$type` → kind map, nothing else. */
class TestProvider extends AbstractHydraniumSemanticTokenProvider {
   constructor(
      services: ServerLanguageServices,
      private readonly kinds: Record<string, SemanticTokenKind> = {},
      options: HydraniumSemanticTokenProviderOptions = {}
   ) {
      super(services, options);
   }

   protected getTokenKind(type: string): SemanticTokenKind | undefined {
      return this.kinds[type];
   }

   /** Drive the protected entry point the way Langium's walk would. */
   run(node: AstNode): Accepted[] {
      const accepted: Accepted[] = [];
      this.highlightElement(node, options => accepted.push(options as unknown as Accepted));
      return accepted;
   }

   /**
    * Drive the whole document pass — both the AST walk and the keyword walk.
    *
    * The acceptor is spied rather than left to the inherited one on purpose:
    * `highlightToken` needs `currentDocument` and `currentTokensBuilder`, which
    * only the request entry points set, and going through them would trade the
    * emitted kinds for a flat integer stream and turn every assertion below
    * into wire-encoding arithmetic.
    */
   async runDocument(document: LangiumDocument): Promise<Accepted[]> {
      const accepted: Accepted[] = [];
      await this.computeHighlighting(document, options => accepted.push(options as unknown as Accepted), CancellationToken.None);
      return accepted;
   }
}

/**
 * A leaf CST node, identified only by the grammar element that produced it.
 *
 * `grammarSource` is the whole input to the keyword filter, so the fixtures
 * differ in nothing else. `tokenType` is present because `isLeafCstNode` keys
 * on it, and a leaf that fails that guard would make a passing test say
 * something other than what it claims.
 */
function makeLeafCst(text: string, grammarSourceType?: string): CstNode {
   return {
      text,
      tokenType: { name: text },
      grammarSource: grammarSourceType === undefined ? undefined : { $type: grammarSourceType }
   } as unknown as CstNode;
}

/** A composite CST node — `content` is what `streamCst` descends. */
function makeCompositeCst(content: readonly CstNode[]): CstNode {
   return { content, grammarSource: { $type: 'ParserRule' } } as unknown as CstNode;
}

/** A resolved-looking reference; `ref` is deliberately left undefined where resolution must not matter. */
function makeReference(refText: string, target?: AstNode): Reference {
   return { $refText: refText, ref: target } as unknown as Reference;
}

describe('AbstractHydraniumSemanticTokenProvider', () => {
   describe('declarations', () => {
      it('colours the name property reported by the NameProvider', () => {
         const provider = new TestProvider(makeServices(), { TypeOne: SemanticTokenTypes.class });
         const node = makeFakeAstNode<AnyNode>({ $type: 'TypeOne', name: 'Element' });

         expect(provider.run(node)).toEqual([{ node, property: 'name', type: SemanticTokenTypes.class, modifier: 'declaration' }]);
      });

      it('follows an id-keyed grammar without the provider hardcoding `name`', () => {
         const provider = new TestProvider(makeServices({}, ['id']), { TypeOne: SemanticTokenTypes.class });
         const node = makeFakeAstNode<AnyNode>({ $type: 'TypeOne', id: 'element-1' });

         expect(provider.run(node)[0]).toMatchObject({ property: 'id', type: SemanticTokenTypes.class });
      });

      it('emits nothing for a type the map does not cover', () => {
         const provider = new TestProvider(makeServices(), { TypeOne: SemanticTokenTypes.class });
         expect(provider.run(makeFakeAstNode<AnyNode>({ $type: 'UnknownType', name: 'Element' }))).toEqual([]);
      });

      it('emits nothing when the node has no readable name', () => {
         const provider = new TestProvider(makeServices(), { TypeOne: SemanticTokenTypes.class });
         expect(provider.run(makeFakeAstNode<AnyNode>({ $type: 'TypeOne' }))).toEqual([]);
      });

      it('lets the object form carry extra modifiers', () => {
         const provider = new TestProvider(makeServices(), {
            TypeOne: { type: SemanticTokenTypes.class, modifier: ['declaration', 'abstract'] }
         });
         const node = makeFakeAstNode<AnyNode>({ $type: 'TypeOne', name: 'Element' });

         expect(provider.run(node)[0]).toMatchObject({ modifier: ['declaration', 'abstract'] });
      });

      it('lets the object form suppress the declaration modifier', () => {
         const provider = new TestProvider(makeServices(), {
            SharedType: { type: SemanticTokenTypes.namespace, modifier: [] }
         });
         const node = makeFakeAstNode<AnyNode>({ $type: 'SharedType', name: 'Element' });

         expect(provider.run(node)[0]).toMatchObject({ type: SemanticTokenTypes.namespace, modifier: [] });
      });
   });

   describe('cross-references', () => {
      it('colours a single-valued reference by its DECLARED target type', () => {
         const provider = new TestProvider(makeServices({ 'TypeTwo.ref': 'TypeOne' }), {
            TypeTwo: SemanticTokenTypes.property,
            TypeOne: SemanticTokenTypes.class
         });
         const node = makeFakeAstNode<AnyNode>({ $type: 'TypeTwo', name: 'Element', ref: makeReference('Element1') });

         expect(provider.run(node)).toEqual([
            { node, property: 'name', type: SemanticTokenTypes.property, modifier: 'declaration' },
            { node, property: 'ref', index: undefined, type: SemanticTokenTypes.class }
         ]);
      });

      it('colours EVERY element of a multi-valued reference, with its index', () => {
         const provider = new TestProvider(makeServices({ 'TypeOne.members': 'TypeOne' }), { TypeOne: SemanticTokenTypes.class });
         const node = makeFakeAstNode<AnyNode>({
            $type: 'TypeOne',
            name: 'Element',
            members: [makeReference('Element1'), makeReference('Element2')]
         });

         const references = provider.run(node).filter(token => token.property === 'members');
         expect(references).toEqual([
            { node, property: 'members', index: 0, type: SemanticTokenTypes.class },
            { node, property: 'members', index: 1, type: SemanticTokenTypes.class }
         ]);
      });

      it('colours an UNRESOLVED reference — the declared type is known without resolution', () => {
         const provider = new TestProvider(makeServices({ 'TypeTwo.ref': 'TypeOne' }), { TypeOne: SemanticTokenTypes.class });
         // `ref` undefined: the target does not exist, as in a half-typed document.
         const node = makeFakeAstNode<AnyNode>({ $type: 'TypeTwo', ref: makeReference('ns.Missing') });

         expect(provider.run(node)).toEqual([{ node, property: 'ref', index: undefined, type: SemanticTokenTypes.class }]);
      });

      it('does not add the declaration modifier to a reference', () => {
         const provider = new TestProvider(makeServices({ 'TypeTwo.ref': 'TypeOne' }), { TypeOne: SemanticTokenTypes.class });
         const node = makeFakeAstNode<AnyNode>({ $type: 'TypeTwo', ref: makeReference('Element1') });

         expect(provider.run(node)[0].modifier).toBeUndefined();
      });

      it('leaves a reference uncoloured when its target type is not in the map', () => {
         const provider = new TestProvider(makeServices({ 'TypeTwo.ref': 'UnknownType' }), { TypeOne: SemanticTokenTypes.class });
         const node = makeFakeAstNode<AnyNode>({ $type: 'TypeTwo', ref: makeReference('Element1') });

         expect(provider.run(node)).toEqual([]);
      });
   });

   /**
    * The keyword pass. Driven through `computeHighlighting` rather than
    * `highlightElement`, because that is the only entry point it has — the pass
    * is deliberately NOT per-AST-node.
    */
   describe('highlightKeywords', () => {
      /**
       * `TypeOne Element { }`, with a hidden comment and a run of whitespace
       * among the leaves.
       *
       * The two non-keyword leaves are the discriminating part of the fixture:
       * a comment leaf carries its terminal rule as its grammar source and a
       * whitespace leaf may carry none at all, so a pass that emitted for every
       * leaf — or that guarded on `hidden` instead of on the grammar source —
       * would colour them and pass a fixture built only of keywords. The nested
       * composite is there for the same reason at the other axis: a pass that
       * looked at the root's direct children only would miss `}`.
       */
      function makeDocument(): LangiumDocument {
         const root = makeFakeAstNode<AnyNode>({
            $type: 'TypeOne',
            name: 'Element',
            $cstNode: makeCompositeCst([
               makeLeafCst('TypeOne', 'Keyword'),
               makeLeafCst(' ', undefined),
               makeLeafCst('Element', 'RuleCall'),
               makeLeafCst('// a note', 'TerminalRule'),
               makeCompositeCst([makeLeafCst('{', 'Keyword'), makeLeafCst('}', 'Keyword')])
            ])
         });
         return makeFakeDocument('file:///a.x', root);
      }

      /** The keyword tokens only, as the text of the leaves they were emitted for. */
      function keywordTexts(accepted: readonly Accepted[]): string[] {
         return accepted.filter(token => token.type === SemanticTokenTypes.keyword).map(token => token.cst?.text ?? '<no cst>');
      }

      it('emits no keyword token when the option is absent', async () => {
         const provider = new TestProvider(makeServices(), { TypeOne: SemanticTokenTypes.class });

         expect(keywordTexts(await provider.runDocument(makeDocument()))).toEqual([]);
      });

      it('emits one keyword token per keyword leaf, at any depth', async () => {
         const provider = new TestProvider(makeServices(), { TypeOne: SemanticTokenTypes.class }, { highlightKeywords: true });

         // `}` is inside a nested composite, so its presence is what says the
         // walk is over the whole CST rather than over the root's children.
         expect(keywordTexts(await provider.runDocument(makeDocument()))).toEqual(['TypeOne', '{', '}']);
      });

      it('emits keyword tokens by the `cst` form, so the acceptor derives the range', async () => {
         const provider = new TestProvider(makeServices(), {}, { highlightKeywords: true });

         const keywords = (await provider.runDocument(makeDocument())).filter(token => token.type === SemanticTokenTypes.keyword);
         // The absolute count first: `every` over an empty array is true, so a
         // keyword pass that emitted NOTHING would satisfy the form assertion
         // below, and this provider's empty kinds map leaves no other pass able
         // to backfill the array.
         expect(keywords).toHaveLength(3);
         // No `node`/`property` and no explicit range: an emitted position the
         // pass computed itself would be a second source of truth for where a
         // token is, and the `cst` form is what routes to `highlightNode`.
         expect(keywords.every(token => token.cst !== undefined && token.property === undefined)).toBe(true);
      });

      it('leaves the AST pass intact', async () => {
         const provider = new TestProvider(makeServices(), { TypeOne: SemanticTokenTypes.class }, { highlightKeywords: true });

         // The declaration token the `$type` map produces is still there, so
         // the two passes ADD rather than one replacing the other.
         expect(await provider.runDocument(makeDocument())).toContainEqual(
            expect.objectContaining({ property: 'name', type: SemanticTokenTypes.class })
         );
      });

      it('says nothing about a document with no CST', async () => {
         const provider = new TestProvider(makeServices(), { TypeOne: SemanticTokenTypes.class }, { highlightKeywords: true });
         // A document whose parse produced no CST at all — the state a request
         // arriving between a reset and a reparse observes.
         const document = makeFakeDocument('file:///a.x', makeFakeAstNode<AnyNode>({ $type: 'TypeOne', name: 'Element' }));

         expect(keywordTexts(await provider.runDocument(document))).toEqual([]);
      });
   });

   describe('overrides', () => {
      it('getReferenceKind can decide per property, overriding the type map', () => {
         class PerPropertyProvider extends TestProvider {
            protected override getReferenceKind(info: ReferenceInfo): SemanticTokenKind | undefined {
               return info.property === 'members' ? SemanticTokenTypes.interface : super.getReferenceKind(info);
            }
         }
         const provider = new PerPropertyProvider(makeServices({ 'TypeOne.members': 'TypeOne' }), { TypeOne: SemanticTokenTypes.class });
         const node = makeFakeAstNode<AnyNode>({ $type: 'TypeOne', members: [makeReference('Element2')] });

         expect(provider.run(node)[0]).toMatchObject({ type: SemanticTokenTypes.interface });
      });

      it('declarationModifier is overridable to none', () => {
         class NoModifierProvider extends TestProvider {
            protected override readonly declarationModifier = undefined;
         }
         const provider = new NoModifierProvider(makeServices(), { TypeOne: SemanticTokenTypes.class });
         const node = makeFakeAstNode<AnyNode>({ $type: 'TypeOne', name: 'Element' });

         expect(provider.run(node)[0].modifier).toBeUndefined();
      });
   });
});
