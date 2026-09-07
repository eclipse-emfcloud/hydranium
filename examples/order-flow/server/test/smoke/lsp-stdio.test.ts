/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * Stdio smoke test for the `order-flow` LSP head, spawned as a real subprocess.
 *
 * Drives `node lib/main.js --stdio` over the LSP wire protocol. This is a WIRING
 * smoke only: it proves the real binary boots all three heads without corrupting
 * the protocol stream, and that the load-bearing LSP paths connect end-to-end —
 * the `initialize` handshake, a `didOpen` → `publishDiagnostics` push (clean and
 * with a real linker diagnostic, so the build/link pipeline genuinely runs), a
 * completion request/response round-trip, and `didChange` → re-diagnose. A
 * packaging or wiring break (missing service registration, a language left
 * unregistered, a regressed bootstrap, an un-produced `lib/main.js`) surfaces
 * here before any host integration.
 *
 * **What only the subprocess tier can show, and why `order-flow` shows more of
 * it than a single-grammar example can.** The child indexes a real workspace, so
 * a `.process` document opened cold resolves three chained references into a
 * `.domain` file in a *different grammar* — over the wire, in a separate
 * process, with the shared index built by the child's own workspace scan. The
 * in-process tiers reach the same code through an in-memory duplex pair; only
 * this one proves the built artefact does.
 *
 * Detailed provider BEHAVIOUR is deliberately NOT asserted here. The exact
 * dependent-scope candidate sets are owned by
 * `test/lsp-harness.integration.test.ts` and the protocol invariants by
 * `test/lsp-conformance.integration.test.ts`, both in-process and debuggable
 * with a normal debugger. Keep this smoke thin: assert wiring here, behaviour
 * there.
 *
 * **stderr is captured, never asserted empty.** `LspLogger` is bound by default
 * and emits at `info`, and GLSP's logs route the same way, so the line count is
 * log-level-dependent. stdout is the one channel with a contract, and it is
 * asserted implicitly: a stray write there would corrupt the JSON-RPC framing
 * and fail the handshake in `beforeAll`.
 */

import { type ScratchWorkspace, makeScratchWorkspace } from '@hydranium/core/testing/node';
import { Diagnostic, TextDocumentSyncKind } from 'vscode-languageserver-protocol';
import {
   type CompletionItem,
   type CompletionList,
   CompletionRequest,
   DidChangeTextDocumentNotification,
   DidOpenTextDocumentNotification
} from 'vscode-languageserver-protocol/node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DomainLanguageMetaData, ProcessLanguageMetaData } from '../../src/language-server/generated/module.js';
import { WORKSPACE_ROOT } from '../order-flow-harness.js';
import { SPAWN_TIMEOUT_MS, type SpawnedOrderFlowServer, startSpawnedOrderFlowServer } from './spawned-order-flow-server.js';

let server: SpawnedOrderFlowServer | undefined;
let workspace: ScratchWorkspace | undefined;

/** The spawned server, or a throw naming the missing setup rather than a `undefined` deref. */
function spawned(): SpawnedOrderFlowServer {
   if (!server) {
      throw new Error('spawned server not started');
   }
   return server;
}

/** `file:` URI of a workspace-relative path inside the scratch copy — what the wire carries. */
function uriOf(relativePath: string): string {
   if (!workspace) {
      throw new Error('scratch workspace not seeded');
   }
   return workspace.uri(relativePath);
}

/**
 * Open a document and return the diagnostics its build publishes.
 *
 * The index is recorded BEFORE the `didOpen`, which is what makes the read
 * immune to a publish that beats the wait — the contract the framework's
 * `nextDiagnostics` states.
 */
async function openAndDiagnose(uri: string, languageId: string, text: string): Promise<Diagnostic[]> {
   const from = spawned().diagnostics.length;
   spawned().connection.sendNotification(DidOpenTextDocumentNotification.type, {
      textDocument: { uri, languageId, version: 1, text }
   });
   return spawned().nextDiagnostics(uri, { fromIndex: from });
}

describe('order-flow LSP stdio smoke', () => {
   beforeAll(async () => {
      workspace = makeScratchWorkspace({ seed: WORKSPACE_ROOT, prefix: 'order-flow-smoke-lsp-' });
      server = await startSpawnedOrderFlowServer({ workspaceRoot: workspace.root });
   }, SPAWN_TIMEOUT_MS);

   afterAll(async () => {
      const exitCode = await server?.dispose();
      const stderr = server?.stderr() ?? '';
      server = undefined;
      workspace?.dispose();
      workspace = undefined;
      if (stderr.trim().length > 0) {
         process.stderr.write(`order-flow server stderr:\n${stderr}\n`);
      }
      // The graceful `shutdown` / `exit` pair, asserted rather than assumed: a
      // head that throws on teardown exits non-zero, and nothing else in the
      // repo drives that path against the built binary.
      expect(exitCode === 0 || exitCode === null).toBe(true);
   }, SPAWN_TIMEOUT_MS);

   it('advertises the capability surface the three-head entry boots behind', () => {
      const capabilities = spawned().initializeResult.capabilities;

      const sync = capabilities.textDocumentSync;
      const syncKind = typeof sync === 'object' && sync !== null ? sync.change : sync;
      expect(syncKind).toBe(TextDocumentSyncKind.Incremental);
      expect(capabilities.completionProvider).toBeDefined();
      expect(capabilities.hoverProvider).toBeTruthy();
      expect(capabilities.definitionProvider).toBeTruthy();
      expect(capabilities.renameProvider).toBeDefined();
      // Workspace folders are how the child learned about the sample workspace at
      // all, so this one is the precondition for every cross-document case below.
      expect(capabilities.workspace?.workspaceFolders?.supported).toBe(true);
   });

   it('publishes empty diagnostics for a well-formed .domain document', async () => {
      // `ID` is `public` in `commerce-core` and reachable because `orders`
      // requires it; `String` is a stdlib primitive at the universal tier. Both
      // tiers therefore have to be live in the child for this to come back clean.
      const diagnostics = await openAndDiagnose(
         uriOf('orders/smoke-clean.domain'),
         DomainLanguageMetaData.languageId,
         'entity Shipment {\n   trackingId: ID\n   carrier: String\n}\n'
      );

      expect(diagnostics).toEqual([]);
   });

   it('publishes a linker diagnostic for an unresolved type reference', async () => {
      const diagnostics = await openAndDiagnose(
         uriOf('orders/smoke-unresolved.domain'),
         DomainLanguageMetaData.languageId,
         'entity Shipment {\n   carrier: NoSuchValueType\n}\n'
      );

      expect(diagnostics.length).toBeGreaterThan(0);
      const messages = diagnostics.map(diagnostic => Diagnostic.getMessageString(diagnostic));
      expect(messages.some(message => /NoSuchValueType/.test(message))).toBe(true);
   });

   it('resolves a cross-grammar reference chain in a document opened cold', async () => {
      // `writes Order.status = PAID` is three references, each scoped by the
      // previous, and all three cross from `.process` into `.domain`. A clean
      // publish means the child's own workspace scan built the shared index and
      // the second grammar resolved against it — the assertion no single-grammar
      // smoke can make.
      const diagnostics = await openAndDiagnose(
         uriOf('orders/smoke-cold.process'),
         ProcessLanguageMetaData.languageId,
         'process SmokeFlow for Order {\n   task Confirm writes Order.status = PAID\n}\n'
      );

      expect(diagnostics).toEqual([]);
   });

   it('answers a completion request over the wire with a non-empty item list', async () => {
      const uri = uriOf('orders/smoke-complete.process');
      // The probe parses CLEANLY and completion is asked at the offset where an
      // existing reference begins. A truncated `writes Order.` never reaches a
      // state the handler answers at, so it hangs rather than failing.
      const text = 'process SmokeProbe for Order {\n   task Pay writes Order.status = PAID\n}\n';
      await openAndDiagnose(uri, ProcessLanguageMetaData.languageId, text);

      const response = await spawned().connection.sendRequest(CompletionRequest.type, {
         textDocument: { uri },
         position: { line: 1, character: 25 } // where `status` starts, i.e. just past `Order.`
      });

      const items: CompletionItem[] = Array.isArray(response) ? response : ((response as CompletionList | null)?.items ?? []);
      expect(items.length).toBeGreaterThan(0);
      // `status` is a field of the entity `Order` resolved to. Asserting a label
      // rather than only the list length is what makes this a round-trip through
      // real services instead of a request that merely returned something.
      expect(items.map(item => item.label)).toContain('status');
   });

   it('re-publishes diagnostics after didChange', async () => {
      const uri = uriOf('orders/smoke-change.domain');
      expect(await openAndDiagnose(uri, DomainLanguageMetaData.languageId, 'entity Shipment {\n   carrier: String\n}\n')).toEqual([]);

      // A write fans out more than one publish, so record the length first and
      // read the tail for this URI rather than sampling whatever arrives next.
      const from = spawned().diagnostics.length;
      spawned().connection.sendNotification(DidChangeTextDocumentNotification.type, {
         textDocument: { uri, version: 2 },
         contentChanges: [{ text: 'entity Shipment {\n   carrier: NoSuchValueType\n}\n' }]
      });

      const diagnostics = await spawned().nextDiagnostics(uri, { fromIndex: from });
      expect(diagnostics.length).toBeGreaterThan(0);
   });
});
