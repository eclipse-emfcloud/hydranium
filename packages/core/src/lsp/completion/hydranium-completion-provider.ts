/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { type AstNodeDescription, type ReferenceInfo, type Stream } from '@hydranium/langium';
import { DefaultCompletionProvider, type CompletionContext, type CompletionValueItem } from '@hydranium/langium/lsp';
import type { CompletionItem, InsertReplaceEdit } from 'vscode-languageserver';
import { type ReferenceCandidateProvider } from '../../langium/scope/reference-candidate-provider.js';
import { type ServerLanguageServices } from '../../langium/language-module.js';

/**
 * Completion provider that upgrades Langium's default `TextEdit` to
 * {@link InsertReplaceEdit} so accepting a suggestion over an existing token
 * replaces that token rather than inserting alongside it.
 *
 * **Why this exists.** `DefaultCompletionProvider.buildCompletionTextEdit`
 * returns a range ending at the cursor position, so accepting a suggestion
 * with the caret inside a token leaves the token's tail standing after the
 * inserted text. By widening the `replace` range to the token's end while
 * keeping the original `insert` range at the cursor, LSP clients honour the
 * user's `editor.suggest.insertMode` preference (`insert` = Langium's narrow
 * range, `replace` = overwrite the whole token).
 *
 * **Two cursor positions need widening and Langium's context only describes
 * one of them.** Inside a token, `tokenEndOffset` points past the token and the
 * widening reads straight off it. Sitting at a token's START — right after `= `
 * in `writes Order.status = PAID`, say — the cursor is on whitespace as far as
 * the completion context is concerned, so `tokenEndOffset` describes the
 * whitespace and not the name that follows it. Without {@link getReplaceEndOffset}
 * the item goes out with an EMPTY range and accepting it produces
 * `SHIPPEDPAID`: the suggestion inserted in front of the word it was meant to
 * replace. A `tsserver` in the same position returns a range covering the
 * following word, which is the behaviour matched here.
 *
 * **Capability gating.** {@link InsertReplaceEdit} requires LSP 3.16+
 * (`completionItem.insertReplaceSupport`). Older clients that ignore the
 * wider range fall back to the narrower `insert` range, which matches
 * Langium's original behaviour. A defensive capability check is
 * intentionally not added so the framework default stays simple —
 * consumers that need to support pre-3.16 clients can override and emit a
 * plain `TextEdit`.
 *
 * **Candidate gathering is delegated.** Cross-reference completion reuses
 * the {@link ReferenceCandidateProvider} pipeline (filter, canonical
 * tier-sibling collapse, name-dedup, sort) by overriding
 * {@link getReferenceCandidates} to return the candidate provider's scope
 * elements. The provider owns that pipeline in one place, so the
 * text-editor dropdown and the protocol candidate picker stay in sync; this
 * class keeps only the LSP-specific {@link fillCompletionItem} upgrade.
 */
export class HydraniumCompletionProvider extends DefaultCompletionProvider {
   protected readonly candidateProvider: ReferenceCandidateProvider;

   constructor(services: ServerLanguageServices) {
      super(services);
      this.candidateProvider = services.references.CandidateProvider;
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

   protected override fillCompletionItem(context: CompletionContext, item: CompletionValueItem): CompletionItem | undefined {
      const completionItem = super.fillCompletionItem(context, item);
      if (!completionItem?.textEdit || 'insert' in completionItem.textEdit) {
         return completionItem;
      }
      const replaceEndOffset = this.getReplaceEndOffset(context);
      // Nothing to the right of the cursor that a suggestion would stand in for
      // (completion on whitespace, on punctuation, at end of file) — the
      // parent's narrow range is already correct.
      if (replaceEndOffset <= context.offset) {
         return completionItem;
      }
      const baseEdit = completionItem.textEdit;
      const insertReplaceEdit: InsertReplaceEdit = {
         newText: baseEdit.newText,
         insert: baseEdit.range,
         replace: { start: baseEdit.range.start, end: context.textDocument.positionAt(replaceEndOffset) }
      };
      completionItem.textEdit = insertReplaceEdit;
      return completionItem;
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
    * Scanning stops at the first character `GrammarConfig.nameRegexp` rejects, so
    * a run only ever covers one name: a cursor before `Order` in `Order.status`
    * widens to the end of `Order` and not through the dot.
    *
    * Adopters whose grammar has a wider notion of a replaceable token than
    * "consecutive name characters" — a quoted or dotted identifier — override
    * this rather than {@link fillCompletionItem}.
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
