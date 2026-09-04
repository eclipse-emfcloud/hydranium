/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * Cross-head COHERENCE for `order-flow` — all three heads on ONE shared tree.
 *
 * Each per-head suite here proves that ONE head reads and writes a real
 * `ModelService` over a real services tree. None of them proves that a mutation
 * through one head CROSSES to another, because every head shares a single
 * `services.shared`. That is what this suite is for.
 *
 * # Why the heads work on DIFFERENT documents in DIFFERENT grammars
 *
 * The data head edits `orders.domain`, and the affected document is
 * `orders/fulfillment.process` — a file that head never touched, in the other
 * grammar, reached only through the shared index and the dependency-tracked
 * rebuild. A per-grammar document store or a per-grammar builder would leave
 * that crossing silent, and a crossing that stays inside one grammar cannot
 * tell the difference.
 *
 * # Topology — services-first, mirroring `main.ts`
 *
 * The LSP connection is born first (Langium binds it into the tree at
 * `createOrderFlowServices({ connection })`), the ONE tree is built around it,
 * then all three head harnesses attach to that same `services.shared`. The
 * `makeLspHarness` "attach" form is what makes the LSP head take the tree the
 * same way the other two do, instead of owning tree creation via its
 * single-head `createServices` callback.
 *
 * # Why a scratch workspace
 *
 * An in-memory `ModelService.update` is not the only write a test provokes: a
 * rebuild runs the integrity rules, whose default silent mode persists repairs
 * with `writeFile` — and the cross-grammar test below deliberately makes a
 * `.process` effect dangle, which is exactly the state a repair rule acts on.
 * Pointing this at `examples/order-flow/workspace` would let a test rewrite the
 * committed sample.
 */

import 'reflect-metadata';
import { CreateNodeOperation, RequestBoundsAction, RequestModelAction, ServerModule, SOURCE_URI_ARG } from '@eclipse-glsp/server';
import { DataServer } from '@hydranium/data-server';
import { type DataServerHarness, makeDataServerHarness } from '@hydranium/data-server/testing';
import { HydraniumGlspAppModule } from '@hydranium/glsp-server';
import { type GlspHarness, makeGlspHarness } from '@hydranium/glsp-server/testing';
import {
   type LspHarness,
   makeLspHarness,
   makeLspServerConnection,
   makeScratchWorkspace,
   type ScratchWorkspace
} from '@hydranium/core/testing/node';
import { NodeFileSystem } from '@hydranium/core/node';
import { tick, waitFor } from '@hydranium/protocol/testing';
import { DocumentState, URI } from '@hydranium/langium';
import { Diagnostic, type PublishDiagnosticsParams } from 'vscode-languageserver-protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { PROCESS_GATEWAY_NODE_TYPE, PROCESS_TASK_NODE_TYPE } from '../src/glsp/order-flow-process-diagram-types.js';
import { type OrderFlowGlspState } from '../src/glsp/order-flow-glsp-state.js';
import { OrderFlowProcessDiagramModule } from '../src/glsp/order-flow-process-diagram-module.js';
import { createOrderFlowServices, type OrderFlowSharedServices } from '../src/language-server/order-flow-module.js';
import type { DomainModel, ProcessModel } from '../src/language-server/generated-transfer/transfer-model.js';
import { WORKSPACE_FILES, WORKSPACE_ROOT } from './order-flow-harness.js';

const DIAGRAM_TYPE = 'order-flow-process';

/** The two transfer roots this suite reads; the server declares a `.layout` root as well. */
type OrderFlowTransfer = DomainModel | ProcessModel;

/** `fulfillment.process` as committed: tasks Pay / Pick / Ship / Cancel plus gateway PaymentOk. */
const PROCESS_NODE_COUNT = 5;

/**
 * `fulfillment.process` plus a sixth flow node that exists ONLY in this
 * in-memory edit and never on disk — so the GLSP head projecting six can only
 * have come from the cross-head edit. The comments are dropped because they are
 * not what is under test; positions live in `fulfillment.layout`, which this
 * edit leaves untouched, and a flow node with no layout entry is a legal state.
 */
const EDITED_PROCESS_TEXT = `process Fulfillment for Order {
   task Pay writes Order.status = PAID
   gateway PaymentOk
      yes -> Pick
      no -> Cancel
   task Pick reads Order.id
   task Ship writes Order.status = SHIPPED
   task Cancel writes Order.status = CANCELLED
   task Archive
   transition Pay -> PaymentOk
   transition Pick -> Ship
}
`;

/**
 * `orders.domain` with one field ADDED. Harmless to `.process`, so the crossing
 * it provokes must publish a CLEAN `.process` — the positive half of the control
 * pair below.
 */
const DOMAIN_TEXT_WITH_EXTRA_FIELD = `project orders requires commerce-core

entity Order {
   id: ID
   status: OrderStatus
   total: Money
   shipTo: Address
   lines: LineItem[]
   note: String
}

enum OrderStatus { NEW, PAID, SHIPPED, CANCELLED }

entity LineItem {
   sku: ID
   quantity: Number
   price: Money
}
`;

/**
 * `orders.domain` with `Order.status` REMOVED. Still valid on its own — the
 * `OrderStatus` enum is merely unused — so every diagnostic this produces lands
 * on the `.process` files whose `writes Order.status = …` effects can no longer
 * resolve. That is the cross-grammar crossing.
 */
const DOMAIN_TEXT_WITHOUT_STATUS = `project orders requires commerce-core

entity Order {
   id: ID
   total: Money
   shipTo: Address
   lines: LineItem[]
}

enum OrderStatus { NEW, PAID, SHIPPED, CANCELLED }

entity LineItem {
   sku: ID
   quantity: Number
   price: Money
}
`;

interface Heads {
   readonly shared: OrderFlowSharedServices;
   readonly lsp: LspHarness;
   readonly data: DataServerHarness<DataServer<OrderFlowTransfer>, OrderFlowTransfer>;
   readonly glsp: GlspHarness<OrderFlowGlspState>;
   /** Absolute filesystem path inside the scratch copy — what `SOURCE_URI_ARG` carries. */
   readonly path: (relativePath: string) => string;
   /** `file://…` form — what the data head and the LSP wire carry. */
   readonly uri: (relativePath: string) => string;
}

let heads: Heads | undefined;
let scratch: ScratchWorkspace | undefined;

/**
 * How long to allow for a cross-grammar cascade. Generous on purpose: the
 * dependent documents' publishes arrive about a second after the write that
 * caused them resolves, so a 2s default would be flaky rather than fast.
 */
const CASCADE_TIMEOUT_MS = 10_000;
/** Test-level budget for the cascade test — two full cascades plus a boot. */
const CASCADE_TEST_TIMEOUT_MS = 30_000;

/** Flow-node children of a submitted graph, both kinds. */
function flowNodeCount(response: RequestBoundsAction): number {
   const children = response.newRoot.children ?? [];
   return children.filter(child => child.type === PROCESS_TASK_NODE_TYPE || child.type === PROCESS_GATEWAY_NODE_TYPE).length;
}

/**
 * Publishes for `uri` that arrived AFTER `from` entries had been captured.
 *
 * Indexing into the append-only capture rather than arming `nextDiagnostics` is
 * deliberate: a cascade produces a publish per affected document in an order the
 * test does not control, so "the next publish for this URI" is the wrong
 * question — "did one arrive for this URI since I acted" is the right one.
 */
function publishedFor(lsp: LspHarness, uri: string, from: number): ReadonlyArray<PublishDiagnosticsParams> {
   return lsp.diagnostics.slice(from).filter(published => published.uri === uri);
}

/** Diagnostics of the most recent publish in a slice — a rebuild may publish twice. */
function latestDiagnostics(published: ReadonlyArray<PublishDiagnosticsParams>): ReadonlyArray<Diagnostic> {
   return published[published.length - 1].diagnostics;
}

/**
 * Boot all three heads over ONE shared tree, on a throwaway copy of the sample
 * workspace. Fresh per test so an in-memory edit never leaks between tests.
 */
async function bootHeads(): Promise<Heads> {
   scratch = makeScratchWorkspace({ seed: WORKSPACE_ROOT, prefix: 'order-flow-coherence-' });
   const workspace = scratch;

   const lspWire = makeLspServerConnection();
   const services = createOrderFlowServices({ connection: lspWire.serverConnection, ...NodeFileSystem });
   const lsp = makeLspHarness({ connection: lspWire, services: services.shared });
   const data = makeDataServerHarness<DataServer<OrderFlowTransfer>, OrderFlowTransfer>({
      server: channel => new DataServer<OrderFlowTransfer>(channel, services.shared)
   });
   const glsp = makeGlspHarness<OrderFlowGlspState>({
      serverModule: new ServerModule().configureDiagramModule(new OrderFlowProcessDiagramModule()),
      diagramType: DIAGRAM_TYPE,
      appModules: [new HydraniumGlspAppModule({ shared: services.shared })]
   });

   // One faithful workspace init through the LSP transport — handshake and
   // workspace folders in a single `initialize`, so there is no second
   // `WorkspaceManager.initialize` to race the first. The harness settles the
   // workspace before returning, which this suite relies on: the cross-grammar
   // assertions need `.process` linked against `.domain` before the first edit.
   await lsp.initialize({ workspaceFolders: [{ uri: URI.file(workspace.root).toString(), name: 'order-flow' }] });
   await services.shared.workspace.WorkspaceManager.ready;
   await glsp.start();

   heads = {
      shared: services.shared,
      lsp,
      data,
      glsp,
      path: relativePath => workspace.resolve(relativePath),
      uri: relativePath => URI.file(workspace.resolve(relativePath)).toString()
   };
   return heads;
}

describe('order-flow cross-head coherence (LSP + data + GLSP on one shared tree)', () => {
   afterEach(async () => {
      if (heads) {
         // Quiesce before tearing the shared LSP wire down: a head's edit can
         // leave a build settling to `Validated` after that head's own wait
         // returned, and that build fires the diagnostics handler — a publish
         // nobody awaited. Draining first is what keeps dispose from surfacing
         // as "Connection is disposed".
         await heads.shared.model.ModelService.waitForBuilderState(DocumentState.Validated);
         await tick();
         heads.glsp.dispose();
         heads.data.dispose();
         heads.lsp.dispose();
         heads = undefined;
      }
      scratch?.dispose();
      scratch = undefined;
   });

   it('crosses a data-head edit of .process to the GLSP head and re-diagnoses on the LSP head', async () => {
      const { lsp, data, glsp, path, uri } = await bootHeads();
      const processUri = uri(WORKSPACE_FILES.fulfillmentProcess);

      // Armed BEFORE the edit: the trigger is another head's write, not this
      // head's own didChange. The LSP head never opens this document — it only
      // observes the shared validation pipeline.
      const reDiagnosed = lsp.nextDiagnostics(processUri);

      const edited = await data.proxy.updateModelDocument({
         uri: processUri,
         clientId: 'coherence-data',
         model: EDITED_PROCESS_TEXT
      });
      expect(edited.diagnostics).toEqual([]);

      // The GLSP head observes it through the SHARED document store: its storage
      // goes through the same `ModelService`, already open from the data head,
      // so it refreshes rather than re-reading disk. Disk has five flow nodes,
      // so projecting six can only come from the in-memory cross-head edit.
      glsp.dispatch(RequestModelAction.create({ options: { [SOURCE_URI_ARG]: path(WORKSPACE_FILES.fulfillmentProcess) } }));
      const submitted = await glsp.nextAction<RequestBoundsAction>(RequestBoundsAction.KIND);
      expect(flowNodeCount(submitted)).toBe(PROCESS_NODE_COUNT + 1);
      expect(glsp.state.sourceRoot.nodes.map(node => node.name)).toContain('Archive');

      // And the LSP head observes it through the SHARED validation pipeline —
      // the same rebuild drove the document to `Validated`, so the diagnostics
      // handler published over the wire. A head with its own DocumentBuilder
      // would never see this.
      expect(await reDiagnosed).toEqual([]);
   });

   it(
      'crosses a data-head .domain edit to .process diagnostics in the other grammar',
      async () => {
         const { lsp, data, uri } = await bootHeads();
         const domainUri = uri(WORKSPACE_FILES.ordersDomain);
         const processUri = uri(WORKSPACE_FILES.fulfillmentProcess);

         // Measured, and load-bearing for how the rest of this test is written:
         // the workspace init links and indexes but does NOT validate, so NOTHING
         // has been published for any document yet — not even for
         // `audit-leak.domain`, the workspace's one deliberate error. A baseline
         // cannot be read off the wire; it has to be provoked, which is what the
         // control half does.
         expect(lsp.diagnostics).toHaveLength(0);

         // Control half — a HARMLESS `.domain` edit, doing double duty: it proves
         // the cross-grammar cascade fires at all, and it establishes that
         // `.process` is clean beforehand. Without it the errors asserted below
         // could have been pre-existing.
         const beforeCleanEdit = lsp.diagnostics.length;
         await data.proxy.updateModelDocument({
            uri: domainUri,
            clientId: 'coherence-data',
            model: DOMAIN_TEXT_WITH_EXTRA_FIELD
         });
         await waitFor(() => publishedFor(lsp, processUri, beforeCleanEdit).length > 0, {
            timeoutMs: CASCADE_TIMEOUT_MS,
            message: 'no .process publish followed a harmless .domain edit — the cross-grammar cascade did not fire'
         });
         expect(latestDiagnostics(publishedFor(lsp, processUri, beforeCleanEdit))).toEqual([]);

         // Breaking half — remove the field the `.process` effect chain depends
         // on. Nothing in this call names `.process`.
         const beforeBreakingEdit = lsp.diagnostics.length;
         const edited = await data.proxy.updateModelDocument({
            uri: domainUri,
            clientId: 'coherence-data',
            model: DOMAIN_TEXT_WITHOUT_STATUS
         });
         expect(edited.uri).toBe(domainUri);
         // The edited document itself stays clean — the enum is merely unused. So
         // everything reported below is a consequence in the OTHER grammar rather
         // than a spill-over from this one.
         expect(edited.diagnostics).toEqual([]);

         // **The cascade is asynchronous.** `updateModelDocument` has already
         // resolved, and the dependent documents' publishes arrive after it —
         // measured at roughly a second later. An adopter treating the write
         // response as "everything affected has been re-diagnosed" would be
         // wrong, and a test awaiting only the response asserts too early.
         await waitFor(() => publishedFor(lsp, processUri, beforeBreakingEdit).length > 0, {
            timeoutMs: CASCADE_TIMEOUT_MS,
            message: 'no .process publish followed the breaking .domain edit'
         });

         // LSP 3.18 widened `Diagnostic.message` to `string | MarkupContent`;
         // `Diagnostic.getMessageString` is the upstream renderer for it, and is
         // what the framework's own diagnostic conversions use.
         const messages = latestDiagnostics(publishedFor(lsp, processUri, beforeBreakingEdit)).map(diagnostic =>
            Diagnostic.getMessageString(diagnostic)
         );
         // Every `writes Order.status = …` effect loses BOTH hops: the field, and
         // the literal that was only in scope because of the field's type. So
         // asserting the exact SET is what shows the whole dependent chain was
         // re-checked rather than just the first reference.
         //
         // The set rather than a count, deliberately: an edit publishes more than
         // once, so the captured array carries each diagnostic several times.
         // Asserting a count would either bake that duplication in or break the
         // moment it changes.
         expect([...new Set(messages)].sort()).toEqual([
            "Could not resolve reference to EnumLiteral named 'CANCELLED'.",
            "Could not resolve reference to EnumLiteral named 'PAID'.",
            "Could not resolve reference to EnumLiteral named 'SHIPPED'.",
            "Could not resolve reference to Field named 'status'."
         ]);
      },
      CASCADE_TEST_TIMEOUT_MS
   );

   it('crosses a GLSP edit to a data-head subscriber on the shared build pipeline', async () => {
      const { data, glsp, path, uri } = await bootHeads();
      const processUri = uri(WORKSPACE_FILES.fulfillmentProcess);

      glsp.dispatch(RequestModelAction.create({ options: { [SOURCE_URI_ARG]: path(WORKSPACE_FILES.fulfillmentProcess) } }));
      await glsp.nextAction(RequestBoundsAction.KIND);
      const before = glsp.state.sourceRoot.nodes.length;
      expect(before).toBe(PROCESS_NODE_COUNT);

      // Subscribe THROUGH the data head — its listener sits on the shared
      // builder's phase events.
      await data.proxy.watchModelDocument({ uri: processUri, clientId: 'coherence-sub' });

      // Edit THROUGH the GLSP head: a real operation, recording command,
      // `ModelService.update`, rebuild on the shared builder.
      glsp.dispatch(CreateNodeOperation.create(PROCESS_TASK_NODE_TYPE));
      await glsp.nextAction(RequestBoundsAction.KIND);
      await waitFor(() => data.events.length >= 1);

      const lastEvent = data.events[data.events.length - 1];
      expect(lastEvent.document.uri).toBe(processUri);
      expect(glsp.state.sourceRoot.nodes).toHaveLength(before + 1);
   });
});
