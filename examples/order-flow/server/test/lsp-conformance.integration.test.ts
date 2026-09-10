/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * Dogfood of the `@hydranium/conformance/lsp` slice against the real
 * `order-flow` LSP head, over all three grammars — how an adopter proves their
 * own server speaks the LSP protocol.
 *
 * The per-language battery runs once per grammar over ONE server, so `didOpen`
 * has to route to the right language by URI *and* `languageId` — which on this
 * head is load-bearing, unlike the data head where it only decorates a check
 * title.
 *
 * # The constraint an adopter has to solve to run this suite
 *
 * The TCK needs BOTH project state and live wire requests: every check calls
 * `driver.initialize()`, and a `.process` fixture is only valid relative to a
 * `.domain` file declaring its subject. `makeLspHarness`'s `initialize` covers
 * exactly that — supply `workspaceFolders` and it settles the workspace before
 * returning, which is why `connect` below binds them in.
 *
 * **Do not substitute an empty wire handshake plus
 * `initializeWorkspaceProgrammatically`, and do not mix `buildWorkspace` in.**
 * That combination publishes **no diagnostics for any document at all**, with no
 * `OperationCancelled` or any other error surfacing: every grammar-bearing check
 * times out while the server-level ones pass, which reads as a broken diagnostic
 * pipeline rather than as a misused harness. The observation that names it is
 * `harness.diagnostics` — an empty array there is the whole diagnosis.
 */

import type { LanguageFixture } from '@hydranium/conformance';
import { runLspConformance } from '@hydranium/conformance/vitest';
import { NodeFileSystem } from '@hydranium/core/node';
import { makeLspHarness, makeScratchWorkspace, type ScratchWorkspace } from '@hydranium/core/testing/node';
import { afterAll } from 'vitest';
import { DomainLanguageMetaData, LayoutLanguageMetaData, ProcessLanguageMetaData } from '../src/language-server/generated/module.js';
import { createOrderFlowServices } from '../src/language-server/order-flow-module.js';
import { WORKSPACE_ROOT } from './order-flow-harness.js';

/**
 * The throwaway workspace the CURRENT check runs over. Rotated in `connect`, so
 * every check gets pristine input and at most one temp directory is alive.
 *
 * The fixture URIs have to sit inside a booted workspace for the `.process`
 * subject to resolve — the same constraint the data slice has, for the same
 * reason — and they are DEFERRED thunks, which is what lets the root be chosen
 * per check instead of baked in at module load.
 */
let workspace: ScratchWorkspace | undefined;

afterAll(() => {
   workspace?.dispose();
   workspace = undefined;
});

/** The workspace the current check is running over, or a throw naming the misuse. */
function currentWorkspace(): ScratchWorkspace {
   if (!workspace) {
      throw new Error('fixture value read before connect booted a workspace');
   }
   return workspace;
}

const uri =
   (relativePath: string): (() => string) =>
   () =>
      currentWorkspace().uri(relativePath);

/**
 * `.domain` — resolvable on its own once the workspace is up: `ID` comes from
 * `commerce-core` at the public tier, `String` from the stdlib at universal.
 */
const domainFixture: LanguageFixture = {
   valid: {
      uri: uri('orders/lsp-conformance.domain'),
      languageId: DomainLanguageMetaData.languageId,
      text: 'entity Crate {\n   tracking: ID\n   label: String\n}\n'
   },
   invalid: {
      uri: uri('orders/lsp-conformance-invalid.domain'),
      languageId: DomainLanguageMetaData.languageId,
      text: 'entity Pallet {\n   packing: NoSuchType\n}\n'
   },
   // Inside a field's type position, so the candidates are declarations rather
   // than keywords. The kit asserts only a well-formed list; the actual
   // candidate sets are asserted in `lsp-harness.integration.test.ts`.
   completionPosition: { line: 1, character: 13 },
   /**
    * Server-side rendering, opted into on THIS grammar only.
    *
    * One fixture is enough: the render is one shared pass over
    * `document.diagnostics`, not a per-grammar behaviour, so opting in three
    * times would triple the boots for no new information — and the other two
    * grammars report skipped, which says the opt-in is per fixture rather than
    * that coverage is missing.
    *
    * `NoSuchType` produces Langium's unresolved-reference sentence, which the
    * framework claims as `hydranium/core/unresolved-reference` and this example
    * translates — so what is asserted is a sentence NO ONE HERE WROTE arriving
    * in German. The fragments are the invariant halves of each wording, so a
    * `referenceType` change in the grammar does not break a locale check.
    */
   renderedDiagnostic: {
      locale: 'de',
      expected: 'konnte nicht aufgelöst werden',
      absentWithLocale: 'Could not resolve reference to'
   }
   // No `edit`: the LSP slice never reads it. Its didChange check drives
   // `valid → invalid` using `invalid.text`, so there is no adopter-supplied
   // assertion for it to run.
};

/**
 * `.process` — the cross-grammar half, and the reason this file owns a
 * workspace at all: `subject=[Entity:ID]` is mandatory, so `for Order` only
 * resolves against `orders/orders.domain`.
 */
const processFixture: LanguageFixture = {
   valid: {
      uri: uri('orders/lsp-conformance.process'),
      languageId: ProcessLanguageMetaData.languageId,
      text: 'process Handling for Order {\n   task Inspect reads Order.id\n   task Approve writes Order.status = PAID\n   transition Inspect -> Approve\n}\n'
   },
   invalid: {
      uri: uri('orders/lsp-conformance-invalid.process'),
      languageId: ProcessLanguageMetaData.languageId,
      text: 'process Broken for NoSuchEntity {\n   task Inspect\n}\n'
   },
   // Start of a body line, where the grammar offers its statement keywords.
   completionPosition: { line: 1, character: 3 }
};

/**
 * `.layout` — the third grammar, and a DIFFERENT cross-document shape from
 * `.process`'s.
 *
 * `.process` leaves its document to reach another grammar's declaration.
 * `.layout` leaves its document to reach a `FlowNode`, which Langium's default
 * scoping would resolve against every flow node in the workspace, because a
 * document's root and its direct children are both exported. So the reference
 * here is only correct because `OrderFlowLayoutScopeProvider` narrows it to the
 * process this file names — which is why running the battery over this grammar
 * is not a duplicate of running it over `.process`.
 *
 * Targets `returns.process`, deliberately: it is the process with NO committed
 * `.layout` beside it, so the fixture adds a layout rather than competing with
 * `orders/fulfillment.layout`.
 */
const layoutFixture: LanguageFixture = {
   valid: {
      uri: uri('orders/lsp-conformance.layout'),
      languageId: LayoutLanguageMetaData.languageId,
      text: 'layout ReturnsLayout for Returns {\n   node Receive at 40, 40 size 160, 60\n   node Restock at 40, 160\n}\n'
   },
   invalid: {
      uri: uri('orders/lsp-conformance-invalid.layout'),
      languageId: LayoutLanguageMetaData.languageId,
      // Parses clean, fails linking — and fails against the NARROWED scope:
      // `Pay` is a real flow node in the workspace (`fulfillment.process`), just
      // not one of `Returns`'. An unscoped `[FlowNode:ID]` would resolve it
      // happily via the global index, so this is the fixture that goes green if
      // the scope provider is ever removed.
      text: 'layout BrokenLayout for Returns {\n   node Pay at 0, 0\n}\n'
   },
   // The flow-node reference position, where the candidates are the declared
   // process's nodes rather than keywords.
   completionPosition: { line: 1, character: 8 }
};

runLspConformance({
   connect: () => {
      workspace?.dispose();
      workspace = makeScratchWorkspace({ seed: WORKSPACE_ROOT, prefix: 'order-flow-lsp-conformance-' });
      const workspaceUri = workspace.uri();
      const harness = makeLspHarness({
         // NodeFileSystem, not EmptyFileSystem: the fixtures resolve against
         // real files in the scratch workspace.
         createServices: connection => createOrderFlowServices({ connection, ...NodeFileSystem }).shared
      });
      return {
         ...harness,
         // The one line of glue an adopter writes. The workspace folders are
         // the adopter's — the kit cannot know them — while `params` is the
         // kit's, carrying the locale the render check declares.
         //
         // **Spreading `params` is load-bearing.** Dropping it silently
         // discards the locale, and the render check then reads English and
         // fails — loudly, which is the right failure, but the cause is here
         // rather than in the server.
         initialize: params => harness.initialize({ ...params, workspaceFolders: [{ uri: workspaceUri, name: 'order-flow' }] })
      };
   },
   languages: [domainFixture, processFixture, layoutFixture],
   suiteTitle: 'conformance: lsp (order-flow, three grammars)'
});
