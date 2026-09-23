/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { type Tracer } from '@hydranium/protocol';
import { type LangiumDocument, type URI } from '@hydranium/langium';
import { type Disposable } from 'vscode-languageserver';
import { type LogNameOptions } from '../diagnostics/logger.js';
import { type HydraniumLanguageServices } from '../language-module.js';
import { Registry } from '../../util/registry.js';
import { type TriviaRegistry } from './trivia-contribution.js';
import { type DocumentTrivia, type TriviaPreserver } from './trivia-preserver.js';

/**
 * Public contract for the per-language trivia runner. Extends the
 * {@link TriviaRegistry} contributions register through with the entry points
 * the write paths call around serialization.
 *
 * Adopter overrides go through {@link DefaultTriviaService}; the interface keeps
 * the public API stable while the registry stays `protected` on the class.
 */
export interface TriviaService extends TriviaRegistry {
   /** Remove a preserver by id. Returns `true` if one was removed. */
   unregister(id: string): boolean;

   /**
    * Run every registered preserver's `extract` over `document`, in priority
    * order, while it still holds the text the write is about to replace.
    */
   extract(document: LangiumDocument): DocumentTrivia;

   /**
    * Fold `serialized` through every extracted entry, handing each preserver
    * back its own payload, and return the text to write.
    */
   apply(serialized: string, trivia: DocumentTrivia, uri: URI): string;
}

/** Construction options for {@link DefaultTriviaService}. */
export type TriviaServiceOptions = LogNameOptions;

/**
 * Default {@link TriviaService}: an ordered registry of preservers, run around
 * the serializer on every structured write.
 *
 * **An empty registry is a no-op**, which is how preservation is switched off —
 * there is no enabled flag, and a preserver that is not registered costs
 * nothing rather than being asked and declining.
 *
 * **Per-language service.** Comment terminals come from the grammar, so this
 * cannot be shared; `ModelService` resolves it via
 * `ServiceRegistry.getServices(uri)` so a multi-grammar workspace routes each
 * write to the right preservers.
 */
export class DefaultTriviaService implements TriviaService {
   /** Registry of preservers, keyed by id, iterated in priority order. */
   protected readonly preservers = new Registry<TriviaPreserver>();
   protected readonly tracer: Tracer;

   constructor(
      protected readonly services: HydraniumLanguageServices,
      options: TriviaServiceOptions = {}
   ) {
      this.tracer = services.shared.Tracer.for(options.logName ?? 'Trivia').trace('instantiated');

      // Optional chaining tolerates incomplete test stubs; production wiring
      // always provides the slot via `createServerLanguageModule`.
      const contributions = services.trivia?.preservers ?? {};
      for (const contribution of Object.values(contributions)) {
         contribution.registerTriviaPreservers(this);
      }
   }

   register(preserver: TriviaPreserver): Disposable {
      return this.preservers.register(preserver);
   }

   unregister(id: string): boolean {
      return this.preservers.unregister(id);
   }

   extract(document: LangiumDocument): DocumentTrivia {
      return this.preservers.all().map(preserver => ({ preserver, trivia: preserver.extract(document) }));
   }

   /**
    * Fold, not map: each preserver sees what the ones before it produced, so a
    * pair that touch the same region resolve by priority rather than by
    * whichever happened to register first.
    */
   apply(serialized: string, trivia: DocumentTrivia, uri: URI): string {
      return trivia.reduce((text, entry) => entry.preserver.apply(text, entry.trivia, uri), serialized);
   }
}
