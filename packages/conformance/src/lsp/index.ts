/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * The `@hydranium/conformance/lsp` slice — protocol conformance for the LSP
 * head. The driver port is a STRUCTURAL minimum (`LspConformanceDriver`) that
 * `@hydranium/core/testing/node`'s `LspHarness` satisfies with NO adapter: the kit
 * names only `string`, plain coordinates, and tiny structural minima
 * (`{ message }`, `{ items }`, `{ capabilities }`), never
 * `vscode-languageserver-protocol` wire types, so the harness's richer return
 * types are assignable to the narrower port.
 *
 * **This slice does not read `LanguageFixture.edit` at all.** The didChange
 * check drives `valid → invalid` using `invalid.text`, so there is no
 * adopter-supplied assertion to run and `edit.expect` is never called.
 * `completionPosition` is the one extra this slice does read.
 */

import assert from 'node:assert/strict';
import type { Harness } from '@hydranium/protocol/testing';
import type { ConformanceCheck } from '../conformance-suite.js';
import { type LanguageFixture, resolveDeferred, resolveModel } from '../model.js';

/** Structural minimum of an LSP `InitializeResult` — only the baseline capabilities the kit asserts. */
export interface LspConformanceInitializeResult {
   readonly capabilities: {
      readonly textDocumentSync?: unknown;
      readonly completionProvider?: unknown;
   };
}

/** Structural minimum of a `CompletionList` — the kit asserts only that `items` is an array. */
export interface LspConformanceCompletionList {
   readonly items: readonly unknown[];
}

/**
 * Structural minimum of a `Diagnostic` — the kit asserts only that each carries a
 * `message`. LSP 3.18 widened `Diagnostic.message` to `string | MarkupContent`, so
 * the minimum admits both shapes — spelled structurally (rather than importing
 * `MarkupContent`) to keep the kit free of a `vscode-languageserver-types`
 * dependency, and so a real `Diagnostic[]` stays assignable with no adapter.
 */
export interface LspConformanceDiagnostic {
   readonly message: string | { readonly value: string };
}

/** True when `diagnostic` carries a message in either LSP shape (plain string or markup). */
function hasTextMessage(diagnostic: LspConformanceDiagnostic): boolean {
   const { message } = diagnostic;
   return typeof message === 'string' || typeof message?.value === 'string';
}

/**
 * The LSP driver port — a live, connected LSP server driven through the
 * lifecycle + document-sync + completion + diagnostics-capture facades.
 * `@hydranium/core/testing/node`'s `LspHarness` satisfies this structurally (its
 * richer return types are assignable to these minima), so the adopter's
 * `connect` returns a `makeLspHarness(...)` with no adapter. `extends Harness`
 * gives the kit the universal `dispose()` teardown.
 */
export interface LspConformanceDriver extends Harness {
   /** Drive the `initialize` → `initialized` handshake; resolve with the (structurally-minimal) result. */
   initialize(): Promise<LspConformanceInitializeResult>;
   /** Send `didOpen` for `uri` with full `text` under `languageId`. */
   openDocument(uri: string, text: string, languageId: string, version?: number): void;
   /** Send `didChange` for `uri` as a single full-text replacement at `version`. */
   changeDocument(uri: string, text: string, version: number): void;
   /** Resolve with the diagnostics of the next `publishDiagnostics` matching `uri`; reject on timeout. */
   nextDiagnostics(uri: string, timeoutMs?: number): Promise<readonly LspConformanceDiagnostic[]>;
   /** Request completion at `position`, normalized to a list. */
   completion(uri: string, position: { line: number; character: number }): Promise<LspConformanceCompletionList>;
   /** Drive the graceful `shutdown` request. */
   shutdown(): Promise<void>;
}

/** Options for `runLspConformance`. */
export interface LspConformanceOptions {
   /**
    * Establish a freshly-wired, connected LSP driver. Called once per check
    * for isolation; the kit disposes it after the check. The kit drives the
    * `initialize` handshake itself per check (it is once-only per connection),
    * so `connect` must NOT pre-initialise.
    */
   readonly connect: () => LspConformanceDriver | Promise<LspConformanceDriver>;
   /** Per-language fixtures; the grammar-bearing checks run once per language. */
   readonly languages: ReadonlyArray<LanguageFixture>;
   /** Suite title override. Default `'conformance: lsp'`. */
   readonly suiteTitle?: string;
}

/** Document version sent on the `didChange` of the re-diagnose check (the open is v1). */
const CHANGED_VERSION = 2;

/**
 * Build the LSP check battery: server-level checks once, then the
 * grammar-bearing checks per language. Completion is an OPTIONAL LSP capability,
 * so both completion checks are opt-in on the same `fixture.completionPosition`
 * signal — the functional completion check and the `completionProvider` baseline
 * advertisement each run only when at least one fixture supplies a position, and
 * otherwise report skipped with a named reason rather than passing vacuously or
 * mandating a capability of servers that do not offer completion.
 * `textDocumentSync` stays mandatory: the document-sync and
 * diagnostics checks depend on it. Each check connects a fresh driver, drives the
 * `initialize` handshake, and disposes the driver. Exported for the kit's own
 * unit tests; adopters call `runLspConformance`.
 */
export function buildLspChecks(options: LspConformanceOptions): ConformanceCheck[] {
   const { connect } = options;
   const checks: ConformanceCheck[] = [];

   // Server-level (once): initialize advertises the mandatory document-sync capability.
   checks.push({
      title: 'initialize advertises the baseline document-sync capability (textDocumentSync)',
      body: async () => {
         const driver = await connect();
         try {
            const result = await driver.initialize();
            assert.notStrictEqual(result.capabilities.textDocumentSync, undefined, 'initialize did not advertise textDocumentSync');
         } finally {
            driver.dispose();
         }
      }
   });

   // Server-level (once): the `completionProvider` advertisement, on the same
   // opt-in gate as the functional completion check below.
   const completionOptedIn = options.languages.some(language => language.completionPosition !== undefined);
   if (completionOptedIn) {
      checks.push({
         title: 'initialize advertises completionProvider (completion opted in)',
         body: async () => {
            const driver = await connect();
            try {
               const result = await driver.initialize();
               assert.notStrictEqual(result.capabilities.completionProvider, undefined, 'initialize did not advertise completionProvider');
            } finally {
               driver.dispose();
            }
         }
      });
   } else {
      checks.push({
         title: 'initialize advertises completionProvider (completion opted in)',
         skipReason: 'no fixture supplied a completionPosition (completion is opt-in)'
      });
   }

   // Server-level (once): shutdown resolves.
   checks.push({
      title: 'shutdown resolves cleanly',
      body: async () => {
         const driver = await connect();
         try {
            await driver.initialize();
            await driver.shutdown();
         } finally {
            driver.dispose();
         }
      }
   });

   for (const language of options.languages) {
      const { valid, invalid, completionPosition } = language;
      const tag = `[${valid.languageId}]`;

      checks.push({
         title: `didOpen(valid) publishes empty diagnostics ${tag}`,
         body: async () => {
            const driver = await connect();
            try {
               await driver.initialize();
               // Resolved AFTER `connect` + `initialize`, so a deferred fixture
               // may name a workspace this check's driver just brought up.
               const model = resolveModel(valid);
               const diagnostics = driver.nextDiagnostics(model.uri);
               driver.openDocument(model.uri, model.text, model.languageId);
               assert.deepStrictEqual(await diagnostics, []);
            } finally {
               driver.dispose();
            }
         }
      });

      checks.push({
         title: `didOpen(invalid) publishes at least one diagnostic, each with a message ${tag}`,
         body: async () => {
            const driver = await connect();
            try {
               await driver.initialize();
               const model = resolveModel(invalid);
               const diagnostics = driver.nextDiagnostics(model.uri);
               driver.openDocument(model.uri, model.text, model.languageId);
               const published = await diagnostics;
               assert.ok(published.length >= 1, 'didOpen(invalid) published no diagnostics');
               assert.ok(published.every(hasTextMessage), 'a published diagnostic was missing a message');
            } finally {
               driver.dispose();
            }
         }
      });

      checks.push({
         title: `didChange(valid → invalid) re-publishes at least one diagnostic ${tag}`,
         body: async () => {
            const driver = await connect();
            try {
               await driver.initialize();
               const model = resolveModel(valid);
               const initial = driver.nextDiagnostics(model.uri);
               driver.openDocument(model.uri, model.text, model.languageId);
               await initial;
               const reDiagnosed = driver.nextDiagnostics(model.uri);
               driver.changeDocument(model.uri, resolveDeferred(invalid.text), CHANGED_VERSION);
               assert.ok((await reDiagnosed).length >= 1, 'didChange(valid → invalid) re-published no diagnostics');
            } finally {
               driver.dispose();
            }
         }
      });

      // Opt-in: completion runs only when the fixture supplies a position.
      if (completionPosition) {
         checks.push({
            title: `completion answers with a well-formed item list ${tag}`,
            body: async () => {
               const driver = await connect();
               try {
                  await driver.initialize();
                  const model = resolveModel(valid);
                  const diagnostics = driver.nextDiagnostics(model.uri);
                  driver.openDocument(model.uri, model.text, model.languageId);
                  await diagnostics;
                  const { items } = await driver.completion(model.uri, completionPosition);
                  assert.ok(Array.isArray(items), 'completion did not return an items array');
                  // Supplying a `completionPosition` IS the claim that
                  // completion answers there, so an empty list is a failure
                  // rather than a vacuous pass. `items` is already typed as a
                  // list and the driver normalises to one, so the bare
                  // `Array.isArray` this replaced could not fail at all.
                  assert.ok(items.length > 0, 'completion returned no items at the position the fixture opted in with');
                  for (const item of items) {
                     const label = (item as { label?: unknown }).label;
                     assert.ok(
                        typeof label === 'string' && label.length > 0,
                        `completion returned an item with no label: ${JSON.stringify(item)}`
                     );
                  }
               } finally {
                  driver.dispose();
               }
            }
         });
      } else {
         checks.push({
            title: `completion answers with a well-formed item list ${tag}`,
            skipReason: 'fixture supplied no completionPosition'
         });
      }
   }

   return checks;
}
