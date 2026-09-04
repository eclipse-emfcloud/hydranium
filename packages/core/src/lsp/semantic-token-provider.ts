/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import {
   type AstNode,
   type AstReflection,
   AstUtils,
   CstUtils,
   GrammarAST,
   interruptAndCheck,
   type LangiumDocument,
   type ReferenceInfo
} from '@hydranium/langium';
import { AbstractSemanticTokenProvider, type SemanticTokenAcceptor } from '@hydranium/langium/lsp';
import { type CancellationToken, SemanticTokenModifiers, SemanticTokenTypes } from 'vscode-languageserver';
import { type NameProvider } from '../langium/naming/name-provider.js';
import { type ServerLanguageServices } from '../langium/language-module.js';

/**
 * What a node or reference should be coloured as. The bare string form is the
 * common case (`SemanticTokenTypes.class`); the object form is for the
 * minority that also need modifiers, or that need to suppress the
 * declaration modifier this provider adds by default (pass `modifier: []`).
 */
export type SemanticTokenKind = string | { readonly type: string; readonly modifier?: string | string[] };

/** Normalise both {@link SemanticTokenKind} forms to the acceptor's shape. */
function toAcceptorFields(kind: SemanticTokenKind, fallbackModifier?: string): { type: string; modifier?: string | string[] } {
   if (typeof kind === 'string') {
      return fallbackModifier === undefined ? { type: kind } : { type: kind, modifier: fallbackModifier };
   }
   return kind.modifier === undefined && fallbackModifier !== undefined ? { type: kind.type, modifier: fallbackModifier } : { ...kind };
}

/** Behaviour switches for {@link AbstractHydraniumSemanticTokenProvider}. */
export interface HydraniumSemanticTokenProviderOptions {
   /**
    * Also emit a `keyword` token for every keyword leaf of the CST.
    *
    * OFF by default, and the default is not timidity: semantic tokens OVERRIDE
    * a client-side TextMate grammar, and such a grammar classifies keywords
    * with far finer scopes (`keyword.control`, `storage.type`,
    * `keyword.operator`) than the one flat `keyword` a legend can carry — so
    * turning this on in a host that ships a grammar makes its editor *less*
    * coloured, not more. It exists for the host that ships NO client-side
    * grammar at all (a plain-Monaco page, a minimal web client), where the
    * server's tokens are the only source of colour and keywords otherwise
    * render in the editor's default foreground.
    */
   readonly highlightKeywords?: boolean;
}

/**
 * Semantic-token provider that derives highlighting from ONE adopter-supplied
 * map of AST type → token kind, instead of a hand-written walk.
 *
 * **What it replaces.** Langium's {@link AbstractSemanticTokenProvider} hands
 * you every node and asks you to emit tokens for it, so a grammar-specific
 * provider becomes a chain of typeguards, each repeating two mechanical
 * steps: emit the declaration name with `property: 'name'`, then emit one
 * acceptor call per cross-reference property, remembering `index` for the
 * multi-valued ones. Both steps are derivable, and getting the second one
 * wrong is silent — a forgotten reference property simply renders uncoloured.
 *
 * **How the derivation works.**
 * - The declaration name's PROPERTY comes from {@link NameProvider.getNameProperty},
 *   so an `id`-keyed grammar works without the provider hardcoding `'name'`.
 * - Cross-references are discovered with Langium's `streamReferences`, which
 *   yields every reference on the node with its property and index already
 *   filled in — so multi-valued references cannot be missed or mis-indexed.
 * - A reference's kind is resolved from the reference's DECLARED target type
 *   (`AstReflection.getReferenceType`), NOT from `ref.ref.$type`. That is
 *   deliberate: the declared type is available whether or not the reference
 *   resolves, so a broken or half-typed document keeps its colouring instead
 *   of flickering as links come and go.
 *
 * The net effect is that {@link getTokenKind} — a `$type` string in, a token
 * kind out — is usually the only member an adopter writes.
 *
 * Anything the map cannot express stays overridable: {@link getDeclarationKind}
 * and {@link getReferenceKind} for per-node or per-property decisions,
 * {@link highlightElement} for tokens that are neither a declaration nor a
 * cross-reference (a sub-range, a single keyword of one rule). Returning
 * `'prune'` from an override still skips the subtree, as upstream. Colouring
 * EVERY keyword is not one of those cases — that is
 * {@link HydraniumSemanticTokenProviderOptions.highlightKeywords}, which walks
 * the CST once instead.
 */
export abstract class AbstractHydraniumSemanticTokenProvider extends AbstractSemanticTokenProvider {
   protected readonly nameProvider: NameProvider;
   protected readonly reflection: AstReflection;
   protected readonly options: HydraniumSemanticTokenProviderOptions;

   /**
    * Modifier added to every declaration token. `declaration` is what themes
    * key on to render a definition differently from a use; override to
    * `undefined` to add none.
    */
   protected readonly declarationModifier: string | undefined = SemanticTokenModifiers.declaration;

   constructor(services: ServerLanguageServices, options: HydraniumSemanticTokenProviderOptions = {}) {
      super(services);
      this.nameProvider = services.references.NameProvider;
      this.reflection = services.shared.AstReflection;
      this.options = options;
   }

   /**
    * The AST pass, then — when asked for — one CST pass over the keywords.
    *
    * **The keyword pass belongs here and not in {@link highlightElement}**,
    * which is called once per AST node: a node reaching its own keyword leaves
    * has to descend its CST subtree, and every node repeating that visits each
    * leaf once per ancestor, so the AST-hosted version is O(leaves × depth)
    * against this one's O(leaves). It also cannot be written correctly with a
    * `prune`, because a keyword leaf's nearest AST node is not always the one
    * whose rule contributed it.
    *
    * Emitting out of positional order is safe: `SemanticTokensBuilder` sorts
    * before it encodes the deltas, so the two passes need not interleave. The
    * range form of the request needs no accommodation either — the acceptor
    * drops anything outside `currentRange` on its own.
    */
   protected override async computeHighlighting(
      document: LangiumDocument,
      acceptor: SemanticTokenAcceptor,
      cancelToken: CancellationToken
   ): Promise<void> {
      await super.computeHighlighting(document, acceptor, cancelToken);
      if (this.options.highlightKeywords !== true) {
         return;
      }
      const root = document.parseResult.value.$cstNode;
      if (root === undefined) {
         return;
      }
      for (const cst of CstUtils.streamCst(root)) {
         await interruptAndCheck(cancelToken);
         // The grammar source is the whole filter. A keyword is always a leaf,
         // and the hidden leaves a comment or a run of whitespace contributes
         // are sourced from a terminal rule rather than a `Keyword` — so
         // neither a composite-node check nor a hidden-token check adds
         // anything here.
         if (GrammarAST.isKeyword(cst.grammarSource)) {
            acceptor({ cst, type: SemanticTokenTypes.keyword });
         }
      }
   }

   protected override highlightElement(node: AstNode, acceptor: SemanticTokenAcceptor): void | undefined | 'prune' {
      this.highlightDeclaration(node, acceptor);
      this.highlightReferences(node, acceptor);
      return undefined;
   }

   /** Colour the node's own name, at whichever property the NameProvider reads it from. */
   protected highlightDeclaration(node: AstNode, acceptor: SemanticTokenAcceptor): void {
      const kind = this.getDeclarationKind(node);
      if (kind === undefined) {
         return;
      }
      const property = this.getNameProperty(node);
      if (property === undefined) {
         return;
      }
      acceptor({ node, property, ...toAcceptorFields(kind, this.declarationModifier) });
   }

   /** Colour every cross-reference the node carries, including multi-valued ones. */
   protected highlightReferences(node: AstNode, acceptor: SemanticTokenAcceptor): void {
      for (const info of AstUtils.streamReferences(node)) {
         const kind = this.getReferenceKind(info);
         if (kind === undefined) {
            continue;
         }
         acceptor({ node: info.container, property: info.property, index: info.index, ...toAcceptorFields(kind) });
      }
   }

   /**
    * The adopter's map: an AST `$type` in, the token kind its declarations and
    * the references pointing at it should render as. `undefined` leaves the
    * type uncoloured.
    *
    * What uncoloured means depends on the host, and this map cannot see which:
    * a host shipping a TextMate grammar keeps that grammar's colour, a host
    * shipping none renders the default foreground. So `undefined` says only
    * "not a name worth a kind of its own" — never "someone else will colour
    * it". Keywords in particular are not left to this map at all; they are
    * {@link HydraniumSemanticTokenProviderOptions.highlightKeywords}, because
    * they have no AST type to key on.
    */
   protected abstract getTokenKind(type: string): SemanticTokenKind | undefined;

   /** Kind for `node`'s own declaration. Defaults to {@link getTokenKind} on its `$type`. */
   protected getDeclarationKind(node: AstNode): SemanticTokenKind | undefined {
      return this.getTokenKind(node.$type);
   }

   /** Kind for a cross-reference. Defaults to {@link getTokenKind} on the reference's DECLARED target type. */
   protected getReferenceKind(info: ReferenceInfo): SemanticTokenKind | undefined {
      return this.getTokenKind(this.reflection.getReferenceType(info));
   }

   /** Property holding `node`'s name. Defaults to the language's {@link NameProvider}. */
   protected getNameProperty(node: AstNode): string | undefined {
      return this.nameProvider.getNameProperty(node);
   }
}
