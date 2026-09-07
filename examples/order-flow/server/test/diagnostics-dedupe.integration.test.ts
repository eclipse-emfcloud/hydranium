/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * `HydraniumDocumentBuilder.dedupeDiagnostics` over a real adopter boot, in
 * both build configurations.
 *
 * # What each configuration can and cannot establish
 *
 * `ModelServiceOptions.serializeBuilds` defaults to `true`, and with builds
 * serialised the duplicate diagnostics this net exists to collapse never occur —
 * so that variant measures the LOCK, and its absolute no-duplicates assertion
 * is sound because the lock is what the promise rests on.
 *
 * Turning the option off runs the net for real, but **its completeness is not
 * asserted here, because the framework does not promise it** in that
 * configuration: the dedupe cannot close the window Langium's appending
 * validate opens after it (see the publishing suite below). So the off variant
 * asserts only what does hold — that the net never swallows a real finding —
 * and classifies any duplicate to the log instead of failing.
 *
 * Nothing in this file therefore asserts that the net collapses every duplicate
 * it is handed. That claim is carried by the `classifyDuplicates` unit tests
 * for the classification itself, and establishing it end to end would need a
 * test that drives the append window deterministically rather than waiting for
 * load to open it.
 *
 * # Why this needs an LSP connection
 *
 * Booted headless (`createOrderFlowServices` +
 * `initializeWorkspaceProgrammatically`, driving `ModelService.update`) both
 * cases below pass **with `dedupeDiagnostics` disabled**, so a headless version
 * of this suite asserts nothing. The reason is stated outright in
 * `rebuildCanonical`: *"the bridge only exists under a `Connection`, so the
 * facade stands in for it headless."* Headless there is exactly ONE build of the
 * URI, no race, and nothing to duplicate. **A headless adopter test cannot reach
 * this path at all.**
 *
 * With a real connection both builds run: Langium's text-change bridge (under
 * `workspaceLock.write`) and the facade's `rebuildCanonical`. With the lock off
 * they are concurrent, each computes its missing validation categories before
 * the other records its own, both run a full pass, and Langium's deliberate
 * append — meant for category-partitioned passes — duplicates the lot.
 *
 * # What is asserted
 *
 * The PUBLISHED payload, not an internal count. What matters to a user is that
 * the client is never shown the same error twice, whatever the framework did
 * internally to get there.
 */

import { appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModelService } from '@hydranium/core';
import { NodeFileSystem } from '@hydranium/core/node';
import { makeLspHarness, makeScratchWorkspace, type LspHarness, type ScratchWorkspace } from '@hydranium/core/testing/node';
import { URI, type Module } from '@hydranium/langium';
import type { PartialLangiumSharedServices } from '@hydranium/langium/lsp';
import type { Diagnostic } from 'vscode-languageserver';
import { afterEach, describe, expect, it } from 'vitest';
import { createOrderFlowServices, type OrderFlowSharedServices } from '../src/language-server/order-flow-module.js';
import { WORKSPACE_FILES, WORKSPACE_ROOT } from './order-flow-harness.js';

/**
 * Rebind `ModelService` with the serialisation opt-out. This is the whole
 * reason `createOrderFlowServices` accepts extra shared modules: the framework
 * constructs its own services with no options, so rebinding the slot is the only
 * route to a non-default one.
 */
function withSerializeBuilds(serializeBuilds: boolean): Module<OrderFlowSharedServices, PartialLangiumSharedServices> {
   return {
      model: {
         ModelService: (services: OrderFlowSharedServices) => new ModelService(services, { serializeBuilds })
      }
   } as unknown as Module<OrderFlowSharedServices, PartialLangiumSharedServices>;
}

let workspace: ScratchWorkspace | undefined;
let harness: LspHarness | undefined;

afterEach(() => {
   harness?.dispose();
   harness = undefined;
   workspace?.dispose();
   workspace = undefined;
});

interface Booted {
   readonly shared: OrderFlowSharedServices;
   readonly harness: LspHarness;
   readonly uri: string;
}

/** Boot the three grammars behind a real in-process LSP connection. */
async function boot(serializeBuilds: boolean): Promise<Booted> {
   workspace = makeScratchWorkspace({ seed: WORKSPACE_ROOT, prefix: 'order-flow-dedupe-' });
   let shared: OrderFlowSharedServices | undefined;
   const booted = makeLspHarness({
      createServices: connection => {
         shared = createOrderFlowServices(
            { connection, ...NodeFileSystem },
            { extraSharedModules: [withSerializeBuilds(serializeBuilds)] }
         ).shared;
         return shared;
      }
   });
   harness = booted;
   await booted.initialize({ workspaceFolders: [{ uri: workspace.uri(), name: 'order-flow' }] });
   if (!shared) {
      throw new Error('createServices did not run');
   }
   return { shared, harness: booted, uri: workspace.uri(WORKSPACE_FILES.auditLeak) };
}

/**
 * Stable identity of a diagnostic, for spotting a repeat within one payload.
 * `message` is `string | MarkupContent` in LSP 3.18, so it is normalised rather
 * than assumed — a duplicate must compare equal whichever form it arrives in.
 */
function keyOf(diagnostic: Diagnostic): string {
   const message = typeof diagnostic.message === 'string' ? diagnostic.message : diagnostic.message.value;
   return `${diagnostic.range.start.line}:${diagnostic.range.start.character}:${message}`;
}

/** One recorded publish, keeping the raw diagnostics so a duplicate can be classified. */
interface Payload {
   readonly keys: readonly string[];
   readonly diagnostics: readonly Diagnostic[];
}

/**
 * Name what kind of duplicate a payload holds, returning one line per repeated
 * key and nothing at all for a clean payload.
 *
 * {@link keyOf} is deliberately COARSER than the contract under test:
 * `dedupeDiagnostics` collapses only diagnostics that are structurally equal in
 * EVERY field at the same full range, while this suite's key is start position
 * plus message. So a detection here is one of two very different things, and a
 * failure message carrying only a count cannot tell them apart — which is why
 * an intermittent red on this suite has repeatedly been re-gated past on a word
 * rather than a measurement:
 *
 * - **byte-identical** — the dedupe let a duplicate through, which is the defect
 *   this suite exists to catch;
 * - **key collision** — two distinct findings sharing a start position and a
 *   message, which the dedupe is not meant to collapse and which the coarse key
 *   reports anyway. That is a defect in the KEY, not in the framework.
 *
 * The key stays coarse rather than being tightened to full structural equality,
 * because a coarse key cannot MISS a real duplicate; tightening it would make
 * the second case vanish silently, which is the one outcome that would leave the
 * question unanswered again.
 */
function classifyDuplicates(payload: Payload): string[] {
   const grouped = new Map<string, Diagnostic[]>();
   payload.diagnostics.forEach((diagnostic, index) => {
      const key = payload.keys[index];
      grouped.set(key, [...(grouped.get(key) ?? []), diagnostic]);
   });
   const lines: string[] = [];
   for (const [key, group] of grouped) {
      if (group.length < 2) {
         continue;
      }
      const serialised = group.map(diagnostic => JSON.stringify(diagnostic));
      if (new Set(serialised).size === 1) {
         lines.push(`BYTE-IDENTICAL x${group.length} '${key}' — dedupeDiagnostics did not collapse it: ${serialised[0]}`);
         continue;
      }
      lines.push(`KEY COLLISION x${group.length} '${key}' — distinct diagnostics the coarse key merged: ${serialised.join(' || ')}`);
   }
   return lines;
}

/**
 * Record the whole publish sequence and the classification before the assertion
 * fails, so an intermittent red is self-diagnosing rather than needing another
 * run to reproduce.
 *
 * Written with `process.stderr.write` because vitest attributes console output
 * to the running test and drops anything from a continuation that resolves after
 * the body — and appended to a file as well, because stderr does not reliably
 * survive the worker boundary under a concurrent full-suite run, which is the
 * only load this red has ever been observed under.
 */
function recordDuplicates(payloads: readonly Payload[], offending: Payload): void {
   // Named in the report, because `tmpdir()` honours TMPDIR and is not
   // necessarily `/tmp` — a reader who guesses the path finds nothing and
   // concludes the instrumentation never ran.
   const logPath = join(tmpdir(), 'hydranium-diagnostics-dedupe.log');
   const lines = [
      `diagnostics-dedupe: ${payloads.length} publish(es) for the URI; offending payload carries ${offending.keys.length} diagnostic(s)`,
      `  also appended to ${logPath}`,
      ...classifyDuplicates(offending).map(line => `  ${line}`),
      ...payloads.map((payload, index) => `  publish[${index}]: ${payload.keys.length} — ${JSON.stringify(payload.keys)}`)
   ];
   const report = `${new Date().toISOString()}\n${lines.join('\n')}\n`;
   process.stderr.write(report);
   appendFileSync(logPath, report);
}

/**
 * Drive a programmatic write through the facade and return EVERY diagnostics
 * payload the client was published for the URI as a result.
 *
 * Every payload, not the next one — and that distinction is what makes this
 * suite work. Awaiting `nextDiagnostics(uri)` alone passes even with
 * `dedupeDiagnostics` disabled, because a write provokes a fan-out of publishes
 * and the duplicated one is not necessarily the one that wait samples.
 * `LspServerConnection.diagnostics` documents the right tool for a fan-out —
 * record the length before acting, then read the tail — and that is what this
 * does.
 *
 * `audit-leak.domain` is the workspace's one intended error, so there is a real
 * diagnostic to duplicate; the appended comment keeps it unresolvable.
 */
async function publishedAfterWrite(serializeBuilds: boolean): Promise<Payload[]> {
   const { shared, harness: booted, uri } = await boot(serializeBuilds);

   const document = await shared.workspace.LangiumDocuments.getOrCreateDocument(URI.parse(uri));
   await shared.workspace.DocumentBuilder.build([document], { validation: true });
   const text = document.textDocument.getText();

   // Open it as a client would, so Langium's text-change bridge has a synced
   // document to react to — without this the facade is the only builder and
   // there is no second pass to race.
   booted.openDocument(uri, text, 'order-flow-domain');

   const before = booted.diagnostics.length;
   await shared.model.ModelService.update({ uri, model: `${text}\n// touched\n`, clientId: 'dedupe-test' });
   await booted.nextDiagnostics(uri);
   // Let any FOLLOWING publish from the second, racing build land too. Without
   // this the tail holds only the first payload and the duplicated one escapes.
   await new Promise(resolve => setTimeout(resolve, 300));

   return booted.diagnostics
      .slice(before)
      .filter(published => published.uri === uri)
      .map(published => ({ keys: published.diagnostics.map(keyOf), diagnostics: published.diagnostics }));
}

/** Assert the workspace's intended error reaches a client at all. */
function expectIntendedErrorPublished(payloads: readonly Payload[]): void {
   expect(payloads.length).toBeGreaterThan(0);
   expect(payloads.flatMap(payload => [...payload.keys]).join('\n')).toContain('AuditStamp');
}

/**
 * Assert the intended error is present, once, in every payload.
 *
 * Sound only where the framework promises it — see the `serializeBuilds` note
 * on the publishing suite below.
 */
function expectNoDuplicates(payloads: readonly Payload[]): void {
   expectIntendedErrorPublished(payloads);
   for (const payload of payloads) {
      // Recorded BEFORE the assertion, so the classification survives the throw.
      if (new Set(payload.keys).size !== payload.keys.length) {
         recordDuplicates(payloads, payload);
      }
      expect(new Set(payload.keys).size).toBe(payload.keys.length);
   }
}

/**
 * Classify any duplicate without failing, for the configuration that permits
 * one.
 *
 * Reporting rather than asserting is the whole difference between the two
 * variants: a duplicate here is a fact about an unpromised configuration, and a
 * test that fails on it teaches that the framework guarantees something it does
 * not.
 */
function reportDuplicates(payloads: readonly Payload[]): void {
   for (const payload of payloads) {
      if (new Set(payload.keys).size !== payload.keys.length) {
         recordDuplicates(payloads, payload);
      }
   }
}

/**
 * The classifier, on fabricated input, in both directions.
 *
 * A classifier that has stopped discriminating would report every intermittent
 * red as the same thing, which is exactly the state this instrumentation was
 * added to escape — and the real suite reaches it only when it fails, so a green
 * run says nothing about whether it still works.
 */
describe('classifyDuplicates', () => {
   const at = (endCharacter: number, extra: Partial<Diagnostic> = {}): Diagnostic => ({
      range: { start: { line: 3, character: 0 }, end: { line: 3, character: endCharacter } },
      message: 'Could not resolve reference to TypeOne named AuditStamp',
      ...extra
   });
   const payloadOf = (diagnostics: Diagnostic[]): Payload => ({ keys: diagnostics.map(keyOf), diagnostics });

   it('names a byte-identical repeat, which is a dedupe the framework owes', () => {
      expect(classifyDuplicates(payloadOf([at(9), at(9)]))).toEqual([expect.stringContaining('BYTE-IDENTICAL x2')]);
   });

   it('names a same-start same-message pair differing elsewhere as the coarse key merging two findings', () => {
      // Differing only in the END position, which `dedupeDiagnostics` buckets by
      // and therefore never collapses — so the framework is right and the key is
      // what reported a duplicate.
      expect(classifyDuplicates(payloadOf([at(9), at(14)]))).toEqual([expect.stringContaining('KEY COLLISION x2')]);
      // And differing only in a field the key cannot see at all.
      expect(classifyDuplicates(payloadOf([at(9), at(9, { code: 'other' })]))).toEqual([expect.stringContaining('KEY COLLISION x2')]);
   });

   it('says nothing about a payload with no repeated key', () => {
      expect(classifyDuplicates(payloadOf([at(9), { ...at(9), message: 'a different finding' }]))).toEqual([]);
   });
});

/**
 * Duplicate-free publishing is promised with builds SERIALISED, and only then.
 *
 * With `serializeBuilds` off the framework makes no such promise, so the off
 * variant must not assert one. `dedupeDiagnostics` runs ahead of the phase
 * listeners, but Langium's validate PUSHES onto the live diagnostics array and
 * two awaits separate the dedupe from the publisher, so a build settling inside
 * that window appends after the dedupe has already run. Only the build lock
 * closes the window.
 *
 * What the off variant asserts instead is the guarantee that does hold there:
 * the dedupe must not over-collapse and swallow a real finding. Duplicates are
 * classified and reported rather than failed on, because an absolute assertion
 * over an unpromised configuration reports a framework defect for a
 * configuration the framework never covered — and its intermittent red is what
 * five waves re-gated past on the strength of the word `flake`, a word that
 * described attribution and was never a measurement of correctness.
 */
describe('diagnostics publishing', () => {
   it('never publishes the same diagnostic twice with builds serialised', async () => {
      expectNoDuplicates(await publishedAfterWrite(true));
   }, 60_000);

   it('still publishes the intended error with serializeBuilds off', async () => {
      const payloads = await publishedAfterWrite(false);
      expectIntendedErrorPublished(payloads);
      reportDuplicates(payloads);
   }, 60_000);
});
