/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { type LangiumDocument } from '@hydranium/langium';
import { type TriviaContribution, type TriviaRegistry } from './trivia-contribution.js';
import { type TriviaPreserver } from './trivia-preserver.js';

/**
 * Carries the whitespace a document ended with across a write.
 *
 * **Normalising this to one final newline rewrites files nobody asked to
 * restyle.** A document may legitimately end in blank lines, or deliberately in
 * none, and a write that changed one field is not the place to decide it should
 * not. A serializer cannot make the call either — it has no prior file to
 * consult — which is why the decision lives on the write path. Only a blank
 * document, created or existing, has no ending to keep and takes
 * {@link defaultEnding}.
 *
 * Line terminators are matched to the body the serializer emits, which is the
 * one thing here that cannot be preserved: keeping them verbatim leaves a
 * rewritten CRLF document with its only CRLFs at the very end. A body with no
 * line break has none to match, so its ending stays as the file had it.
 */
export class DocumentEndingPreserver implements TriviaPreserver<string> {
   /** Default {@link defaultEnding}. */
   static readonly DEFAULT_ENDING = '\n';

   readonly id = 'document-ending';
   readonly label = 'Document Ending';

   /** The ending of a blank document, which a created one is: it has none of its own to keep. */
   protected readonly defaultEnding: string = DocumentEndingPreserver.DEFAULT_ENDING;

   extract(document: LangiumDocument): string {
      const source = document.textDocument.getText();
      if (source.trim().length === 0) {
         return this.defaultEnding;
      }
      return source.slice(source.trimEnd().length);
   }

   /**
    * **Override for a grammar whose CONTENT can end in whitespace** — a
    * block-scalar property as the document's last value, say. The trim cannot
    * tell a blank line the serializer emitted as part of a value from one that
    * is merely the end of the file, so it removes both and restores the ending
    * the old document had. A document whose final value just gained trailing
    * blank lines therefore loses them. An override also takes over matching the
    * ending's line terminators to the body's.
    */
   apply(serialized: string, trivia: string): string {
      const body = serialized.trimEnd();
      // The body's first line break, since a value may hold the other kind; with none
      // there is no terminator to match, so the ending stays as extracted.
      const terminator = /\r?\n/.exec(body)?.[0];
      return body + (terminator === undefined ? trivia : trivia.replace(/\r?\n/g, terminator));
   }
}

/** Registers {@link DocumentEndingPreserver}; bound at `trivia.preservers.documentEnding`. */
export class DocumentEndingPreserverContribution implements TriviaContribution {
   registerTriviaPreservers(registry: TriviaRegistry): void {
      registry.register(new DocumentEndingPreserver());
   }
}
