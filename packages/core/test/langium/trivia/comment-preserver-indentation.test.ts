/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * Comments of a grammar whose blocks are delimited by indentation, through a
 * write.
 *
 * The INDENT and DEDENT tokens come from Langium's own lexer, since their
 * offsets are the hazard: a DEDENT is zero-width at the start of the line after
 * its block, and an INDENT covers the whitespace in front of the block's first
 * line. The grammar is built here because no example grammar is indentation
 * aware, and the serializer is skipped: `serialized` is the text a serializer
 * emits, the source without its comments.
 */

import {
   createDefaultCoreModule,
   createDefaultSharedCoreModule,
   EmptyFileSystem,
   IndentationAwareLexer,
   IndentationAwareTokenBuilder,
   inject,
   loadGrammarFromJson,
   URI,
   type Grammar,
   type LangiumCoreServices,
   type LangiumDocument,
   type LexerResult
} from '@hydranium/langium';
import { describe, expect, it } from 'vitest';
import { DefaultNameProvider } from '../../../src/langium/naming/name-provider.js';
import { CommentPreserver } from '../../../src/langium/trivia/comment-preserver.js';
import { makeFakeReflection, makeNoopLanguageServices } from '../../../src/testing/index.js';

// Indices into the rules of `makeGrammar`, which reference each other by them.
const ELEMENT = 1;
const MEMBER = 2;
const INDENT = 3;
const DEDENT = 4;
const ID = 8;

const call = (rule: number): object => ({ $type: 'RuleCall', rule: { $ref: `#/rules@${rule}` }, arguments: [] });
const keyword = (value: string): object => ({ $type: 'Keyword', value });
const assign = (feature: string, operator: '=' | '+=', rule: number, cardinality?: '*' | '+'): object => ({
   $type: 'Assignment',
   feature,
   operator,
   terminal: call(rule),
   cardinality
});
const parserRule = (name: string, definition: object, entry = false): object => ({
   $type: 'ParserRule',
   name,
   definition,
   entry,
   fragment: false,
   parameters: []
});
const terminal = (name: string, definition: object, hidden = false): object => ({
   $type: 'TerminalRule',
   name,
   definition,
   hidden,
   fragment: false
});
const regex = (pattern: RegExp): object => ({ $type: 'RegexToken', regex: pattern.toString() });
const synthetic = (value: string): object => ({ $type: 'CharacterRange', left: keyword(value) });

/**
 * `Model: elements+=Element*; Element: 'element' name=ID ':' INDENT
 * members+=Member+ DEDENT; Member: 'member' name=ID (':' INDENT
 * members+=Member+ DEDENT)?;` with `#` line comments.
 */
function makeGrammar(): Grammar {
   const rules = [
      parserRule('Model', assign('elements', '+=', ELEMENT, '*'), true),
      parserRule('Element', {
         $type: 'Group',
         elements: [
            keyword('element'),
            assign('name', '=', ID),
            keyword(':'),
            call(INDENT),
            assign('members', '+=', MEMBER, '+'),
            call(DEDENT)
         ]
      }),
      parserRule('Member', {
         $type: 'Group',
         elements: [
            keyword('member'),
            assign('name', '=', ID),
            {
               $type: 'Group',
               cardinality: '?',
               elements: [keyword(':'), call(INDENT), assign('members', '+=', MEMBER, '+'), call(DEDENT)]
            }
         ]
      }),
      terminal('INDENT', synthetic('synthetic:indent')),
      terminal('DEDENT', synthetic('synthetic:dedent')),
      terminal('WS', regex(/[\t ]+/), true),
      terminal('NL', regex(/[\r\n]+/), true),
      terminal('COMMENT', regex(/#[^\n\r]*/), true),
      terminal('ID', regex(/[_a-zA-Z][\w_]*/))
   ];
   return loadGrammarFromJson(
      JSON.stringify({ $type: 'Grammar', isDeclared: true, name: 'Indented', rules, imports: [], interfaces: [], types: [] })
   );
}

type Token = LexerResult['tokens'][number];

/** Measures indentation on significant lines only, as Python and YAML do. */
class CommentLineSkippingTokenBuilder extends IndentationAwareTokenBuilder {
   protected override indentMatcher(text: string, offset: number, tokens: Token[], groups: Record<string, Token[]>) {
      return isCommentLine(text, offset) ? null : super.indentMatcher(text, offset, tokens, groups);
   }

   protected override dedentMatcher(text: string, offset: number, tokens: Token[], groups: Record<string, Token[]>) {
      return isCommentLine(text, offset) ? null : super.dedentMatcher(text, offset, tokens, groups);
   }
}

function isCommentLine(text: string, offset: number): boolean {
   return /^[\t ]*#/.test(text.slice(offset, text.indexOf('\n', offset) + 1 || undefined));
}

interface IndentedLanguage {
   readonly preserver: CommentPreserver;
   parse(text: string): LangiumDocument;
}

function makeIndentedLanguage(
   tokenBuilder: () => IndentationAwareTokenBuilder,
   Preserver: typeof CommentPreserver = CommentPreserver
): IndentedLanguage {
   const shared = inject(createDefaultSharedCoreModule(EmptyFileSystem), {
      AstReflection: () =>
         makeFakeReflection({
            Model: { elements: { defaultValue: [] } },
            Element: { members: { defaultValue: [] } },
            Member: { members: { defaultValue: [] } }
         })
   });
   const language: LangiumCoreServices = inject(createDefaultCoreModule({ shared }), {
      Grammar: () => makeGrammar(),
      LanguageMetaData: () => ({ languageId: 'indented', fileExtensions: ['.x'], caseInsensitive: false, mode: 'development' as const }),
      parser: { TokenBuilder: tokenBuilder, Lexer: (services: LangiumCoreServices) => new IndentationAwareLexer(services) }
   });
   shared.ServiceRegistry.register(language);
   const sharedServices = {
      AstReflection: shared.AstReflection,
      workspace: {
         DocumentBuilder: shared.workspace.DocumentBuilder,
         LangiumDocumentFactory: shared.workspace.LangiumDocumentFactory,
         CstResidencyService: { rehydrate: () => undefined }
      }
   };
   const preserver = new Preserver(
      makeNoopLanguageServices({
         Grammar: language.Grammar,
         parser: language.parser,
         references: { NameProvider: new DefaultNameProvider(makeNoopLanguageServices({ shared: sharedServices })) },
         shared: sharedServices
      })
   );
   return { preserver, parse: text => shared.workspace.LangiumDocumentFactory.fromString(text, URI.parse('file:///a.x')) };
}

describe.each([
   ['a lexer that measures comment lines', () => new IndentationAwareTokenBuilder()],
   ['a lexer that skips comment lines', () => new CommentLineSkippingTokenBuilder()]
])('CommentPreserver with %s', (_lexer, tokenBuilder) => {
   const { preserver, parse } = makeIndentedLanguage(tokenBuilder);

   /** `source` after a write whose serializer emitted `serialized`. */
   function write(source: string, serialized: string): string {
      const document = parse(source);
      expect(document.parseResult.parserErrors).toEqual([]);
      return preserver.apply(serialized, preserver.extract(document), document.uri);
   }

   it('keeps a comment line between two blocks above the second', () => {
      const source = 'element a:\n    member x\n# about b\nelement b:\n    member y\n';
      expect(write(source, 'element a:\n    member x\nelement b:\n    member y\n')).toBe(source);
   });

   it('keeps a comment line opening a block above its first member', () => {
      const source = 'element a:\n    # about x\n    member x\n';
      expect(write(source, 'element a:\n    member x\n')).toBe(source);
   });

   it('keeps a comment line after the last block at the end of the file', () => {
      const source = 'element a:\n    member x\n# closing\n';
      expect(write(source, 'element a:\n    member x\n')).toBe(source);
   });

   it('keeps a comment ending the last line of a block on that line', () => {
      const source = 'element a:\n    member x # about x\nelement b:\n    member y\n';
      expect(write(source, 'element a:\n    member x\nelement b:\n    member y\n')).toBe(source);
   });

   it('keeps a comment line at the column of the members after the last member', () => {
      const source = 'element a:\n    member x\n    # after x\nelement b:\n    member y\n';
      expect(write(source, 'element a:\n    member x\nelement b:\n    member y\n')).toBe(source);
   });

   it('keeps a comment line after nested blocks above the next block', () => {
      const source = 'element a:\n    member x:\n        member y\n# about b\nelement b:\n    member z\n';
      expect(write(source, 'element a:\n    member x:\n        member y\nelement b:\n    member z\n')).toBe(source);
   });

   it('keeps a comment line after a nested block above the next member of its parent', () => {
      const source = 'element a:\n    member x:\n        member y\n    # about w\n    member w\n';
      expect(write(source, 'element a:\n    member x:\n        member y\n    member w\n')).toBe(source);
   });

   it('places each line of one comment run after nested blocks by its own column', () => {
      const source = 'element a:\n    member x:\n        member y\n        # after y\n    # about w\n# about b\nelement b:\n    member z\n';
      expect(write(source, 'element a:\n    member x:\n        member y\nelement b:\n    member z\n')).toBe(source);
   });

   it('drops the comment of a block the write deleted rather than moving it to the next', () => {
      const source = 'element a:\n    member x\n# about b\nelement b:\n    member y\nelement c:\n    member z\n';
      expect(write(source, 'element a:\n    member x\nelement c:\n    member z\n')).toBe(
         'element a:\n    member x\nelement c:\n    member z\n'
      );
   });
});

describe('CommentPreserver with a lexer that reports an error the parser does not see', () => {
   /** Places the comment at a column no enclosing block opened, an invalid dedent. */
   class MisplacingCommentPreserver extends CommentPreserver {
      protected override spliceComments(serialized: string): string {
         return serialized.replace('    member w', '  # about w\n    member w');
      }
   }
   const { preserver, parse } = makeIndentedLanguage(() => new IndentationAwareTokenBuilder(), MisplacingCommentPreserver);

   it('writes without the comments when their placement is an invalid dedent', () => {
      const document = parse('element a:\n    member x\n    # about w\n    member w\n');
      const serialized = 'element a:\n    member x\n    member w\n';

      expect(preserver.apply(serialized, preserver.extract(document), document.uri)).toBe(serialized);
   });
});
