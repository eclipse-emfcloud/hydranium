/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * The two headless workspace-init seams over the SAME root — the configuration
 * in which they are observably different, and the two cases differ in exactly
 * one assertion.
 *
 * `initializeWorkspaceProgrammatically` is the editor-equivalent entry: it
 * reproduces the LSP `initialize` / `initialized` pair, so it discovers, links
 * and indexes and stops there — Langium's `initialBuildOptions` is `{}`, with no
 * `validation`. `buildWorkspaceProgrammatically` calls it and then adds a
 * `{ validation: true }` build over every registered document. That difference
 * is the whole reason both exist, and it is easy to depend on by accident:
 * waiting on `Validated` after an `initialize` hangs forever.
 *
 * A workspace whose every model file is also a project descriptor cannot show
 * the difference — discovery pre-registers all of them, Langium's traversal
 * filter drops them, and the eager helper is a near no-op. Here the descriptors
 * are a strict subset of the model files, so both helpers really run and their
 * outcomes differ.
 *
 * Bypasses `makeWorkspaceHarness` on purpose: that harness hard-wires
 * `initializeWorkspaceProgrammatically`, which is the seam under test. What the
 * seam discovers is asserted by `project-visibility.test.ts`, and the
 * headless-data-head payoff by `data-server.integration.test.ts` plus
 * `smoke/data-server-socket.test.ts`, so neither is re-asserted here.
 */

import { IntegrityService, buildWorkspaceProgrammatically, initializeWorkspaceProgrammatically } from '@hydranium/core';
import { DocumentState, type LangiumDocument } from '@hydranium/langium';
import { describe, expect, it } from 'vitest';
import { WORKSPACE_FILES, WORKSPACE_ROOT, makeServices, workspaceUri } from './order-flow-harness.js';

/**
 * The seven files of {@link WORKSPACE_FILES} plus the stdlib virtual document,
 * which the workspace manager seeds at startup and which both helpers carry
 * through the same phases as any file.
 */
const WORKSPACE_DOCUMENT_COUNT = 8;

/** Every registered document, by URI order so a failure names a stable one first. */
function registeredDocuments(harness: ReturnType<typeof makeServices>): LangiumDocument[] {
   return harness.shared.workspace.LangiumDocuments.all.toArray().sort((left, right) => left.uri.path.localeCompare(right.uri.path));
}

describe('order-flow headless init — the editor-equivalent seam links but does not validate', () => {
   it('settles every document and validates none of them', async () => {
      const harness = makeServices();
      await initializeWorkspaceProgrammatically(harness.shared, WORKSPACE_ROOT);

      // Asserted against the landmark constant rather than a literal state, so
      // moving `SettledState` moves this test with it.
      const documents = registeredDocuments(harness);
      expect(documents).toHaveLength(WORKSPACE_DOCUMENT_COUNT);
      for (const document of documents) {
         expect(document.state, document.uri.path).toBeGreaterThanOrEqual(IntegrityService.SettledState);
         expect(document.state, document.uri.path).toBeLessThan(DocumentState.Validated);
         // Not merely "no errors": the field is untouched, because no validation
         // pass ran to assign it. This is the half the eager case inverts.
         expect(document.diagnostics, document.uri.path).toBeUndefined();
      }
   });

   it('the eager helper validates the same root and surfaces its one intended error', async () => {
      const harness = makeServices();
      await buildWorkspaceProgrammatically(harness.shared, WORKSPACE_ROOT);

      // `Validated` for every registered document, the stdlib virtual one
      // included: the framework validator skips it (`validateVirtualDocuments`
      // defaults off), but the skip suppresses its diagnostics, not the phase —
      // it arrives at `Validated` with an empty diagnostics array like every
      // clean file.
      const documents = registeredDocuments(harness);
      expect(documents).toHaveLength(WORKSPACE_DOCUMENT_COUNT);
      for (const document of documents) {
         expect(document.state, document.uri.path).toBe(DocumentState.Validated);
      }

      // The payoff of validating, and the workspace's only intended error:
      // `audit-leak.domain` names `AuditStamp`, which `commerce-core` does not
      // export `public`. Asserted as the ONLY erroring document, so a validation
      // pass that started reporting spurious errors elsewhere fails here too.
      const erroring = documents.filter(document => (document.diagnostics?.length ?? 0) > 0);
      expect(erroring.map(document => document.uri.toString())).toEqual([workspaceUri(WORKSPACE_FILES.auditLeak).toString()]);
      expect(erroring[0].diagnostics?.map(diagnostic => diagnostic.message)).toEqual([expect.stringContaining('AuditStamp')]);
   });
});
