/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, expect, it } from 'vitest';
import { type AstNode, type AstNodeDescription, type ReferenceInfo, type Scope, stream, URI } from '@hydranium/langium';
import { type CompletionContext, type CompletionValueItem } from '@hydranium/langium/lsp';
import { TextDocument } from 'vscode-languageserver-textdocument';
import type { CompletionItem, InsertReplaceEdit } from 'vscode-languageserver';
import { HydraniumCompletionProvider } from '../../../src/lsp/completion/hydranium-completion-provider.js';
import { DefaultReferenceCandidateProvider } from '../../../src/langium/scope/reference-candidate-provider.js';
import { type DescriptionTier } from '../../../src/langium/scope/scoped-ast-node-description.js';
import { makeFakeAstNode, makeNoopLanguageServices } from '../../../src/testing/index.js';

function description(name: string, tier: DescriptionTier, path: string): AstNodeDescription {
   const value: AstNodeDescription = { name, type: 'Fake', documentUri: URI.parse('memory://test'), path, node: undefined };
   (value as unknown as Record<string, string>).tier = tier;
   return value;
}

/** Exposes the protected cross-reference candidate hook for testing. */
class TestCompletionProvider extends HydraniumCompletionProvider {
   getReferenceCandidatesPublic(refInfo: ReferenceInfo, context: CompletionContext) {
      return this.getReferenceCandidates(refInfo, context);
   }

   fillCompletionItemPublic(context: CompletionContext, item: CompletionValueItem) {
      return this.fillCompletionItem(context, item);
   }
}

function makeProvider(elements: AstNodeDescription[], fuzzyMatch = true): TestCompletionProvider {
   const scope: Scope = {
      getAllElements: () => stream(elements),
      getElement: () => undefined,
      getElements: () => stream([])
   } as unknown as Scope;
   // The DefaultCompletionProvider constructor only assigns services; getReferenceCandidates
   // reads scopeProvider.getScope alone, so empty stubs for the rest suffice.
   const services = makeNoopLanguageServices({
      references: { ScopeProvider: { getScope: () => scope }, NameProvider: {} },
      Grammar: {},
      // `nameRegexp` is Langium's own default, and it is load-bearing here:
      // `getReplaceEndOffset` scans the document with it to find a name that
      // begins at the cursor.
      parser: { CompletionParser: {}, Lexer: {}, GrammarConfig: { nameRegexp: /\w/ } },
      documentation: { DocumentationProvider: {} },
      // FuzzyMatcher.match must return true for the base buildCompletionTextEdit to emit a TextEdit;
      // pass `false` to drive the base into returning `undefined` (no TextEdit built).
      shared: { lsp: { NodeKindProvider: {}, FuzzyMatcher: { match: () => fuzzyMatch } }, AstReflection: {} }
   });
   return new TestCompletionProvider(services);
}

describe('HydraniumCompletionProvider cross-reference candidates', () => {
   const context = {} as CompletionContext;

   it('collapses tier-siblings of one node to the most-specific tier', () => {
      const { completion, refInfo } = makeWired([
         description('ns.Element', 'public', '/Element'),
         description('Element', 'project', '/Element')
      ]);
      const names = completion
         .getReferenceCandidatesPublic(refInfo, context)
         .map(d => d.name)
         .toArray();
      expect(names).toEqual(['Element']);
   });

   it('keeps the most-specific-tier sibling, not merely the right name', () => {
      // project (rank 1) is narrower than public (rank 2), so the project sibling must survive.
      const { completion, refInfo } = makeWired([
         description('ns.Element', 'public', '/Element'),
         description('Element', 'project', '/Element')
      ]);
      const survivors = completion.getReferenceCandidatesPublic(refInfo, context).toArray();
      expect(survivors).toHaveLength(1);
      expect((survivors[0] as unknown as Record<string, string>).tier).toBe('project');
   });

   it('keeps distinct nodes (different paths)', () => {
      const { completion, refInfo } = makeWired([description('A', 'project', '/A'), description('B', 'project', '/B')]);
      const names = completion
         .getReferenceCandidatesPublic(refInfo, context)
         .map(d => d.name)
         .toArray();
      expect(names.sort()).toEqual(['A', 'B']);
   });
});

/**
 * Wires a completion provider and a real candidate provider over ONE shared
 * scope stub, so the test can assert the completion path gathers identically
 * to the candidate-provider pipeline.
 */
function makeWired(elements: AstNodeDescription[]): {
   completion: TestCompletionProvider;
   candidate: DefaultReferenceCandidateProvider;
   refInfo: ReferenceInfo;
} {
   const scope: Scope = {
      getAllElements: () => stream(elements),
      getElement: () => undefined,
      getElements: () => stream([])
   } as unknown as Scope;
   const container = makeFakeAstNode<AstNode>({ $type: 'Source' });
   (container as unknown as { $document: { uri: URI } }).$document = { uri: URI.parse('memory://test') };
   const refInfo: ReferenceInfo = { reference: { $refText: '', ref: undefined }, container, property: 'ref' };
   const scopeProvider = {
      getScope: () => scope,
      referenceContextToInfo: () => refInfo,
      sortText: (description: AstNodeDescription) => description.name
   };
   const services = makeNoopLanguageServices({
      references: { ScopeProvider: scopeProvider, NameProvider: { getDisplayName: () => undefined } },
      Grammar: {},
      // `nameRegexp` is Langium's own default, and it is load-bearing here:
      // `getReplaceEndOffset` scans the document with it to find a name that
      // begins at the cursor.
      parser: { CompletionParser: {}, Lexer: {}, GrammarConfig: { nameRegexp: /\w/ } },
      documentation: { DocumentationProvider: {} },
      shared: {
         workspace: { ProjectManager: { getProject: () => undefined } },
         lsp: { NodeKindProvider: {}, FuzzyMatcher: { match: () => true } },
         AstReflection: {}
      }
   });
   const candidate = new DefaultReferenceCandidateProvider(services as never);
   (services as unknown as { references: { CandidateProvider: unknown } }).references.CandidateProvider = candidate;
   const completion = new TestCompletionProvider(services);
   return { completion, candidate, refInfo };
}

describe('HydraniumCompletionProvider gathering delegates to the candidate pipeline', () => {
   it('gathers identically to the candidate provider (name-dedup + sort)', () => {
      // Out-of-order names plus a same-name distinct-node pair: the candidate
      // pipeline dedups by name and sorts; the raw scope walk does neither.
      const elements = [description('B', 'project', '/B'), description('A', 'project', '/A1'), description('A', 'project', '/A2')];
      const { completion, candidate, refInfo } = makeWired(elements);
      const context = {} as CompletionContext;
      const fromCandidate = candidate
         .getCandidateScope(refInfo)
         .elementScope.getAllElements()
         .map(d => d.name)
         .toArray();
      const fromCompletion = completion
         .getReferenceCandidatesPublic(refInfo, context)
         .map(d => d.name)
         .toArray();
      expect(fromCandidate).toEqual(['A', 'B']);
      expect(fromCompletion).toEqual(fromCandidate);
   });
});

describe('HydraniumCompletionProvider fillCompletionItem token upgrade', () => {
   // Single line whose second `Element` token spans offsets 21..28, with a
   // space at 28 for the "cursor is not inside a token" case, a `:` at 19 for
   // the "cursor on punctuation" case, and `extends` at 29..36 so a widened
   // range can be shown stopping at a word boundary rather than running on.
   const docText = 'reference Element1 : Element extends Element2';
   const textDocument = TextDocument.create('memory://completion-test', 'plaintext', 1, docText);
   const positionAt = (offset: number) => textDocument.positionAt(offset);

   function fillItemAt(args: { offset: number; tokenEndOffset: number; tokenStartOffset: number }): CompletionItem {
      const provider = makeProvider([]);
      const context: CompletionContext = {
         document: undefined as never,
         textDocument,
         features: [],
         tokenOffset: args.tokenStartOffset,
         tokenEndOffset: args.tokenEndOffset,
         offset: args.offset,
         // buildCompletionTextEdit uses context.position as the range end, so it must equal positionAt(offset).
         position: positionAt(args.offset)
      };
      const item = provider.fillCompletionItemPublic(context, { label: 'Element1' });
      if (!item) {
         throw new Error('expected fillCompletionItem to return an item');
      }
      return item;
   }

   it('upgrades a mid-word completion to an InsertReplaceEdit covering the token', () => {
      const item = fillItemAt({ offset: 24, tokenEndOffset: 28, tokenStartOffset: 21 });
      expect('insert' in item.textEdit! && 'replace' in item.textEdit!).toBe(true);
      const edit = item.textEdit as InsertReplaceEdit;
      expect(edit.replace.end).toEqual(positionAt(28)); // whole token
      expect(edit.insert.end).toEqual(positionAt(24)); // cursor (Langium's narrow range)
   });

   it('keeps a whitespace completion as a plain TextEdit (no replace split)', () => {
      // Cursor on the space at 28, with a second space to its right — there is
      // no name for a suggestion to stand in for, so the early exit fires and
      // the narrow range is correct.
      const item = fillItemAt({ offset: 28, tokenEndOffset: 28, tokenStartOffset: 28 });
      expect('insert' in item.textEdit!).toBe(false);
      expect('replace' in item.textEdit!).toBe(false);
      expect('range' in item.textEdit!).toBe(true);
   });

   it('keeps a completion on punctuation as a plain TextEdit', () => {
      // The `:` at 19. Distinct from the whitespace case above because it is the
      // character AT the cursor that decides, not whether the cursor is on
      // whitespace — a scan keyed on "not whitespace" would widen here and
      // propose replacing a token separator.
      const item = fillItemAt({ offset: 19, tokenEndOffset: 19, tokenStartOffset: 19 });
      expect('range' in item.textEdit!).toBe(true);
   });

   it('widens the replace range over a name that BEGINS at the cursor', () => {
      // The tsserver-parity case, and the one Langium's context cannot describe:
      // the cursor sits at the start of `Element` (21..28) where the completion
      // context is the whitespace before it, so `tokenEndOffset` is at the
      // cursor. Without the document scan the item goes out with an EMPTY range
      // and accepting it inserts IN FRONT of the word it should have replaced.
      const item = fillItemAt({ offset: 21, tokenEndOffset: 21, tokenStartOffset: 21 });
      expect('insert' in item.textEdit! && 'replace' in item.textEdit!).toBe(true);
      const edit = item.textEdit as InsertReplaceEdit;
      expect(edit.replace.end).toEqual(positionAt(28)); // through `Element`
      // The insert range is still empty, so an `insertMode: insert` client puts
      // the suggestion before the word and changes nothing about its behaviour.
      expect(edit.insert.start).toEqual(positionAt(21));
      expect(edit.insert.end).toEqual(positionAt(21));
   });

   it('stops the widened range at the end of one name', () => {
      // The cursor at the start of `extends` (29..36) must not run on through
      // the space into `Element2`. Asserted separately from the case above
      // because that one ends at a space either way — a scan that never
      // terminated would satisfy it and fail here.
      const item = fillItemAt({ offset: 29, tokenEndOffset: 29, tokenStartOffset: 29 });
      const edit = item.textEdit as InsertReplaceEdit;
      expect(edit.replace.end).toEqual(positionAt(36));
   });

   it('leaves the insert range at the cursor so insert-mode clients are unaffected', () => {
      const item = fillItemAt({ offset: 24, tokenEndOffset: 28, tokenStartOffset: 21 });
      const edit = item.textEdit as InsertReplaceEdit;
      expect(edit.insert.start).toEqual(positionAt(21)); // token start (Langium's original)
      expect(edit.insert.end).toEqual(positionAt(24));
   });

   it('returns undefined (does not throw) when the base provider produces no item', () => {
      // Pins the `completionItem?.textEdit` optional-chaining guard: when the
      // fuzzy matcher rejects, the base returns undefined, and the handler must
      // short-circuit rather than dereference `.textEdit` on undefined.
      const provider = makeProvider([], /* fuzzyMatch */ false);
      const context: CompletionContext = {
         document: undefined as never,
         textDocument,
         features: [],
         tokenOffset: 21,
         tokenEndOffset: 28,
         offset: 24,
         position: positionAt(24)
      };
      const item = provider.fillCompletionItemPublic(context, { label: 'Element1' });
      expect(item).toBeUndefined();
   });

   it('leaves an already-InsertReplaceEdit textEdit untouched', () => {
      // Pins the `'insert' in completionItem.textEdit` early-return: when the
      // base item already carries an InsertReplaceEdit, the handler must return
      // it unchanged rather than rebuild it (which would read the nonexistent
      // `.range` and corrupt the edit). Distinguishes both the
      // ConditionalExpression and the `||`→`&&` langA-operator mutants.
      const provider = makeProvider([]);
      const preBuilt: InsertReplaceEdit = {
         newText: 'Element1',
         insert: { start: positionAt(21), end: positionAt(24) },
         replace: { start: positionAt(21), end: positionAt(28) }
      };
      const context: CompletionContext = {
         document: undefined as never,
         textDocument,
         features: [],
         tokenOffset: 21,
         tokenEndOffset: 28,
         offset: 24,
         position: positionAt(24)
      };
      const item = provider.fillCompletionItemPublic(context, { label: 'Element1', textEdit: preBuilt });
      expect(item?.textEdit).toBe(preBuilt); // same object, untouched
   });
});
