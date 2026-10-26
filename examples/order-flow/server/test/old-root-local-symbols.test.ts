/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * A scope asked from a node of a root a rebuild replaced answers from the
 * local symbols the builder assigned for that root, not from what the scope
 * computation's base walk returned before an override changed it.
 */

import { type AstNode, type LocalSymbols, URI } from '@hydranium/langium';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { ProcessModel, Transition } from '../src/language-server/ast.js';
import { WORKSPACE_FILES, makeScratchWorkspaceHarness } from './order-flow-harness.js';

describe('the local symbols of a replaced root', () => {
   it('are the map the scope computation returned, an override included', async () => {
      const { harness, workspace } = await makeScratchWorkspaceHarness();
      try {
         const computation = harness.process.references.ScopeComputation;
         const collect = computation.collectLocalSymbols.bind(computation);
         // An override that returns a map of its own, adding `Extra` at the root.
         vi.spyOn(computation, 'collectLocalSymbols').mockImplementation(async (document, cancelToken) => {
            const base = await collect(document, cancelToken);
            const root: AstNode = document.parseResult.value;
            const extra = { ...base.getStream(root).head()!, name: 'Extra' };
            const overridden: LocalSymbols = {
               has: node => base.has(node),
               getStream: node => (node === root ? base.getStream(node).concat([extra]) : base.getStream(node))
            };
            return overridden;
         });
         const path = workspace.resolve(WORKSPACE_FILES.fulfillmentProcess);
         const uri = URI.file(path);
         const documents = harness.shared.workspace.LangiumDocuments;
         await harness.shared.workspace.DocumentBuilder.update([uri], []);
         const old = documents.getDocument(uri)!.parseResult.value as ProcessModel;

         workspace.write(
            WORKSPACE_FILES.fulfillmentProcess,
            readFileSync(path, 'utf8').replace('   task Cancel', '   task Audit\n   task Cancel')
         );
         await harness.shared.workspace.DocumentBuilder.update([uri], []);

         const transition: Transition = old.transitions[0];
         const scope = harness.process.references.ScopeProvider.getScope({
            container: transition,
            property: 'target',
            reference: transition.target
         });
         expect({
            replaced: documents.getDocument(uri)!.parseResult.value !== old,
            extra: scope.getElement('Extra')?.name,
            local: scope.getElement('Pick')?.name
         }).toEqual({ replaced: true, extra: 'Extra', local: 'Pick' });
      } finally {
         workspace.dispose();
      }
   });
});
