/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * The discrimination self-test for the `/lsp` battery: proof that each check
 * FAILS when the property it names is broken. One passing subject, then one
 * derivation per property breaking exactly that property, so a check that has
 * stopped asserting anything fails here instead of reading as coverage.
 *
 * A message-LESS diagnostic is deliberately not among the canaries: it is not
 * constructible against `LspConformanceDiagnostic` without a cast. The empty
 * string is, and it is covered — narrowing `hasTextMessage` to reject it is
 * what made that case reachable, since a type-only test admits `''` and so
 * passed a head publishing no readable message at all.
 */

import { describe, expect, it } from 'vitest';
import {
   buildLspChecks,
   type LspConformanceCompletionList,
   type LspConformanceDiagnostic,
   type LspConformanceDriver,
   type LspConformanceInitializeResult
} from '../src/lsp/index.js';
import type { ConformanceCheck } from '../src/conformance-suite.js';
import type { LanguageFixture } from '../src/model.js';

const VALID_TEXT = 'element One';
const INVALID_TEXT = 'element';

const FIXTURE: LanguageFixture = {
   valid: { uri: 'file:///one.x', languageId: 'x', text: VALID_TEXT },
   invalid: { uri: 'file:///two.x', languageId: 'x', text: INVALID_TEXT },
   completionPosition: { line: 0, character: 7 }
};

/**
 * How long the fake waits for a publish that a defect suppresses. Short
 * because nothing here is asynchronous by nature — the fake publishes
 * synchronously from `openDocument`, so this bounds only the deliberately
 * silent cases and keeps the suite off a real timeout.
 */
const PUBLISH_TIMEOUT_MS = 40;

interface LspCanaryDefects {
   /** `initialize` omits the mandatory document-sync capability. */
   readonly noTextDocumentSync?: boolean;
   /** `initialize` omits `completionProvider` although the fixture opted in. */
   readonly noCompletionProvider?: boolean;
   /** `shutdown` rejects instead of resolving. */
   readonly shutdownRejects?: boolean;
   /** A valid model is published with a diagnostic anyway. */
   readonly diagnosticsOnValid?: boolean;
   /** An invalid model is published clean. */
   readonly cleanInvalid?: boolean;
   /** A diagnostic is published carrying an empty message. */
   readonly emptyDiagnosticMessage?: boolean;
   /** `didChange` is accepted but never re-publishes. */
   readonly ignoreChanges?: boolean;
   /** Completion answers an empty list at the position the fixture opted in with. */
   readonly noCompletionItems?: boolean;
   /** Completion answers an item carrying no label. */
   readonly unlabelledCompletionItem?: boolean;
}

/**
 * An LSP server that satisfies every check in the `/lsp` battery, or fails
 * exactly the ones a {@link LspCanaryDefects} flag names.
 *
 * Its whole "grammar" is that {@link INVALID_TEXT} is the one invalid model. A
 * real parser would add no discrimination, because the battery observes only
 * whether a publish happened and whether what it carried is well-formed, never
 * what the diagnostics say.
 */
class CanaryLspServer implements LspConformanceDriver {
   private readonly waiting = new Map<string, (diagnostics: readonly LspConformanceDiagnostic[]) => void>();

   constructor(private readonly defects: LspCanaryDefects = {}) {}

   async initialize(): Promise<LspConformanceInitializeResult> {
      return {
         capabilities: {
            textDocumentSync: this.defects.noTextDocumentSync ? undefined : 1,
            completionProvider: this.defects.noCompletionProvider ? undefined : {}
         }
      };
   }

   openDocument(uri: string, text: string): void {
      this.publish(uri, text);
   }

   changeDocument(uri: string, text: string): void {
      if (!this.defects.ignoreChanges) {
         this.publish(uri, text);
      }
   }

   nextDiagnostics(uri: string, timeoutMs: number = PUBLISH_TIMEOUT_MS): Promise<readonly LspConformanceDiagnostic[]> {
      return new Promise((resolve, reject) => {
         const deadline = setTimeout(() => {
            this.waiting.delete(uri);
            reject(new Error(`the canary published no diagnostics for ${uri}`));
         }, timeoutMs);
         this.waiting.set(uri, diagnostics => {
            clearTimeout(deadline);
            resolve(diagnostics);
         });
      });
   }

   async completion(): Promise<LspConformanceCompletionList> {
      if (this.defects.noCompletionItems) {
         return { items: [] };
      }
      return { items: this.defects.unlabelledCompletionItem ? [{}] : [{ label: 'One' }] };
   }

   async shutdown(): Promise<void> {
      if (this.defects.shutdownRejects) {
         throw new Error('the canary server refused to shut down');
      }
   }

   dispose(): void {
      this.waiting.clear();
   }

   private publish(uri: string, text: string): void {
      const waiter = this.waiting.get(uri);
      if (!waiter) {
         return;
      }
      this.waiting.delete(uri);
      waiter(this.diagnosticsFor(text));
   }

   private diagnosticsFor(text: string): readonly LspConformanceDiagnostic[] {
      if (this.defects.diagnosticsOnValid) {
         return [{ message: 'the canary reports every model as broken' }];
      }
      if (this.defects.cleanInvalid) {
         return [];
      }
      if (text !== INVALID_TEXT) {
         return [];
      }
      return [{ message: this.defects.emptyDiagnosticMessage ? '' : 'the canary grammar wants a name' }];
   }
}

const SYNC_CAPABILITY = 'initialize advertises the baseline document-sync capability';
const COMPLETION_CAPABILITY = 'initialize advertises completionProvider';
const SHUTDOWN = 'shutdown resolves cleanly';
const OPEN_VALID = 'didOpen(valid) publishes empty diagnostics';
const OPEN_INVALID = 'didOpen(invalid) publishes at least one diagnostic';
const RE_DIAGNOSE = 'didChange(valid → invalid) re-publishes at least one diagnostic';
const COMPLETION = 'completion answers with a well-formed item list';

function batteryOver(defects: LspCanaryDefects = {}): ConformanceCheck[] {
   const server = new CanaryLspServer(defects);
   return buildLspChecks({ connect: () => server, languages: [FIXTURE] });
}

async function failingChecks(defects: LspCanaryDefects): Promise<string[]> {
   const failures: string[] = [];
   for (const check of batteryOver(defects)) {
      if (!check.body) {
         continue;
      }
      try {
         await check.body();
      } catch {
         failures.push(check.title);
      }
   }
   return failures;
}

function matching(titles: readonly string[], fragments: readonly string[]): string[] {
   return titles.filter(title => fragments.some(fragment => title.includes(fragment)));
}

describe('the /lsp battery discriminates', () => {
   it('passes every check against a conforming server', async () => {
      expect(await failingChecks({})).toEqual([]);
   });

   it('plans exactly the seven checks the must-fail cases below name', () => {
      const titles = batteryOver().map(check => check.title);
      expect(titles).toHaveLength(7);
      const covered = [SYNC_CAPABILITY, COMPLETION_CAPABILITY, SHUTDOWN, OPEN_VALID, OPEN_INVALID, RE_DIAGNOSE, COMPLETION];
      expect(matching(titles, covered)).toHaveLength(7);
   });

   const canaries: ReadonlyArray<{ label: string; defects: LspCanaryDefects; expected: readonly string[] }> = [
      { label: 'no textDocumentSync capability', defects: { noTextDocumentSync: true }, expected: [SYNC_CAPABILITY] },
      { label: 'no completionProvider capability', defects: { noCompletionProvider: true }, expected: [COMPLETION_CAPABILITY] },
      { label: 'a shutdown that rejects', defects: { shutdownRejects: true }, expected: [SHUTDOWN] },
      { label: 'a diagnostic on a valid model', defects: { diagnosticsOnValid: true }, expected: [OPEN_VALID] },
      // Two checks, legitimately: the re-diagnose check drives valid → invalid
      // and reads the same publish, so a server that calls every model clean
      // fails both. Declared rather than narrowed — a defect's real blast
      // radius is the thing this table records.
      { label: 'an invalid model published clean', defects: { cleanInvalid: true }, expected: [OPEN_INVALID, RE_DIAGNOSE] },
      // Only the didOpen(invalid) check: the re-diagnose check asserts a
      // COUNT, not message content, so an empty message satisfies it.
      { label: 'a diagnostic with an empty message', defects: { emptyDiagnosticMessage: true }, expected: [OPEN_INVALID] },
      { label: 'a didChange that never re-publishes', defects: { ignoreChanges: true }, expected: [RE_DIAGNOSE] },
      { label: 'completion answering an empty list', defects: { noCompletionItems: true }, expected: [COMPLETION] },
      { label: 'a completion item with no label', defects: { unlabelledCompletionItem: true }, expected: [COMPLETION] }
   ];

   for (const canary of canaries) {
      it(`fails exactly its checks on ${canary.label}`, async () => {
         const failures = await failingChecks(canary.defects);
         expect(matching(failures, canary.expected)).toHaveLength(canary.expected.length);
         expect(failures).toHaveLength(canary.expected.length);
      });
   }
});
