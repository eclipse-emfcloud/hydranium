/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * Shared test harness: boots all three languages over `NodeFileSystem` and
 * brings the sample workspace up through the **editor-equivalent** entry
 * (`initializeWorkspaceProgrammatically`, i.e. the LSP `initialize` /
 * `initialized` pair) rather than the eager
 * `buildWorkspaceProgrammatically` convenience.
 *
 * That choice is deliberate and load-bearing. This example's project
 * descriptors are a strict subset of its model files, which is the topology
 * under which the init build has to cover the descriptors for anything to
 * resolve; going through the eager helper instead would build everything a
 * second time and hide a regression in that path.
 */

import { initializeWorkspaceProgrammatically } from '@hydranium/core';
import { type ScratchWorkspace, makeScratchWorkspace } from '@hydranium/core/testing/node';
import { NodeFileSystem } from '@hydranium/core/node';
import type { AstNode, LangiumDocument } from '@hydranium/langium';
import { URI } from '@hydranium/langium';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { onTestFinished } from 'vitest';
import {
   createOrderFlowServices,
   type OrderFlowOptions,
   type OrderFlowServices,
   type OrderFlowSharedServices
} from '../src/language-server/order-flow-module.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** The two-project sample workspace all three grammars are exercised against. */
export const WORKSPACE_ROOT = path.resolve(HERE, '../../workspace');

/**
 * Every model file in the sample workspace, by role.
 *
 * Tests should reach for these rather than spelling a relative path, because a
 * mistyped path does not fail as a mistyped path: it surfaces as `ENOENT`
 * wrapped in whatever layer was asked to load it — an RPC rejection from the
 * data head, a throw from `documentFor`, a timeout from a GLSP harness. Naming
 * the files here turns that into a compile error, and doubles as the workspace's
 * inventory for anyone writing their first suite against it.
 *
 * Kept flat and explicit rather than globbed: the point is that adding a file to
 * the workspace is a deliberate edit here too, since several tests assert counts
 * over it (`validate` reports "1 error in 8 files"; the stdlib virtual document
 * is one of the 8, being a `LangiumDocument` — the framework validator skips it,
 * and it is grammar-clean anyway, so it contributes no error either way).
 */
export const WORKSPACE_FILES = {
   /** `orders` — the descriptor: carries the `project` header plus `requires commerce-core`. */
   ordersDomain: 'orders/orders.domain',
   /** `orders` — the deliberate visibility negative, and the ONLY intended error in the workspace. */
   auditLeak: 'orders/audit-leak.domain',
   /** `orders` — the GLSP-primary process, and the one carrying the full three-part effect. */
   fulfillmentProcess: 'orders/fulfillment.process',
   /** `orders` — a second process over the same entity, so `.domain` is shared rather than owned. */
   returnsProcess: 'orders/returns.process',
   /**
    * `orders` — layout for `fulfillment.process`, in the third grammar.
    *
    * Deliberately present for ONE of the two processes: `returns.process` has no
    * layout file, which is the state of every hand-authored process before it is
    * opened in a diagram, and the case where a first drag has to CREATE the file.
    */
   fulfillmentDiagram: 'orders/fulfillment.layout',
   /** `commerce-core` — the descriptor, and the only file with `public` declarations. */
   commerceCoreMoney: 'commerce-core/money.domain',
   /** `commerce-core` — an ordinary member, no `project` header and nothing `public`. */
   commerceCoreInternal: 'commerce-core/internal.domain'
} as const;

/** Test-only fixtures that must stay OUT of the sample workspace. */
export const FIXTURE_ROOT = path.resolve(HERE, 'fixtures');

export interface OrderFlowHarness {
   readonly shared: OrderFlowSharedServices;
   readonly domain: OrderFlowServices;
   readonly process: OrderFlowServices;
   /** The `*.layout` layout language. */
   readonly layout: OrderFlowServices;
}

/**
 * Boot all three languages with no workspace initialized, so nothing is read
 * from disk.
 *
 * `options` reaches the composition verbatim, which is how a suite boots a
 * framework service on non-default options (`extraSharedModules` /
 * `extraLanguageModules`) or binds a slot production leaves unbound, such as
 * `lsp.Connection`.
 */
export function makeServices(options: OrderFlowOptions = {}): OrderFlowHarness {
   const { shared, Domain, Process, Layout } = createOrderFlowServices({ ...NodeFileSystem }, options);
   return { shared, domain: Domain, process: Process, layout: Layout };
}

/**
 * Boot all three languages and initialize the workspace rooted at
 * `workspaceRoot`.
 *
 * Internal on purpose: a suite over the committed sample workspace goes through
 * {@link makeWorkspaceHarness}, and one that needs a root of its own goes
 * through {@link makeScratchWorkspaceHarness}, which owns the throwaway copy
 * and hands back the disposal obligation with it. Exposing the raw root would
 * let a suite initialize over the committed workspace and write to it.
 */
async function makeHarnessOver(workspaceRoot: string, options: OrderFlowOptions = {}): Promise<OrderFlowHarness> {
   const harness = makeServices(options);
   await initializeWorkspaceProgrammatically(harness.shared, workspaceRoot);
   return harness;
}

/** Boot all three languages and initialize the sample workspace. */
export async function makeWorkspaceHarness(): Promise<OrderFlowHarness> {
   return makeHarnessOver(WORKSPACE_ROOT);
}

/**
 * A booted harness together with the throwaway directory it runs over. Named
 * rather than inline because the two have a **coupled lifetime**: the caller
 * owns `workspace.dispose()`, and a test that destructures only `harness` leaks
 * a temp directory per run. Holding it as one value is what makes that
 * obligation visible.
 */
export interface ScratchOrderFlowHarness {
   readonly harness: OrderFlowHarness;
   /** The scratch root the harness was initialized over; the caller disposes it. */
   readonly workspace: ScratchWorkspace;
}

/**
 * Boot all three languages over a **throwaway copy** of the sample workspace.
 *
 * Any test that drives a write path wants this rather than
 * {@link makeWorkspaceHarness} — the framework helper's own docs carry the
 * reason (a rebuild runs the integrity rules, whose default silent mode
 * persists repairs to disk, so a write test aimed at the committed workspace
 * rewrites it). This wrapper exists only to bind the seed and boot the
 * languages over the result; the caller must `dispose()` the workspace.
 *
 * `prepare` runs against the copy BEFORE the workspace is initialized, which is
 * the only point at which a test can author content the initial build then sees.
 * Editing a file after the boot is a different scenario — a rebuild, with its
 * own cascade and its own event stream — so a suite whose subject is the
 * *initial* state of a modified workspace must go through here rather than
 * write-then-rebuild.
 */
export async function makeScratchWorkspaceHarness(
   prepare?: (workspace: ScratchWorkspace) => void,
   options: OrderFlowOptions = {}
): Promise<ScratchOrderFlowHarness> {
   const workspace = makeScratchWorkspace({ seed: WORKSPACE_ROOT, prefix: 'order-flow-workspace-' });
   prepare?.(workspace);
   return { harness: await makeHarnessOver(workspace.root, options), workspace };
}

/** URI of a workspace file, given its path relative to the workspace root. */
export function workspaceUri(relativePath: string): URI {
   return URI.file(path.join(WORKSPACE_ROOT, relativePath));
}

/** A loaded workspace document, or a throw naming the file that is missing. */
export function documentFor<TRoot extends AstNode>(harness: OrderFlowHarness, relativePath: string): LangiumDocument<TRoot> {
   const document = harness.shared.workspace.LangiumDocuments.getDocument(workspaceUri(relativePath));
   if (!document) {
      throw new Error(`Document not loaded: ${relativePath}`);
   }
   return document as LangiumDocument<TRoot>;
}

/**
 * Load and build a fixture from `test/fixtures/`, via a **temp-directory copy**.
 *
 * Two reasons for the copy:
 *
 * - The integrity service's default `silent` sync mode persists its repairs
 *   with `FileSystemProvider.writeFile`, so building a fixture in place
 *   rewrites it. The first run would consume the fixture and every run after
 *   that would assert against already-repaired input — a test that passes
 *   while testing nothing.
 * - The write-back goes through the serializer, so the fixture would also lose
 *   its explanatory comments.
 *
 * Fixtures live outside the workspace root on purpose too: they are broken by
 * design and must not reach the sample workspace, whose only intended error is
 * `orders/audit-leak.domain`.
 */
export async function loadFixture<TRoot extends AstNode>(harness: OrderFlowHarness, fileName: string): Promise<LangiumDocument<TRoot>> {
   const scratch = mkdtempSync(path.join(tmpdir(), 'order-flow-fixture-'));
   // This helper returns a document and never the directory, so the caller
   // CANNOT dispose it — unlike `makeScratchWorkspaceHarness`, whose handle
   // makes that obligation visible. Ownership therefore has to live here.
   // Registered against the running test rather than in an `afterAll` so the
   // helper stays callable from anywhere inside a test.
   //
   // KEPT ON FAILURE, which is the whole point of the copy: the integrity
   // service's silent mode rewrites the fixture in place, so after a failing
   // build this directory holds what the repair actually produced. Deleting it
   // unconditionally would trade a disk leak for a harder diagnosis. The path
   // goes to stderr because vitest drops `console` output written from a
   // continuation that runs after the test body.
   onTestFinished(context => {
      if (context.task.result?.state === 'fail') {
         process.stderr.write(`[order-flow] kept the repaired fixture copy at ${scratch}\n`);
         return;
      }
      rmSync(scratch, { recursive: true, force: true });
   });
   const copy = path.join(scratch, fileName);
   copyFileSync(path.join(FIXTURE_ROOT, fileName), copy);
   const document = await harness.shared.workspace.LangiumDocuments.getOrCreateDocument(URI.file(copy));
   await harness.shared.workspace.DocumentBuilder.build([document], { validation: true });
   return document as LangiumDocument<TRoot>;
}
