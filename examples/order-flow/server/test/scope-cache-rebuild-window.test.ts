/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * A scope query answered while a rebuild has the index open must not outlive it.
 *
 * `DocumentBuilder.update` takes every changed document's symbols OUT of the
 * index before it does any asynchronous work, and only puts them back at
 * `IndexedContent`. The scope caches evict on `onUpdate`, which fires inside
 * that gap — so the eviction meant to protect the build lands at the one moment
 * it cannot help, and any scope built before `IndexedContent` is cached with the
 * changed document's symbols missing from it.
 *
 * The damage is not confined to the query that caused it. The cache is keyed by
 * reference type, so every document the same build relinks reads the same
 * answer, and Langium's linker keeps the first result a reference gets — so the
 * errors persist until something independently resets those documents.
 *
 * **`returns.process` is the witness, and it has to be a document other than the
 * edited one.** Its `process Returns for Order` names an `Entity` declared in
 * `orders.domain`, so it is relinked by the cascade of editing that file and
 * resolves through exactly the cached scope the query poisons. Asserting on the
 * edited document instead would prove nothing: that one is re-parsed and
 * re-linked from scratch, which is the path that works either way.
 *
 * The in-window probe is calibrated against the same query run BEFORE the
 * update rather than asserted absolutely, because what the scope is keyed by is
 * the naming service's business: only the difference between the two answers
 * establishes that the fixture reached the state the hazard needs.
 */

import { DocumentState, URI, type ReferenceInfo } from '@hydranium/langium';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Entity, ProcessModel } from '../src/language-server/ast.js';
import { WORKSPACE_FILES, makeScratchWorkspaceHarness } from './order-flow-harness.js';

describe('order-flow scope caches — a query landing mid-rebuild', () => {
   it('does not strand a cross-document reference in an unedited document', async () => {
      const { harness, workspace } = await makeScratchWorkspaceHarness();
      try {
         const returnsUri = URI.file(workspace.resolve(WORKSPACE_FILES.returnsProcess));
         const returnsDocument = harness.shared.workspace.LangiumDocuments.getDocument(returnsUri);
         if (!returnsDocument) {
            throw new Error(`Document not loaded: ${WORKSPACE_FILES.returnsProcess}`);
         }
         const returns = returnsDocument.parseResult.value as ProcessModel;

         // Fail loudly rather than pass vacuously: the reference has to resolve
         // before the rebuild for its loss afterwards to mean anything.
         expect(returns.subject.ref).toBeDefined();

         const scopeProvider = harness.process.references.ScopeProvider;
         const referenceInfo: ReferenceInfo = { reference: returns.subject, container: returns, property: 'subject' };
         const subjectName = returns.subject.$refText;
         const probeScope = (): boolean => scopeProvider.getScope(referenceInfo).getElement(subjectName) !== undefined;

         const visibleBeforeUpdate = probeScope();

         // The racing reference lookup, landing where an unwaited RPC would: the
         // index has been emptied of the edited document and not yet refilled.
         let visibleInWindow: boolean | undefined;
         const listener = harness.shared.workspace.DocumentBuilder.onBuildPhase(DocumentState.Parsed, () => {
            visibleInWindow ??= probeScope();
         });

         try {
            const domainPath = workspace.resolve(WORKSPACE_FILES.ordersDomain);
            const edited = readFileSync(domainPath, 'utf8').replace('   lines: LineItem[]', '   lines: LineItem[]\n   note: ID');
            expect(edited).toContain('note: ID');
            workspace.write(WORKSPACE_FILES.ordersDomain, edited);
            await harness.shared.workspace.DocumentBuilder.update([URI.file(domainPath)], []);
         } finally {
            listener.dispose();
         }

         // The fixture reached the hazard: the same query answered differently
         // inside the window than outside it.
         expect(visibleBeforeUpdate).toBe(true);
         expect(visibleInWindow).toBe(false);

         // What the poisoned answer must not have cost: a document nobody edited.
         const relinked = harness.shared.workspace.LangiumDocuments.getDocument(returnsUri)?.parseResult.value as ProcessModel;
         expect(relinked.subject.error).toBeUndefined();
         expect(relinked.subject.ref).toBeDefined();
         expect((relinked.subject.ref as Entity).name).toBe(subjectName);
      } finally {
         workspace.dispose();
      }
   });
});
