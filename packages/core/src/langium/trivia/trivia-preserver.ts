/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { type LangiumDocument, type URI } from '@hydranium/langium';
import { type RegistryItem } from '../../util/registry.js';

/**
 * One kind of trivia — what a document carries that its model does not, so a
 * write that re-serializes from the model would otherwise lose it.
 *
 * **Two phases, because there is a suspension point between them.** The write
 * path extracts, awaits the serializer, then applies; and the preserver is a
 * per-language singleton, so two concurrent writes would clobber each other if
 * it held the extracted value itself. `T` therefore travels through the caller.
 *
 * Declared with METHODS rather than arrow properties: an implementation
 * narrowing `T` stays assignable only under method-parameter bivariance, which
 * arrow properties lose.
 */
export interface TriviaPreserver<T = unknown> extends RegistryItem {
   /**
    * Take this preserver's trivia off `document`, while it still holds the text
    * the write is about to replace.
    */
   extract(document: LangiumDocument): T;

   /**
    * Put `trivia` back into `serialized`, returning the text the NEXT preserver
    * sees — the chain is a fold, so an implementation must derive its positions
    * from the text it is handed rather than from the document it extracted from.
    */
   apply(serialized: string, trivia: T, uri: URI): string;
}

/**
 * One preserver's output, kept beside the preserver that produced it.
 *
 * Pairing them is what lets the chain stay agnostic: it never learns what a
 * payload IS, only which preserver knows how to apply it, so a preserver can
 * use whatever shape suits it without the service naming that shape.
 */
export interface ExtractedTrivia {
   readonly preserver: TriviaPreserver;
   readonly trivia: unknown;
}

/** Everything the registered preservers took off one document, in the order they ran. */
export type DocumentTrivia = readonly ExtractedTrivia[];
