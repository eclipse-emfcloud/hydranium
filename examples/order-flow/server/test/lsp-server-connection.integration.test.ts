/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * `makeLspServerConnection` — the transport primitive, driven with a
 * **caller-composed** services tree.
 *
 * Where `makeLspHarness` owns services creation (its `createServices` callback
 * receives a connection the harness built), the primitive inverts that: the
 * CALLER owns the tree and composes the LSP head onto the primitive's
 * `serverConnection`, exactly as `main.ts` does — `createOrderFlowServices({
 * connection })` then `startLanguageServer(shared)`. That inversion is the
 * prerequisite for wiring several heads onto ONE shared tree, which is this
 * example's whole shape.
 *
 * # Why three grammars on one transport
 *
 * The caller-composed tree carries all three languages, so the last case opens
 * a `.domain` and a `.process` document on the SAME transport and resolves a
 * reference from one into the other. A single-grammar version of this suite
 * cannot distinguish a tree that routes by URI from one that answers with the
 * only language it has.
 *
 * # No workspace, deliberately
 *
 * `initialize()` is called with no workspace folders and the fixtures are
 * self-contained — a `valuetype` declared beside the entity that uses it, and a
 * process whose subject is declared in the `.domain` opened moments earlier. So
 * what is under test is the transport and the composition, with document
 * discovery and project tiers deliberately out of the picture. A `.domain` with
 * no `project` header exports at the `universal` tier, which is what lets the
 * `.process` see it without a project relationship.
 */

import { makeLspServerConnection, type LspServerConnection } from '@hydranium/core/testing/node';
// The framework's entry point, as `main.ts` uses — so what this suite starts is
// the composition an adopter ships, `assertLspHeadComposed` included.
import { startLanguageServer } from '@hydranium/core/lsp';
import { afterEach, describe, expect, it } from 'vitest';
import { createOrderFlowServices } from '../src/language-server/order-flow-module.js';

const DOMAIN_LANGUAGE_ID = 'order-flow-domain';
const PROCESS_LANGUAGE_ID = 'order-flow-process';

let transport: LspServerConnection | undefined;

afterEach(() => {
   transport?.dispose();
   transport = undefined;
});

/**
 * Stand a server up the way `main.ts` does: the connection is an INPUT to
 * service creation, and every head attaches to the resulting `shared`.
 */
async function composeServer(): Promise<LspServerConnection> {
   const composed = makeLspServerConnection();
   transport = composed;
   const services = createOrderFlowServices({ connection: composed.serverConnection });
   startLanguageServer(services.shared);
   await composed.initialize();
   return composed;
}

describe('makeLspServerConnection — caller-composed services tree', () => {
   it('drives a real LSP server the caller composed onto serverConnection', async () => {
      const composed = await composeServer();

      const uri = 'file:///composed.domain';
      const diagnostics = composed.nextDiagnostics(uri);
      composed.openDocument(uri, 'valuetype Code {\n}\nentity Crate {\n   tracking: Code\n}\n', DOMAIN_LANGUAGE_ID);

      expect(await diagnostics).toEqual([]);
   });

   it('publishes a diagnostic for an unresolved reference on the caller-composed server', async () => {
      const composed = await composeServer();

      const uri = 'file:///composed-unresolved.domain';
      const diagnostics = composed.nextDiagnostics(uri);
      composed.openDocument(uri, 'entity Order {\n   ref: Missing\n}\n', DOMAIN_LANGUAGE_ID);

      expect((await diagnostics).length).toBeGreaterThan(0);
   });

   it('resolves across two grammars opened on the one composed connection', async () => {
      const composed = await composeServer();

      // The `.domain` first: it declares the entity the process names as its
      // subject, and opening it is what puts it in the shared index.
      const domainUri = 'file:///composed-two.domain';
      const domainDiagnostics = composed.nextDiagnostics(domainUri);
      composed.openDocument(domainUri, 'entity Crate {\n}\n', DOMAIN_LANGUAGE_ID);
      expect(await domainDiagnostics).toEqual([]);

      // The `.process` second, resolving `Crate` out of the document above —
      // a cross-grammar reference over a caller-composed tree with no workspace.
      const processUri = 'file:///composed-two.process';
      const processDiagnostics = composed.nextDiagnostics(processUri);
      composed.openDocument(processUri, 'process Handling for Crate {\n   task Inspect\n}\n', PROCESS_LANGUAGE_ID);

      expect(await processDiagnostics).toEqual([]);
   });
});
