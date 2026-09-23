/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * `textDocument/completion` where a comment meets code.
 *
 * Langium derives "where is the cursor" from the non-hidden token stream, and a
 * comment is hidden, so a cursor in one looks exactly like a cursor in the
 * whitespace between the tokens on either side. Left alone, a trailing comment
 * in a `.layout` file is offered `node` and `size` — the grammar's follow-set at
 * the code position the comment occupies — and offered them unfiltered, since
 * the characters the user typed belong to the hidden token and never become a
 * prefix to match against.
 *
 * This suite pins both halves against the real grammars: nothing is proposed
 * inside the comment, and the same proposals still arrive at the code position
 * immediately before it.
 */

import { URI } from '@hydranium/langium';
import { describe, expect, it } from 'vitest';
import { makeServices, type OrderFlowHarness } from './order-flow-harness.js';

const harness: OrderFlowHarness = makeServices();

/**
 * A layout file whose second entry carries a trailing line comment, and whose
 * third carries a block comment mid-line. Both sit after a complete
 * `node … at x, y`, where the grammar's next legal tokens are the optional
 * `size` clause and the `node` of a following entry.
 */
const LAYOUT_SOURCE = `layout FulfillmentLayout for Fulfillment {
   node Pay at 40, 100 size 160, 60
   node PaymentOk at 322, 14 // does this feel slow
   node Pick at 505, 39 /* measured */ size 160, 60
}
`;

/** Complete at `offset` the way an editor's request does, and answer the labels. */
async function completeAt(source: string, extension: string, offset: number): Promise<string[]> {
   const uri = URI.parse(`memory:///completion-${extension.slice(1)}${extension}`);
   const document = harness.shared.workspace.LangiumDocumentFactory.fromString(source, uri);
   const services = harness.shared.ServiceRegistry.getServices(uri);
   const list = await services.lsp.CompletionProvider!.getCompletion(document, {
      textDocument: { uri: uri.toString() },
      position: document.textDocument.positionAt(offset)
   });
   return (list?.items ?? []).map(item => item.label).sort();
}

const lineCommentStart = LAYOUT_SOURCE.indexOf('// does');
const lineCommentEnd = LAYOUT_SOURCE.indexOf('slow') + 'slow'.length;
const blockCommentStart = LAYOUT_SOURCE.indexOf('/* measured');
const blockCommentEnd = LAYOUT_SOURCE.indexOf('*/', blockCommentStart) + '*/'.length;

describe('order-flow completion around comments', () => {
   it('proposes the layout keywords at the code position a trailing comment occupies', () => {
      // The control for every suppression case below: the cursor one character
      // before the comment is ordinary code, and the follow-set arriving here is
      // what makes it meaningful that it does NOT arrive inside the comment.
      return expect(completeAt(LAYOUT_SOURCE, '.layout', lineCommentStart)).resolves.toEqual(expect.arrayContaining(['node', 'size']));
   });

   it('proposes nothing at the end of a trailing line comment', async () => {
      // The cursor sits after the last word of the comment, which is where
      // typing prose puts it. An end-exclusive notion of "inside" would leave
      // exactly this position exposed, since the token ends at the line break.
      expect(await completeAt(LAYOUT_SOURCE, '.layout', lineCommentEnd)).toEqual([]);
   });

   it('proposes nothing in the middle of a trailing line comment', async () => {
      expect(await completeAt(LAYOUT_SOURCE, '.layout', lineCommentStart + '// does'.length)).toEqual([]);
   });

   it('proposes nothing inside a block comment', async () => {
      // Measured just past the opening delimiter rather than deeper into the
      // prose, and the difference is not cosmetic. The prefix handed to the
      // completion parser is cut at the cursor, so `/* measured` leaves a bare
      // `/*` the lexer rejects and a stray `measured` that lexes as an ID —
      // and an ID is no legal continuation of `at 505, 39`, so the parser
      // derives no features and the position answers nothing whether or not
      // this guard exists. Right after the delimiter there is no stray token,
      // the parser sits exactly where the code left it, and the follow-set
      // arrives. Only this offset can go red.
      expect(await completeAt(LAYOUT_SOURCE, '.layout', blockCommentStart + '/* '.length)).toEqual([]);
   });

   it('resumes immediately after a block comment terminator', async () => {
      // The asymmetry against the line-comment case: `*/` closes the comment, so
      // its end offset is code again and the optional `size` clause is live.
      expect(await completeAt(LAYOUT_SOURCE, '.layout', blockCommentEnd)).toEqual(expect.arrayContaining(['size']));
   });

   it('suppresses in the comment grammars share, not only in `.layout`', async () => {
      // The comment terminals live in the shared lexical basis, so the guard has
      // to hold for a language that never sees a `.layout` keyword.
      const source = 'project orders // a trailing note\n';
      expect(await completeAt(source, '.domain', source.indexOf('note') + 'note'.length)).toEqual([]);
   });
});
