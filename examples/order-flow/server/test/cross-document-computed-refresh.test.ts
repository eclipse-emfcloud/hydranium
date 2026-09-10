/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * `refreshCrossDocumentComputedScopes` — the cascade half of the AST-extension
 * contract.
 *
 * The sibling suite asserts what a computed property holds after the workspace
 * is built. That is the producer; this is the wiring, and the two fail
 * independently. A computed property derived from ANOTHER document goes stale on
 * a cascade unless the referencing document is reset one phase lower than
 * Langium resets it: Langium resets a cascade-affected document to
 * `ComputedScopes` and rebuilds it from `Linked`, so the `ComputedScopes` pass —
 * and with it every AST extension — never re-runs for it. The option exists to
 * drop that reset to `IndexedContent`.
 *
 * **`_writtenFields` is the only property in this example that can witness the
 * hazard.** It holds `.domain` `Field` NODES reached through
 * `Write.field.ref`, so its staleness is observable as node identity;
 * `_effectSummary` is a string recomputed from the same references and reads
 * identically either way once the reference has re-linked.
 *
 * **Why node identity rather than a name or a count.** `resetToState` unlinks
 * the document, so the `Linked` phase re-resolves `write.field.ref` to the
 * re-parsed `Field` on BOTH settings — only the cached projection can lag. Any
 * assertion over field names therefore passes in both states: the names are
 * unchanged, and that is exactly the silent-staleness the option addresses. The
 * discriminating question is whether the projection and the live reference point
 * at the same object.
 *
 * Both settings are asserted, which makes the pair self-controlling: if the
 * cascade reset stopped happening at all, the default case would stop being
 * stale and redden too.
 */

import { HydraniumDocumentBuilder, initializeWorkspaceProgrammatically } from '@hydranium/core';
import { NodeFileSystem } from '@hydranium/core/node';
import { makeScratchWorkspace } from '@hydranium/core/testing/node';
import { type Field, type ProcessModel, type Task, isTask } from '../src/language-server/ast.js';
import { URI } from '@hydranium/langium';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createOrderFlowServices, type OrderFlowSharedServices } from '../src/language-server/order-flow-module.js';
import { WORKSPACE_FILES, WORKSPACE_ROOT } from './order-flow-harness.js';

/** What the cascade either refreshed or left behind, for one `refreshCrossDocumentComputedScopes` setting. */
interface CascadeOutcome {
   /** `_writtenFields[0]` — the projection cached at `ComputedScopes`. */
   readonly projected: Field | undefined;
   /** `effects[0].field.ref` — the same field via the reference the `Linked` phase re-resolved. */
   readonly linked: Field | undefined;
}

function taskNamed(model: ProcessModel, name: string): Task {
   const found = model.nodes.find(node => isTask(node) && node.name === name);
   if (!found || !isTask(found)) {
      throw new Error(`No task '${name}' in ${model.name}`);
   }
   return found;
}

/**
 * Boot over a throwaway copy of the sample workspace, edit `orders.domain`, and
 * report how `fulfillment.process` came out of the resulting cascade.
 *
 * The builder is rebound rather than configured through the example's own
 * module, because the framework constructs `DocumentBuilder` with no options —
 * which is what `extraSharedModules` exists for. It layers after the framework's
 * own shared module and the example's adopter module binds no
 * `DocumentBuilder`, so this binding is the one that survives.
 */
async function cascadeAfterDomainEdit(refreshCrossDocumentComputedScopes: boolean): Promise<CascadeOutcome> {
   const workspace = makeScratchWorkspace({ seed: WORKSPACE_ROOT, prefix: 'order-flow-cross-doc-refresh-' });
   try {
      const { shared } = createOrderFlowServices(
         { ...NodeFileSystem },
         {
            extraSharedModules: [
               {
                  workspace: {
                     DocumentBuilder: (services: OrderFlowSharedServices) =>
                        new HydraniumDocumentBuilder(services, { refreshCrossDocumentComputedScopes, logLevel: 'off' })
                  }
               }
            ]
         }
      );
      await initializeWorkspaceProgrammatically(shared, workspace.root);

      const processUri = URI.file(workspace.resolve(WORKSPACE_FILES.fulfillmentProcess));
      const processDocument = shared.workspace.LangiumDocuments.getDocument(processUri);
      if (!processDocument) {
         throw new Error(`Process document not loaded: ${WORKSPACE_FILES.fulfillmentProcess}`);
      }

      // The hazard needs a projection to go stale, so fail loudly here rather
      // than passing vacuously on an empty one.
      const before = taskNamed(processDocument.parseResult.value as ProcessModel, 'Pay');
      expect(before._writtenFields).toHaveLength(1);

      // Add a member to the entity the task writes through. Re-parsing replaces
      // every `Field` object in the document while leaving `status` resolvable,
      // which is the state the option's own doc describes: a member added in the
      // referenced document that the referencing one does not pick up.
      const domainPath = workspace.resolve(WORKSPACE_FILES.ordersDomain);
      const edited = readFileSync(domainPath, 'utf8').replace('   lines: LineItem[]', '   lines: LineItem[]\n   note: ID');
      expect(edited).toContain('note: ID');
      workspace.write(WORKSPACE_FILES.ordersDomain, edited);
      await shared.workspace.DocumentBuilder.update([URI.file(domainPath)], []);

      const pay = taskNamed(processDocument.parseResult.value as ProcessModel, 'Pay');
      return { projected: pay._writtenFields?.[0], linked: pay.effects[0].field.ref };
   } finally {
      workspace.dispose();
   }
}

describe('order-flow AST extensions — a cross-document projection across a cascade', () => {
   it('refreshes the projection when the referenced document changes', async () => {
      const { projected, linked } = await cascadeAfterDomainEdit(true);

      // The reference re-resolves regardless of the setting; without this the
      // identity assertion below could be satisfied by two `undefined`s.
      expect(linked).toBeDefined();
      expect(projected).toBe(linked);
   });

   it('leaves the projection pointing at the superseded node by default', async () => {
      const { projected, linked } = await cascadeAfterDomainEdit(false);

      expect(linked).toBeDefined();
      expect(projected).toBeDefined();
      expect(projected).not.toBe(linked);
   });
});
