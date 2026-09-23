/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { type Disposable } from 'vscode-languageserver';
import { type TriviaPreserver } from './trivia-preserver.js';

/**
 * Registry handed to a {@link TriviaContribution}. Implemented by the trivia
 * service; a contribution receives it and registers one or many preservers.
 * Doubles as the low-level imperative API for the rare runtime-dynamic case.
 */
export interface TriviaRegistry {
   register(preserver: TriviaPreserver): Disposable;
}

/**
 * Declarative registration of trivia preservers. Bound under the module's
 * `trivia.preservers` contribution group; the trivia service reads its own
 * group at construction and calls this method, handing itself in as the
 * registry.
 *
 * The framework binds one sub-key per preserver it ships rather than one for
 * all of them, so an adopter replacing `comments` — a grammar identifying its
 * nodes by something no name property holds — keeps the rest. Langium's
 * deep-merge is last-wins on same-key leaves, so binding a sub-key REPLACES the
 * framework's contribution under it rather than adding to it.
 *
 * The domain-qualified method name lets one cross-cutting class implement
 * several contribution interfaces without method collision.
 */
export interface TriviaContribution {
   registerTriviaPreservers(registry: TriviaRegistry): void;
}
