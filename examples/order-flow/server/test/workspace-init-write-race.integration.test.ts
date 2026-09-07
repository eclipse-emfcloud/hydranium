/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * A write that lands DURING workspace initialization, made deterministic.
 *
 * The same scenario `smoke/cross-head-socket.integration.test.ts` reaches only
 * under whole-repo CPU starvation, and then about half the time. Nothing else
 * here cancels an initial workspace build, so without this suite the hazard has
 * no deterministic cover at all — and its failure signature (documents that are
 * silently never validated) reads like an architectural regression rather than
 * a race.
 *
 * **The hazard, and why both halves are asserted.** `WorkspaceLock.write` cancels
 * the in-flight write action, and the initial workspace build IS one — so any
 * write arriving during startup cancels it. Two separate things then go wrong:
 *
 * - Langium's `prepareBuild` deliberately RETAINS an incomplete build's options,
 *   and the initial build runs with `initialBuildOptions` (`{}` — validation
 *   OFF). The write's own build inherits `validation: false` for every document
 *   the cancelled build had not finished, `shouldValidate` returns false, and
 *   `buildDocuments` marks them COMPLETED having never validated them. Their
 *   diagnostics are never computed, never published, and nothing says so.
 * - `ModelService.ready` gates on `WorkspaceManager.workspaceInitialized`, which
 *   REJECTS when the initial build is cancelled. Propagating that would fail
 *   every later `waitForReady` for the process lifetime.
 *
 * **Why this is deterministic.** A phase listener holds the initial build open
 * at the phase the write arrives in, so the interleaving is constructed rather
 * than raced: the write is issued while init is provably suspended mid-build,
 * and `WorkspaceLock.write` cancels synchronously on that call. No sleeps and no
 * load dependence.
 *
 * **Controls, including one that does NOT redden — and what that does NOT mean.**
 * Disabling `HydraniumDocumentBuilder.shouldRelink` reddens the diagnostics
 * assertion; making `ModelService.ready` propagate its rejection reddens the
 * readiness assertion. Disabling `prepareBuild`'s retained-options upgrade
 * reddens NEITHER phase, with the control confirmed present in the built `lib/`.
 *
 * That is a limit of THIS harness, not evidence the retained-options upgrade is
 * unnecessary, and the distinction is worth stating because the obvious reading
 * would delete working code. The in-process write path opens the document first,
 * and that open's own build runs to completion — which marks the documents
 * completed and so lets Langium's `prepareBuild` overwrite the stale options
 * rather than retain them. A spawned multi-head server does not always get that
 * far: a failing run there shows 8 documents reaching `IndexedReferences` and
 * only 2 reaching `Validated`, and the sole thing that drops a document between
 * those phases is `shouldValidate` reading retained options. So the
 * retained-options path is unreachable from HERE while remaining real; covering
 * it needs a harness that suspends the build without an intervening completed
 * build.
 */

import { initializeWorkspaceProgrammatically } from '@hydranium/core';
import { type ScratchWorkspace, makeScratchWorkspace } from '@hydranium/core/testing/node';
import { Deferred, DocumentState, URI } from '@hydranium/langium';
import * as path from 'node:path';
import { Diagnostic } from 'vscode-languageserver-protocol';
import { describe, expect, it } from 'vitest';
import { WORKSPACE_FILES, WORKSPACE_ROOT, makeServices } from './order-flow-harness.js';

/**
 * `orders.domain` with `Order.status` REMOVED, matching the edit the cross-head
 * socket suite makes. Still valid on its own — the `OrderStatus` enum is merely
 * unused — so every diagnostic it provokes lands on the `.process` documents in
 * the OTHER grammar. That is what makes this a cross-grammar cascade rather than
 * a local rebuild.
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

/** The linking error the dependent `.process` document must end up carrying. */
const EXPECTED_DEPENDENT_ERROR = "Could not resolve reference to Field named 'status'.";

/**
 * Poll until `predicate` holds, or give up.
 *
 * Bounded on purpose: the failure this guards is a document that is never
 * validated AT ALL, so an unbounded wait would hang the run instead of failing
 * it — and a control that hangs reads as a broken test rather than as the
 * regression it is meant to prove.
 */
async function waitUntil(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
   const deadline = Date.now() + timeoutMs;
   while (!predicate() && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 10));
   }
}

/**
 * The two phases an interrupted initial build can leave a dependent at. They
 * leave it in genuinely different states, so both are run.
 *
 * - Cancelled at `Linked`: the reference index was never populated, so
 *   `IndexManager.isAffected` cannot see the dependent and Langium never resets
 *   it for relinking. Repaired by `HydraniumDocumentBuilder.shouldRelink`, and
 *   this phase reddens when that override is disabled.
 * - Cancelled at `IndexedReferences`: the index IS populated, so the dependent
 *   is relinked. The retained-options hazard — `validation: false` carried into
 *   the next build, leaving the document completed but never validated — belongs
 *   to this phase, yet from this harness Langium's own `prepareBuild` already
 *   clears it, because the in-process write opens the document first and that
 *   open's build completes. So disabling
 *   `HydraniumDocumentBuilder.prepareBuild`'s upgrade reddens neither phase
 *   here; what this phase pins is that a dependent cancelled past the index
 *   still ends up validated.
 */
const BARRIER_PHASES = [
   { name: 'Linked (reference index never populated)', phase: DocumentState.Linked },
   { name: 'IndexedReferences (non-validating options retained)', phase: DocumentState.IndexedReferences }
] as const;

describe.each(BARRIER_PHASES)('a write that lands during workspace initialization, cancelled at $name', ({ phase }) => {
   it('still validates cross-grammar dependents, and leaves the readiness gate resolvable', async () => {
      const workspace: ScratchWorkspace = makeScratchWorkspace({ seed: WORKSPACE_ROOT, prefix: 'order-flow-init-race-' });
      try {
         const harness = makeServices();
         const documents = harness.shared.workspace.LangiumDocuments;
         const modelService = harness.shared.model.ModelService;

         // The barrier. `notifyBuildPhase` awaits its listeners, so returning a
         // pending promise genuinely suspends the initial build here. Armed once:
         // the write's OWN build reaches `Linked` too, and blocking that one would
         // deadlock the test rather than measure it.
         const reachedBarrier = new Deferred<void>();
         const releaseInit = new Deferred<void>();
         let barrierArmed = true;
         harness.shared.workspace.DocumentBuilder.onBuildPhase(phase, async () => {
            if (!barrierArmed) {
               return;
            }
            barrierArmed = false;
            reachedBarrier.resolve();
            await releaseInit.promise;
         });

         // NOT awaited — the whole point. A cancelled init rejects, and the
         // rejection is attached here rather than later so it is never unhandled.
         const initialization = initializeWorkspaceProgrammatically(harness.shared, workspace.root).catch(() => undefined);
         await reachedBarrier.promise;
         // Init is now provably suspended mid-build, holding the write lock.

         const domainUri = URI.file(path.join(workspace.root, WORKSPACE_FILES.ordersDomain)).toString();
         const processUri = URI.file(path.join(workspace.root, WORKSPACE_FILES.fulfillmentProcess)).toString();

         // Issuing the write cancels the suspended initial build synchronously,
         // inside this call. Deliberately not awaited before the release below:
         // the write queues on the very lock the init still holds.
         const write = modelService.update({ uri: domainUri, clientId: 'init-race', model: DOMAIN_TEXT_WITHOUT_STATUS });
         releaseInit.resolve();

         await initialization;
         await write;

         // (a) The gate still resolves. `workspaceInitialized` rejected here — the
         // init build was cancelled — and a gate that propagated it would fail
         // every waitForReady from now on.
         await expect(modelService.ready).resolves.toBeUndefined();

         // (b) The dependent in the OTHER grammar really was validated. An
         // interrupted init leaves it either never relinked or completed without
         // being validated, and both end the same way: its diagnostics stay
         // empty forever rather than arriving late.
         await waitUntil(() => (documents.getDocument(URI.parse(processUri))?.diagnostics?.length ?? 0) > 0);
         const dependent = documents.getDocument(URI.parse(processUri));
         expect(dependent?.state).toBe(DocumentState.Validated);
         expect((dependent?.diagnostics ?? []).map(diagnostic => Diagnostic.getMessageString(diagnostic))).toContain(
            EXPECTED_DEPENDENT_ERROR
         );
      } finally {
         workspace.dispose();
      }
   }, 60_000);
});
