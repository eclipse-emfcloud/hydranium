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
 * consult — which is why the decision lives on the write path.
 *
 * Line terminators are matched to the body the serializer emits, which is the
 * one thing here that cannot be preserved: keeping them verbatim leaves a
 * rewritten CRLF document with its only CRLFs at the very end.
 */
export class DocumentEndingPreserver implements TriviaPreserver<string> {
   readonly id = 'document-ending';
   readonly label = 'Document Ending';

   extract(document: LangiumDocument): string {
      const source = document.textDocument.getText();
      const ending = source.slice(source.trimEnd().length);
      return ending.includes('\r') ? ending.replace(/\r\n/g, '\n') : ending;
   }

   /**
    * **Override for a grammar whose CONTENT can end in whitespace** — a
    * block-scalar property as the document's last value, say. The trim cannot
    * tell a blank line the serializer emitted as part of a value from one that
    * is merely the end of the file, so it removes both and restores the ending
    * the old document had. A document whose final value just gained trailing
    * blank lines therefore loses them.
    */
   apply(serialized: string, trivia: string): string {
      return serialized.trimEnd() + trivia;
   }
}

/** Registers {@link DocumentEndingPreserver}; bound at `trivia.preservers.documentEnding`. */
export class DocumentEndingPreserverContribution implements TriviaContribution {
   registerTriviaPreservers(registry: TriviaRegistry): void {
      registry.register(new DocumentEndingPreserver());
   }
}
