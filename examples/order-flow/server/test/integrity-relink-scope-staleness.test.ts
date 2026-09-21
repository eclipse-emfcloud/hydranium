/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * A `Linked`-phase integrity repair replaces the document's AST, and the scope
 * caches keep the nodes it replaced.
 *
 * `reparseAndRelink` re-parses a document from inside the `Linked` phase, so
 * every node object of that document is new and `indexManager.updateContent`
 * refreshes the index against the new ones. Nothing evicts the scope caches on
 * that path: it fires `onDocumentPhase`, not `onBuildPhase`, so the build-phase
 * pass that clears them at `IndexedContent` never sees it, and `onUpdate` does
 * not fire mid-build.
 *
 * **The staleness is node identity, not a name**, because a description carries
 * its node and both readers prefer it — Langium's `loadAstNode` returns
 * `description.node` without consulting the path, and so does
 * `HydraniumScopeProvider.resolveReference`. A cached description therefore
 * hands back a node from the DISCARDED AST rather than failing, which is why no
 * linking error appears and why an assertion on names would pass in both states.
 *
 * The repair below renames a FIELD and leaves the entity's own name alone, so
 * the exported name and the node path are identical before and after. The only
 * thing that changes is the object, which isolates the hazard from any
 * rename-visibility effect.
 *
 * `examples/order-flow` registers both its real rules at `Parsed`, where the
 * pipeline re-indexes afterwards and the cache clear covers it. This suite
 * supplies the `Linked`-phase rule the example otherwise has none of.
 */

import { IntegrityPhase, type IntegrityRule, type IntegrityRuleContribution, type IntegrityRuleRegistry } from '@hydranium/core';
import { type LangiumDocument, type ReferenceInfo, URI } from '@hydranium/langium';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { type DomainModel, type Entity, type ProcessModel, isEntity } from '../src/language-server/ast.js';
import { WORKSPACE_FILES, makeScratchWorkspaceHarness } from './order-flow-harness.js';

/** The field name the probe rule repairs, and what it repairs it to. */
const PROBE_FIELD = 'probe';
const REPAIRED_FIELD = 'probeChecked';

/**
 * Renames {@link PROBE_FIELD} on any entity that still has one, at `Linked`.
 *
 * Deliberately not a name-uniqueness rule: this must leave the ENTITY's
 * exported name untouched so the cached description keeps matching by name, and
 * only the node behind it goes stale.
 */
class ProbeFieldRule implements IntegrityRule<Entity> {
   readonly id = 'test:probe-field';
   readonly nodeType = 'Entity';
   readonly phase = IntegrityPhase.Linked;

   enforce(entity: Entity): boolean {
      const field = entity.fields.find(candidate => candidate.name === PROBE_FIELD);
      if (!field) {
         return false;
      }
      field.name = REPAIRED_FIELD;
      return true;
   }
}

class ProbeFieldContribution implements IntegrityRuleContribution {
   registerIntegrityRules(registry: IntegrityRuleRegistry): void {
      registry.register(new ProbeFieldRule());
   }
}

function entityNamed(document: LangiumDocument, name: string): Entity {
   const model = document.parseResult.value as DomainModel;
   const found = model.declarations.find(declaration => isEntity(declaration) && declaration.name === name);
   if (!found || !isEntity(found)) {
      throw new Error(`No entity '${name}' in ${document.uri.toString()}`);
   }
   return found;
}

describe('order-flow integrity — a Linked-phase repair and the scopes cached before it', () => {
   it('leaves the global scope holding the entity node the repair discarded', async () => {
      const { harness, workspace } = await makeScratchWorkspaceHarness(undefined, {
         extraLanguageModules: [{ integrity: { rules: { probeField: () => new ProbeFieldContribution() } } }]
      });
      try {
         const domainPath = workspace.resolve(WORKSPACE_FILES.ordersDomain);
         const domainUri = URI.file(domainPath);
         const returnsUri = URI.file(workspace.resolve(WORKSPACE_FILES.returnsProcess));
         const documents = harness.shared.workspace.LangiumDocuments;

         const returnsDocument = documents.getDocument(returnsUri);
         if (!returnsDocument) {
            throw new Error(`Document not loaded: ${WORKSPACE_FILES.returnsProcess}`);
         }
         const returns = returnsDocument.parseResult.value as ProcessModel;
         const subjectName = returns.subject.$refText;

         // Add the field the rule repairs. Editing after init rather than through
         // `prepare` keeps the repair inside ONE rebuild whose phase order the
         // test controls; the init build runs in several batches, and an
         // `onUpdate` between them would evict the very cache under test.
         const withProbe = readFileSync(domainPath, 'utf8').replace('   lines: LineItem[]', `   lines: LineItem[]\n   ${PROBE_FIELD}: ID`);
         expect(withProbe).toContain(`${PROBE_FIELD}: ID`);
         workspace.write(WORKSPACE_FILES.ordersDomain, withProbe);
         await harness.shared.workspace.DocumentBuilder.update([domainUri], []);

         // The repair has to have run, or the rest asserts nothing: the whole
         // hazard is downstream of `reparseAndRelink` being reached at all.
         const domainDocument = documents.getDocument(domainUri);
         if (!domainDocument) {
            throw new Error(`Document not loaded: ${WORKSPACE_FILES.ordersDomain}`);
         }
         const liveOrder = entityNamed(domainDocument, subjectName);
         expect(liveOrder.fields.map(field => field.name)).toContain(REPAIRED_FIELD);

         // What the cache should be handing out: the entity in the AST the
         // repair produced, not the one it replaced.
         const scopeProvider = harness.process.references.ScopeProvider;
         const referenceInfo: ReferenceInfo = { reference: returns.subject, container: returns, property: 'subject' };
         const description = scopeProvider.getScope(referenceInfo).getElement(subjectName);

         expect(description).toBeDefined();
         expect(description?.node).toBe(liveOrder);
      } finally {
         workspace.dispose();
      }
   });
});
