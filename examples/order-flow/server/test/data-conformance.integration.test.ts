/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * Dogfood of the `@hydranium/conformance/data` slice against the real
 * `order-flow` data head — how an adopter proves their own server speaks the
 * data protocol.
 *
 * What this run adds that a single-grammar one cannot: **three entries in
 * `languages`**. The kit's grammar-bearing checks are parameterized per
 * language, so passing all three fixtures runs the whole battery once per
 * grammar over ONE `DataServer`, and every request has to reach the right
 * language's serializer and encoder by URI alone. With one language in the
 * array, a router that always answers with its only grammar passes.
 *
 * Typed with the **transfer** roots, matching `main.ts`. That is not
 * cosmetic: `Reference<T>` is `string` on the wire and a Langium reference
 * object in the AST, and both satisfy `TransferElement` structurally, so the
 * AST roots compile here too and would quietly promise `edit.expect` a
 * resolvable object where it receives a bare name.
 *
 * # Why this suite owns a scratch workspace
 *
 * `.process` cannot have a self-contained fixture: `subject=[Entity:ID]` is
 * **mandatory** in the grammar, so a valid `.process` model is only valid
 * relative to a `.domain` file declaring the entity. The kit seeds documents
 * through the proxy (`updateModelDocument` upserts a cold URI), but it seeds
 * only the fixture under test — so the entity has to come from a booted
 * workspace, and the fixture URIs have to sit inside it for project-tier
 * visibility to reach it.
 *
 * The fixture URIs are therefore **deferred thunks**: `connect` boots a fresh
 * throwaway workspace per check and the thunks read the one it just made. A plain
 * string in `ConformanceModel.uri` would have to be known at module load, before
 * any driver exists, which forces the whole battery to share ONE directory.
 * Scratch rather than the committed workspace for the usual reason: a rebuild
 * runs the integrity rules, whose default silent mode persists repairs to disk.
 *
 * # How to tell these fixtures are not vacuously passing
 *
 * A conformance fixture is unusually easy to get vacuously green, because the
 * adopter supplies the input and the kit supplies the assertion — so nothing in
 * the suite's own text says the input reached the assertion. The way to check is
 * to break one fixture and confirm WHICH check reddens:
 *
 * - Point `valid.process` at a missing entity and exactly
 *   `getModelDocument(valid) … [order-flow-process]` fails, nothing else. That is
 *   what makes the `diagnostics === []` assertion real (the get now asks for
 *   `includeDiagnostics`, so an empty array means validation ran and found
 *   nothing, rather than that nothing was collected) — and, more importantly,
 *   it shows the cold in-memory fixture
 *   really does resolve `Order` across the grammar boundary, which is what proves
 *   the URI placement earns project-tier visibility.
 * - Make an `invalid` fixture resolve cleanly and exactly its own
 *   `getModelDocument(invalid) …` check fails — there is one such check per
 *   language, so a leak across languages would show as a second red.
 * - Point the `.layout` fixture's `edit.expect` at a flow-node name the edit does
 *   not introduce and exactly `updateModelDocument … [order-flow-layout]` fails.
 */

import type { LanguageFixture } from '@hydranium/conformance';
import { runDataConformance } from '@hydranium/conformance/vitest';
import type { ScratchWorkspace } from '@hydranium/core/testing/node';
import { REFERENCE_SERVER_PROTOCOL_METHODS, type ReferenceServerProtocol } from '@hydranium/protocol/data';
import { DataServer } from '@hydranium/data-server';
import { makeDataServerHarness } from '@hydranium/data-server/testing';
import { afterAll } from 'vitest';
import { DomainLanguageMetaData, LayoutLanguageMetaData, ProcessLanguageMetaData } from '../src/language-server/generated/module.js';
import type { DomainModel, LayoutModel, ProcessModel } from '../src/language-server/generated-hydranium/transfer-model.js';
import { makeScratchWorkspaceHarness } from './order-flow-harness.js';

/** The wire root type: one server, three grammars, so the root is a union. */
type OrderFlowTransfer = DomainModel | LayoutModel | ProcessModel;

// Taken from the generated metadata rather than spelled out, so renaming a
// grammar breaks this at compile time. The ids are `order-flow-<grammar>`, not
// the bare grammar names — and the data slice uses `languageId` only for the
// check title, so a wrong value here would be invisible on this head and would
// surface only once the LSP slice sends it over `didOpen`.
const DOMAIN_LANGUAGE_ID = DomainLanguageMetaData.languageId;
const LAYOUT_LANGUAGE_ID = LayoutLanguageMetaData.languageId;
const PROCESS_LANGUAGE_ID = ProcessLanguageMetaData.languageId;

/**
 * The throwaway workspace the CURRENT check runs over. Rotated in `connect` and
 * read by the fixture thunks below, so every check gets pristine input and at
 * most one temp directory is alive.
 */
let workspace: ScratchWorkspace | undefined;

afterAll(() => {
   workspace?.dispose();
   workspace = undefined;
});

/**
 * Fixtures live inside `orders/`, the project whose descriptor carries
 * `requires commerce-core`. That placement is what lets them reference `Order`
 * (project tier, same folder), `ID` (public tier, across the project
 * boundary) and `String` (universal tier, the stdlib virtual document) — three
 * different visibility tiers resolved from one cold in-memory document.
 */
const uri =
   (relativePath: string): (() => string) =>
   () => {
      if (!workspace) {
         throw new Error(`fixture URI for ${relativePath} read before connect booted a workspace`);
      }
      return workspace.uri(relativePath);
   };

/**
 * `.domain` — self-contained apart from its field types. Declaration names
 * avoid the ones `orders.domain` already exports, so the fixture adds to the
 * project rather than colliding with it.
 */
const domainFixture: LanguageFixture = {
   valid: {
      uri: uri('orders/conformance.domain'),
      languageId: DOMAIN_LANGUAGE_ID,
      text: 'entity Shipment {\n   tracking: ID\n   carrier: String\n}\n'
   },
   invalid: {
      uri: uri('orders/conformance-invalid.domain'),
      // Parses clean, fails linking: the false-green guard the kit asks for.
      text: 'entity Crate {\n   packing: NoSuchType\n}\n',
      languageId: DOMAIN_LANGUAGE_ID
   },
   edit: {
      to: 'entity Shipment {\n   tracking: ID\n   carrier: String\n}\n\nentity Pallet {\n   code: ID\n}\n',
      expect: root => (root as DomainModel).declarations?.some(declaration => declaration.name === 'Pallet') ?? false
   },
   /**
    * The cascade half, and it is CROSS-GRAMMAR on purpose: a `.process` whose
    * subject resolves into this `.domain`, so editing the domain relinks the
    * process without its own file being touched. A single-grammar fixture
    * could express the same relation, but this is the shape an adopter with
    * more than one language actually has.
    */
   dependent: {
      uri: uri('orders/conformance-dependent.process'),
      languageId: PROCESS_LANGUAGE_ID,
      text: 'process Packing for Shipment {\n   task Label reads Shipment.tracking\n}\n'
   }
};

/**
 * `.process` — the cross-grammar half. Every reference here leaves the
 * document: `Order` and the two-hop `Order.status = SHIPPED` effect resolve
 * into `orders.domain` through the shared index.
 */
const processFixture: LanguageFixture = {
   valid: {
      uri: uri('orders/conformance.process'),
      languageId: PROCESS_LANGUAGE_ID,
      text: 'process Shipping for Order {\n   task Dispatch reads Order.id\n   task Confirm writes Order.status = SHIPPED\n   transition Dispatch -> Confirm\n}\n'
   },
   invalid: {
      uri: uri('orders/conformance-invalid.process'),
      // The mandatory subject left dangling — invalid for the reason only a
      // multi-grammar workspace can be: the entity is another grammar's.
      text: 'process Broken for NoSuchEntity {\n   task Dispatch\n}\n',
      languageId: PROCESS_LANGUAGE_ID
   },
   edit: {
      to: 'process Shipping for Order {\n   task Dispatch reads Order.id\n   task Confirm writes Order.status = SHIPPED\n   task Archive\n   transition Dispatch -> Confirm\n}\n',
      expect: root => (root as ProcessModel).nodes?.some(node => node.name === 'Archive') ?? false
   },
   /**
    * The create-element query, and `.process` is the grammar that has one:
    * `ProcessModel` opens `process <name> for <subject=[Entity]>`, so a New
    * Process dialog cannot offer anything until it knows which entities are in
    * scope — and it has to ask before the file exists.
    *
    * `folderUri` is left to the kit's default, which derives the folder holding
    * `valid.uri`: `orders/`, whose project requires `commerce-core`. `Order` is
    * a project-tier entity there, so a head that resolves the folder's project
    * offers it and one that cannot answers nothing.
    */
   referenceQuery: { type: 'ProcessModel', property: 'subject', expectCandidate: 'Order' }
};

/**
 * `.layout` — the third grammar, and the one whose wire shape is least like
 * the other two: its entire content is a list of REFERENCES plus geometry, so
 * every field the encoder emits for it is either a number or a `Reference<T>`
 * rendered as a bare name. `.domain` and `.process` both carry owned structure
 * alongside their references and would not catch an encoder that mishandled the
 * reference-only case.
 *
 * Targets `returns.process`, which has no committed `.layout` beside it, so
 * the fixture adds a layout rather than competing with `fulfillment.layout`.
 */
const layoutFixture: LanguageFixture = {
   valid: {
      uri: uri('orders/conformance.layout'),
      languageId: LAYOUT_LANGUAGE_ID,
      text: 'layout ReturnsLayout for Returns {\n   node Receive at 40, 40 size 160, 60\n}\n'
   },
   invalid: {
      uri: uri('orders/conformance-invalid.layout'),
      // Parses clean, fails linking against the NARROWED scope: `Pay` is a real
      // flow node in `fulfillment.process`, just not one of `Returns`'. An
      // unscoped `[FlowNode:ID]` resolves it via the global index, so this goes
      // green if `OrderFlowLayoutScopeProvider` is ever removed.
      text: 'layout BrokenLayout for Returns {\n   node Pay at 0, 0\n}\n',
      languageId: LAYOUT_LANGUAGE_ID
   },
   edit: {
      to: 'layout ReturnsLayout for Returns {\n   node Receive at 40, 40 size 160, 60\n   node Restock at 40, 160\n}\n',
      // `flowNode` is a `Reference<FlowNode>`, which is a bare NAME on the wire
      // and a Langium reference object in the AST — asserting on the string is
      // what pins that the transfer roots, not the AST ones, reached the client.
      expect: root => (root as LayoutModel).nodes?.some(node => node.flowNode === 'Restock') ?? false
   }
};

runDataConformance<OrderFlowTransfer>({
   connect: async () => {
      workspace?.dispose();
      const { harness: services, workspace: fresh } = await makeScratchWorkspaceHarness();
      workspace = fresh;
      const harness = makeDataServerHarness<DataServer<OrderFlowTransfer>, OrderFlowTransfer>({
         // `additionalMethods` is how the OPT-IN reference fragment reaches the
         // wire: it is deliberately not in `DATA_SERVER_PROTOCOL_METHODS`, so a
         // head that wants a create-element dialog registers it alongside. The
         // example does it here rather than in `main.ts` because this is the
         // suite that proves the surface answers.
         server: channel =>
            new DataServer<OrderFlowTransfer>(channel, services.shared, { additionalMethods: REFERENCE_SERVER_PROTOCOL_METHODS })
      });
      return {
         ...harness,
         // The proxy forwards any called name over the connection, so the
         // reference methods are reachable through it once the server registers
         // them — the cast states that, and keeps the kit exercising the WIRE
         // rather than calling the server object in-process.
         references: harness.proxy as unknown as ReferenceServerProtocol<OrderFlowTransfer>
      };
   },
   languages: [domainFixture, processFixture, layoutFixture],
   // `OrderFlowProjectManager` turns every `.domain` project header in the
   // workspace into a `Project`, so this head genuinely has a project tier and
   // the claim is true. Without it the kit cannot tell an empty project list
   // apart from an unimplemented `getProjects` and reports skipped.
   expectsProjects: true,
   suiteTitle: 'conformance: data-server (order-flow, three grammars)'
});
