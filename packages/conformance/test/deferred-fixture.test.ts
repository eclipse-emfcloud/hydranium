/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * Deferred fixture values — the `Deferred<T>` widening of `ConformanceModel.uri`
 * / `.text` and `EditSpec.to`.
 *
 * The property that matters is a TIMING one, so these tests run a real check
 * body against a stub driver rather than only inspecting the planned list: a
 * thunk must not be read while the suite is being built (no driver exists yet,
 * and the value it needs may not either), and must be read after `connect` for
 * each check independently. A plan-only test cannot see either.
 */

import { describe, expect, it } from 'vitest';
import { buildLspChecks, type LspConformanceDriver } from '../src/lsp/index.js';
import { type LanguageFixture, resolveDeferred, resolveModel } from '../src/model.js';

/** Records what the slice asked of it; enough of the port to run the didOpen check. */
interface StubDriver extends LspConformanceDriver {
   readonly opened: Array<{ uri: string; text: string; languageId: string }>;
}

function makeStubDriver(): StubDriver {
   const opened: Array<{ uri: string; text: string; languageId: string }> = [];
   return {
      opened,
      initialize: async () => ({ capabilities: { textDocumentSync: 1 } }),
      openDocument: (uri, text, languageId) => {
         opened.push({ uri, text, languageId });
      },
      changeDocument: () => undefined,
      nextDiagnostics: async () => [],
      completion: async () => ({ items: [] }),
      shutdown: async () => undefined,
      dispose: () => undefined
   };
}

/** The didOpen(valid) check — the first grammar-bearing one the LSP slice plans. */
function didOpenValidCheck(fixture: LanguageFixture, connect: () => StubDriver): () => Promise<void> {
   const check = buildLspChecks({ connect, languages: [fixture] }).find(candidate => candidate.title.startsWith('didOpen(valid)'));
   if (!check?.body) {
      throw new Error('didOpen(valid) check was not planned with a body');
   }
   return check.body as () => Promise<void>;
}

describe('resolveDeferred', () => {
   it('passes a plain value through and calls a thunk', () => {
      expect(resolveDeferred('plain')).toBe('plain');
      expect(resolveDeferred(() => 'thunked')).toBe('thunked');
   });

   it('resolves each field of a model, leaving languageId alone', () => {
      expect(resolveModel({ uri: () => 'file:///t.x', languageId: 'x', text: () => 'body' })).toEqual({
         uri: 'file:///t.x',
         languageId: 'x',
         text: 'body'
      });
   });
});

describe('deferred fixture values', () => {
   const staticFixture = (): LanguageFixture => ({
      valid: { uri: 'file:///a.x', languageId: 'x', text: 'valid' },
      invalid: { uri: 'file:///b.x', languageId: 'x', text: 'invalid' }
   });

   it('does not read a thunk while planning the suite', () => {
      let reads = 0;
      const fixture: LanguageFixture = {
         ...staticFixture(),
         valid: {
            uri: () => {
               reads++;
               return 'file:///a.x';
            },
            languageId: 'x',
            text: 'valid'
         }
      };

      // Planning must be side-effect free: at this point no driver exists, so a
      // thunk reaching for per-check state would either throw or capture a stale
      // value. This is the guard that keeps `languageId` — which IS read here,
      // for the check title — the only non-deferrable field.
      buildLspChecks({ connect: makeStubDriver, languages: [fixture] });
      expect(reads).toBe(0);
   });

   it('reads a thunk after connect, and once per check', async () => {
      const order: string[] = [];
      let connected = 0;
      const fixture: LanguageFixture = {
         ...staticFixture(),
         valid: {
            uri: () => {
               order.push('read-uri');
               return `file:///run-${connected}.x`;
            },
            languageId: 'x',
            text: () => {
               order.push('read-text');
               return `text-${connected}`;
            }
         }
      };

      const connect = (): StubDriver => {
         connected++;
         order.push('connect');
         return makeStubDriver();
      };
      const body = didOpenValidCheck(fixture, connect);

      await body();
      // Ordering is the assertion: `connect` first, then the reads. A fixture
      // naming a workspace that `connect` creates depends on exactly this.
      expect(order).toEqual(['connect', 'read-uri', 'read-text']);

      // And a second run re-reads, so a rotating fixture gives each check its
      // own input rather than the first check's.
      order.length = 0;
      await body();
      expect(order).toEqual(['connect', 'read-uri', 'read-text']);
      expect(connected).toBe(2);
   });

   it('hands the slice the resolved values, not the thunks', async () => {
      let run = 0;
      const drivers: StubDriver[] = [];
      const fixture: LanguageFixture = {
         ...staticFixture(),
         valid: { uri: () => `file:///run-${run}.x`, languageId: 'x', text: () => `text-${run}` }
      };
      const connect = (): StubDriver => {
         run++;
         const driver = makeStubDriver();
         drivers.push(driver);
         return driver;
      };
      const body = didOpenValidCheck(fixture, connect);

      await body();
      await body();

      // Each check opened the document its own resolution named — which is the
      // whole point of the widening, and is not observable from the plan.
      expect(drivers.map(driver => driver.opened)).toEqual([
         [{ uri: 'file:///run-1.x', text: 'text-1', languageId: 'x' }],
         [{ uri: 'file:///run-2.x', text: 'text-2', languageId: 'x' }]
      ]);
   });
});
