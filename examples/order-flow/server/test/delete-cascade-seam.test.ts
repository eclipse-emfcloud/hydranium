/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * `collectDeletedURIs` — the delete-cascade seam, asserted through a real
 * `update` rather than by calling the method.
 *
 * **What is worth asserting here is narrower than it first looks, and the
 * reason is the point of this file.** Langium's own `update` already cascades a
 * directory delete: it hands each deleted URI to
 * `LangiumDocuments.deleteDocuments`, which prefix-matches a `UriTrie` and
 * removes every document beneath it. So "deleting a directory removes the
 * documents inside it" is satisfied whether or not this seam is consulted, and
 * a test asserting it would pass against a builder that ignored the seam
 * entirely — a neighbouring mechanism producing the same observable.
 *
 * The discriminating contribution is therefore the OVERRIDE: a URI the seam adds
 * that does **not** sit under the deleted path, which no prefix match can reach.
 * That is the shape a real adopter needs it for — a project descriptor tracked
 * outside the directory being removed — so it is what this asserts.
 *
 * Every `update` call in this repo's suites otherwise passes an empty `deleted`
 * array, which is why the seam had no coverage at all.
 */

import { HydraniumDocumentBuilder, initializeWorkspaceProgrammatically } from '@hydranium/core';
import { NodeFileSystem } from '@hydranium/core/node';
import { makeScratchWorkspace } from '@hydranium/core/testing/node';
import { URI } from '@hydranium/langium';
import { rmSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createOrderFlowServices, type OrderFlowSharedServices } from '../src/language-server/order-flow-module.js';
import { WORKSPACE_FILES, WORKSPACE_ROOT } from './order-flow-harness.js';

/** The document the deleted directory does not contain, standing in for an adopter's out-of-tree descriptor. */
const OUTSIDE_DOCUMENT = WORKSPACE_FILES.commerceCoreInternal;
/** Deleted as a directory, so the default seam takes its non-file branch. */
const DELETED_DIRECTORY = 'orders';

/**
 * Builder whose cascade adds URIs from outside the deleted path, the way an
 * adopter's domain-aware override does.
 */
class OutOfTreeCascadeBuilder extends HydraniumDocumentBuilder {
   /**
    * Set after construction rather than passed in: the framework constructs the
    * builder from the services tree alone, so a factory has nowhere to thread an
    * extra argument without restating the whole binding.
    */
   alsoDelete: URI[] = [];

   protected override collectDeletedURIs(uri: URI): URI[] {
      return [...super.collectDeletedURIs(uri), ...this.alsoDelete];
   }
}

describe('order-flow delete cascade — the collectDeletedURIs seam', () => {
   it('honours a URI the override adds from outside the deleted directory', async () => {
      const workspace = makeScratchWorkspace({ seed: WORKSPACE_ROOT, prefix: 'order-flow-delete-cascade-' });
      try {
         const { shared } = createOrderFlowServices(
            { ...NodeFileSystem },
            {
               extraSharedModules: [
                  {
                     workspace: {
                        DocumentBuilder: (services: OrderFlowSharedServices) => new OutOfTreeCascadeBuilder(services, { logLevel: 'off' })
                     }
                  }
               ]
            }
         );
         await initializeWorkspaceProgrammatically(shared, workspace.root);

         const documents = shared.workspace.LangiumDocuments;
         const outsideUri = URI.file(workspace.resolve(OUTSIDE_DOCUMENT));
         const insideUri = URI.file(workspace.resolve(WORKSPACE_FILES.ordersDomain));
         const directoryUri = URI.file(workspace.resolve(DELETED_DIRECTORY));

         // Both loaded by the workspace walk, so their later absence means removal
         // rather than never having been there.
         expect(documents.getDocument(outsideUri)).toBeDefined();
         expect(documents.getDocument(insideUri)).toBeDefined();

         const builder = shared.workspace.DocumentBuilder as OutOfTreeCascadeBuilder;
         builder.alsoDelete = [outsideUri];

         // Remove the directory from disk as well, so nothing can legitimately
         // re-read what the notification says is gone.
         rmSync(workspace.resolve(DELETED_DIRECTORY), { recursive: true, force: true });
         await builder.update([], [directoryUri]);

         // The discriminating assertion: reachable only because the seam ran.
         expect(documents.getDocument(outsideUri)).toBeUndefined();
         // Langium's prefix match would have done this one on its own; asserted to
         // show the override widened the cascade rather than replacing it.
         expect(documents.getDocument(insideUri)).toBeUndefined();
      } finally {
         workspace.dispose();
      }
   });
});
