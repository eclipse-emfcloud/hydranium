/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { type AstNodeDescription, type LangiumDocument, type ReferenceInfo, type Stream } from '@hydranium/langium';
import { DefaultCompletionProvider, type CompletionContext } from '@hydranium/langium/lsp';
import {
   CompletionList,
   type CancellationToken,
   type CompletionParams,
   type InsertReplaceEdit,
   type Position
} from 'vscode-languageserver';
import { type ReferenceCandidateProvider } from '../../langium/scope/reference-candidate-provider.js';
import { type ServerLanguageServices } from '../../langium/language-module.js';

/**
 * Completion provider whose {@link InsertReplaceEdit} replaces the name the
 * cursor sits at the start of, not only the token the cursor is inside.
 *
 * **Why this exists.** For a client advertising
 * `completionItem.insertReplaceSupport`, Langium emits an `insert` range ending
 * at the cursor and a `replace` range ending at the completion token's end, so
 * the user's `editor.suggest.insertMode` picks between them. Langium's context
 * only describes the token the cursor is inside. Sitting at a token's START —
 * right after `= ` in `writes Order.status = PAID`, say — the cursor is on
 * whitespace as far as the context is concerned, so `tokenEndOffset` describes
 * the whitespace and not the name that follows it. Langium's `replace` range
 * then ends at or behind the cursor, and accepting the item produces `SHIPPEDPAID`:
 * the suggestion inserted in front of the word it was meant to replace.
 * {@link getReplaceEndOffset} measures that name instead. A `tsserver` in the
 * same position returns a range covering the following word, which is the
 * behaviour matched here.
 *
 * **Capability gating is Langium's.** A client without `insertReplaceSupport`
 * gets Langium's plain `TextEdit` ending at the cursor, and an item that brings
 * its own `textEdit` keeps it as given.
 *
 * **Candidate gathering is delegated.** Cross-reference completion reuses
 * the {@link ReferenceCandidateProvider} pipeline (filter, canonical
 * tier-sibling collapse, name-dedup, sort) by overriding
 * {@link getReferenceCandidates} to return the candidate provider's scope
 * elements. The provider owns that pipeline in one place, so the
 * text-editor dropdown and the protocol candidate picker stay in sync; this
 * class keeps only the LSP-specific `replace` range widening.
 *
 * **A comment is not a completion site.** Langium's context builder reads the
 * non-hidden token stream alone, so a cursor in a comment is indistinguishable
 * from one in the whitespace between the tokens surrounding it: the grammar's
 * follow-set goes out as keyword proposals, and none of them is filtered,
 * because the characters the user typed belong to the hidden token and the
 * prefix matched against is therefore empty. {@link isInsideComment} suppresses
 * the request instead.
 */
export class HydraniumCompletionProvider extends DefaultCompletionProvider {
   protected readonly candidateProvider: ReferenceCandidateProvider;

   constructor(services: ServerLanguageServices) {
      super(services);
      this.candidateProvider = services.references.CandidateProvider;
   }

   /**
    * Answer no proposals at all when the cursor is inside a comment.
    *
    * Suppressing the whole request is what makes the rule hold for every
    * proposal kind at once. Filtering the built contexts instead has to catch
    * each context kind the base builds separately, and a kind added upstream
    * arrives unguarded.
    *
    * The list is marked incomplete so the client re-asks on the next keystroke
    * and proposals resume the moment the cursor leaves the comment.
    */
   override async getCompletion(
      document: LangiumDocument,
      params: CompletionParams,
      cancelToken?: CancellationToken
   ): Promise<CompletionList | undefined> {
      if (this.isInsideComment(document, params.position)) {
         return CompletionList.create([], true);
      }
      return super.getCompletion(document, params, cancelToken);
   }

   /**
    * Whether `position` falls in text a comment terminal claims.
    *
    * The two comment kinds part company at their far edge. A single-line
    * comment runs to the line break, so a cursor at its end offset is still in
    * prose and that offset counts as inside. A multi-line comment is
    * terminated, so a cursor at its end offset has passed the terminator and is
    * back in code. A cursor ON the opening delimiter is outside either way,
    * that offset being a legal position for whatever token the comment
    * displaced.
    *
    * The hidden token stream decides rather than the CST. A leaf lookup by
    * offset misses the position a cursor reaches by typing prose into a
    * trailing comment, because that comment ends AT the line break and
    * whitespace is discarded before a CST node is built over it — so the
    * lookup answers nothing exactly where proposals are least wanted.
    *
    * An adopter whose comment syntax carries completable content — a
    * documentation tag naming a type — narrows this to return `false` over that
    * region rather than replacing {@link getCompletion}.
    */
   protected isInsideComment(document: LangiumDocument, position: Position): boolean {
      const text = document.textDocument.getText();
      const offset = document.textDocument.offsetAt(position);
      const multilineCommentRules = this.grammarConfig.multilineCommentRules;
      for (const token of this.lexer.tokenize(text).hidden) {
         if (token.startOffset >= offset) {
            // Hidden tokens arrive in document order, so no later one reaches back over the cursor.
            return false;
         }
         // `endOffset` is optional on the token type and the image is not, so
         // the width comes from the image and needs no absent-value branch.
         const endOffset = token.startOffset + token.image.length;
         if (offset < endOffset) {
            return true;
         }
         if (offset === endOffset && !multilineCommentRules.includes(token.tokenType.name)) {
            return true;
         }
      }
      return false;
   }

   /**
    * Delegate cross-reference candidate gathering to the candidate provider
    * so the LSP completion dropdown applies the same filter / canonical
    * tier-sibling collapse / name-dedup / sort as the protocol candidate
    * picker. Langium hands us the built {@link ReferenceInfo}, which the
    * candidate provider's `getCandidateScope` accepts directly, so the
    * merged path walks the scope exactly once.
    */
   protected override getReferenceCandidates(refInfo: ReferenceInfo, _context: CompletionContext): Stream<AstNodeDescription> {
      return this.candidateProvider.getCandidateScope(refInfo).elementScope.getAllElements();
   }

   protected override buildCompletionTextEditWithInsertReplace(
      context: CompletionContext,
      label: string,
      newText: string
   ): InsertReplaceEdit | undefined {
      const edit = super.buildCompletionTextEditWithInsertReplace(context, label, newText);
      if (edit) {
         // Langium ends `replace` at `tokenEndOffset`, short of a name that starts at the cursor.
         edit.replace.end = context.textDocument.positionAt(this.getReplaceEndOffset(context));
      }
      return edit;
   }

   /**
    * Offset the `replace` range should end at: the end of the text a suggestion
    * accepted here would stand in for, or `context.offset` when there is none.
    *
    * Two sources, because Langium's completion context describes the token the
    * completion is FOR and that is not always the text under the cursor:
    *
    * - **Cursor inside a token** — `tokenEndOffset` already points past it.
    * - **Cursor at a token's start** — the context describes the preceding
    *   whitespace, so `tokenEndOffset` is at or behind the cursor and the name
    *   to the right has to be measured from the document text.
    *
    * The scan stops at the first character `GrammarConfig.nameRegexp` rejects,
    * so it only ever covers one name: from a cursor before `Order` in
    * `Order.status`, it ends at `Order` and not through the dot. Where Langium's
    * token already reaches past the cursor, its end is kept as it is.
    *
    * Adopters whose grammar has a wider notion of a replaceable token than
    * "consecutive name characters" — a quoted or dotted identifier — override
    * this rather than {@link buildCompletionTextEditWithInsertReplace}.
    */
   protected getReplaceEndOffset(context: CompletionContext): number {
      if (context.tokenEndOffset > context.offset) {
         return context.tokenEndOffset;
      }
      // `getText()` with no range returns the document's stored string rather
      // than a copy, so reading it per item costs nothing.
      const text = context.textDocument.getText();
      const nameRegexp = this.grammarConfig.nameRegexp;
      let end = context.offset;
      while (end < text.length && nameRegexp.test(text.charAt(end))) {
         end++;
      }
      return end;
   }
}
