/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * The trivia chain itself, without a grammar.
 *
 * What a preserver DOES with a document needs real language services, and is
 * covered where those exist. What the service does with its preservers — the
 * order it runs them in, which payload each is handed back, what an empty
 * registry answers — does not, and is the half an adopter rebinding the
 * contribution group can break.
 */

import { describe, expect, it } from 'vitest';
import { type LangiumDocument, URI } from '@hydranium/langium';
import { DefaultTriviaService } from '../../../src/langium/trivia/trivia-service.js';
import { type TriviaPreserver } from '../../../src/langium/trivia/trivia-preserver.js';
import { type TriviaContribution } from '../../../src/langium/trivia/trivia-contribution.js';
import { makeNoopLanguageServices } from '../../../src/testing/index.js';

const URI_A = URI.parse('file:///a.x');

/** Stands in for the document a preserver reads; no preserver here touches it. */
const DOCUMENT = {} as LangiumDocument;

/** A preserver that reports what it was asked, so the fold can be observed. */
function makePreserver(id: string, options: { priority?: number; trail?: string[] } = {}): TriviaPreserver<string> {
   return {
      id,
      priority: options.priority,
      extract: () => {
         options.trail?.push(`extract:${id}`);
         return `payload-${id}`;
      },
      apply: (serialized, trivia) => {
         options.trail?.push(`apply:${id}:${trivia}`);
         return `${serialized}[${id}]`;
      }
   };
}

function makeService(preservers: Record<string, TriviaContribution> = {}): DefaultTriviaService {
   return new DefaultTriviaService(makeNoopLanguageServices({ trivia: { preservers } }));
}

/** Registers `preservers` as one contribution, the way a module sub-key does. */
function contribute(...preservers: ReadonlyArray<TriviaPreserver<string>>): TriviaContribution {
   return { registerTriviaPreservers: registry => preservers.forEach(preserver => registry.register(preserver)) };
}

describe('TriviaService', () => {
   it('is a no-op with nothing registered, which is how preservation is switched off', () => {
      const service = makeService();

      expect(service.extract(DOCUMENT)).toEqual([]);
      expect(service.apply('text', [], URI_A)).toBe('text');
   });

   it('registers what the contribution group binds, at construction', () => {
      const service = makeService({ first: contribute(makePreserver('one')), second: contribute(makePreserver('two')) });

      expect(service.extract(DOCUMENT).map(entry => entry.preserver.id)).toEqual(['one', 'two']);
   });

   it('runs in priority order, ties by registration order', () => {
      const trail: string[] = [];
      const service = makeService();
      service.register(makePreserver('late', { priority: 10, trail }));
      service.register(makePreserver('early', { priority: -10, trail }));
      service.register(makePreserver('mid-a', { trail }));
      service.register(makePreserver('mid-b', { trail }));

      service.apply('text', service.extract(DOCUMENT), URI_A);

      expect(trail.filter(step => step.startsWith('extract'))).toEqual(['extract:early', 'extract:mid-a', 'extract:mid-b', 'extract:late']);
   });

   it('folds, so a preserver sees what the ones before it produced', () => {
      const service = makeService();
      service.register(makePreserver('one', { priority: 0 }));
      service.register(makePreserver('two', { priority: 1 }));

      // The order is load-bearing rather than cosmetic: the document-ending
      // preserver trims what it is handed, so a comment spliced in after it ran
      // would be trimmed away again.
      expect(service.apply('text', service.extract(DOCUMENT), URI_A)).toBe('text[one][two]');
   });

   it('hands each preserver back its OWN payload', () => {
      const trail: string[] = [];
      const service = makeService();
      service.register(makePreserver('one', { priority: 0, trail }));
      service.register(makePreserver('two', { priority: 1, trail }));

      service.apply('text', service.extract(DOCUMENT), URI_A);

      expect(trail.filter(step => step.startsWith('apply'))).toEqual(['apply:one:payload-one', 'apply:two:payload-two']);
   });

   it('applies through the preserver a payload came from, not whatever is registered now', () => {
      const first = makeService({ only: contribute(makePreserver('one')) });
      const second = makeService({ only: contribute(makePreserver('two')) });

      // Each entry carries its own preserver, so the chain never has to work out
      // who produced a payload — and cannot hand one to a reader of another
      // shape, which is what makes the payload type free for adopters to pick.
      expect(second.apply('text', first.extract(DOCUMENT), URI_A)).toBe('text[one]');
   });

   it('refuses a second preserver under one id rather than shadowing the first', () => {
      // The framework binds one sub-key per preserver, so a subclass ADDED
      // beside the framework's — instead of replacing it — collides here. The
      // throw is what stops it silently running twice under one name.
      const service = makeService({ framework: contribute(makePreserver('comments')) });

      expect(() => service.register(makePreserver('comments'))).toThrow();
   });

   it('removes a preserver by id, and says whether there was one', () => {
      const service = makeService({ only: contribute(makePreserver('one')) });

      expect(service.unregister('one')).toBe(true);
      expect(service.unregister('one')).toBe(false);
      expect(service.extract(DOCUMENT)).toEqual([]);
   });

   it('removes a preserver through the handle registering it returned', () => {
      const service = makeService();
      const registration = service.register(makePreserver('one'));

      registration.dispose();

      expect(service.extract(DOCUMENT)).toEqual([]);
   });
});
