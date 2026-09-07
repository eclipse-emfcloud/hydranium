/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * The stdlib as an **additional document**, seeded into a workspace that has no
 * folders at all.
 *
 * Every other suite here boots through `initializeWorkspaceProgrammatically`
 * over `examples/order-flow/workspace`, so the stdlib always arrives beside the
 * model files a folder walk found. `initializeWorkspace([])` is the other branch
 * of `HydraniumWorkspaceManager.loadAdditionalDocuments`: no folders, no
 * traversal, and therefore no projects — the contribution is the ONLY thing that
 * puts a document in the workspace. That is the state of a client with no folder
 * open, and the branch `AdditionalDocumentRegistry.folders` exists to serve.
 *
 * Deliberately NOT re-asserted here, because `project-visibility.test.ts` owns
 * it: that the stdlib document is present after a folder-scoped init, that its
 * exports carry `tier: 'universal'` with no `projectId`, and that the primitives
 * resolve both from a project with no `requires` and from a dependent one.
 * `diagnostic-enrichment.test.ts` owns the validator's virtual-document skip.
 *
 * With no folders there are no projects, so the framework's project-tier filter
 * is a no-op here — `HydraniumScopeProvider.getProjectScope` returns its input
 * when the source URI has no owning project. What these cases measure is the
 * seeding, the indexing and the per-URI language routing of a document with no
 * backing file, not the tier arithmetic.
 */

import { parseHelper } from '@hydranium/core/testing';
import { AstUtils, DocumentState, type ReferenceInfo } from '@hydranium/langium';
import { describe, expect, it } from 'vitest';
import {
   type DomainModel,
   type Entity,
   type Field,
   type ProcessModel,
   type Write,
   isEntity,
   isTask,
   isWrite
} from '../src/language-server/ast.js';
import { ORDER_FLOW_STDLIB_URI } from '../src/language-server/order-flow-stdlib.js';
import { makeServices, type OrderFlowHarness } from './order-flow-harness.js';

/** One entity typed entirely from the stdlib, plus the enum the effect chain needs. */
const SCRATCH_DOMAIN = `entity Order {
   id: String
   paid: Boolean
   quantity: Number
   status: OrderStatus
}

enum OrderStatus { NEW, PAID }
`;

/** A second-grammar document over the scratch entity, writing to a primitive-typed field. */
const SCRATCH_PROCESS = `process Checkout for Order {
   task Label writes Order.id = PAID
}
`;

/**
 * Boot the three languages and initialize with ZERO folders, so the only
 * document in the workspace is the one the stdlib contribution seeds.
 */
async function bootFolderless(): Promise<OrderFlowHarness> {
   const harness = makeServices();
   await harness.shared.workspace.WorkspaceManager.initializeWorkspace([]);
   return harness;
}

function entityNamed(model: DomainModel, name: string): Entity {
   const found = model.declarations.find(declaration => isEntity(declaration) && declaration.name === name);
   if (!found || !isEntity(found)) {
      throw new Error(`No entity '${name}' in document`);
   }
   return found;
}

function fieldNamed(entity: Entity, name: string): Field {
   const found = entity.fields.find(field => field.name === name);
   if (!found) {
      throw new Error(`No field '${name}' on ${entity.name}`);
   }
   return found;
}

/** Names visible to the `.domain` scope provider for a field's type reference. */
function typeCandidates(harness: OrderFlowHarness, field: Field): string[] {
   const context: ReferenceInfo = { container: field.type, property: 'declared', reference: field.type.declared! };
   return harness.domain.references.ScopeProvider.getScope(context)
      .getAllElements()
      .map(description => description.name)
      .toArray();
}

/** Names visible to the `.process` scope provider for one reference of an effect. */
function effectCandidates(harness: OrderFlowHarness, effect: Write, property: 'entity' | 'literal'): string[] {
   const context: ReferenceInfo = { container: effect, property, reference: effect[property] };
   return harness.process.references.ScopeProvider.getScope(context)
      .getAllElements()
      .map(description => description.name)
      .toArray();
}

/** The write effect of the process's only task. */
function soleWrite(model: ProcessModel): Write {
   const task = model.nodes.find(isTask);
   const write = task?.effects.find(isWrite);
   if (!write) {
      throw new Error(`No write effect in process ${model.name}`);
   }
   return write;
}

describe('order-flow stdlib — the additional-document branch with no workspace folders', () => {
   it('seeds the stdlib and nothing else, and a scratch document still resolves a primitive', async () => {
      const harness = await bootFolderless();

      // The whole workspace, with no folder traversal to fill it: one document,
      // asserted by URI as well as by count so a stdlib that stopped loading
      // cannot be masked by some other document arriving.
      const seeded = harness.shared.workspace.LangiumDocuments.all.toArray();
      expect(seeded.map(document => document.uri.toString())).toEqual([ORDER_FLOW_STDLIB_URI.toString()]);

      const document = await parseHelper<DomainModel>(harness.domain)(SCRATCH_DOMAIN, {
         documentUri: 'file:///scratch/orders.domain',
         validation: true
      });
      expect(document.parseResult.parserErrors).toHaveLength(0);
      expect(document.state).toBeGreaterThanOrEqual(DocumentState.Linked);

      const order = entityNamed(document.parseResult.value, 'Order');
      const id = fieldNamed(order, 'id');
      expect(id.type.declared?.ref?.name).toBe('String');
      // Identity, not just the name: the target is in the seeded virtual
      // document, which is the only place `String` is declared.
      expect(AstUtils.getDocument(id.type.declared!.ref!).uri.toString()).toBe(ORDER_FLOW_STDLIB_URI.toString());
      // The scratch document's own declarations still resolve alongside it.
      expect(fieldNamed(order, 'status').type.declared?.ref?.name).toBe('OrderStatus');
   });

   it('offers all three primitives in the candidate set a completion dropdown would show', async () => {
      const harness = await bootFolderless();
      const document = await parseHelper<DomainModel>(harness.domain)(SCRATCH_DOMAIN, {
         documentUri: 'file:///scratch/candidates.domain',
         validation: true
      });

      // Resolution is not the same claim as candidacy: a name can link and still
      // be missing from the scope a dropdown enumerates. Every primitive is
      // asserted, so a stdlib truncated to its first declaration fails here.
      const candidates = typeCandidates(harness, fieldNamed(entityNamed(document.parseResult.value, 'Order'), 'id'));
      expect(candidates).toContain('String');
      expect(candidates).toContain('Number');
      expect(candidates).toContain('Boolean');
      expect(candidates).toContain('Order');
   });

   it('reaches the seeded document from the second grammar, through the effect chain type hop', async () => {
      const harness = await bootFolderless();
      await parseHelper<DomainModel>(harness.domain)(SCRATCH_DOMAIN, {
         documentUri: 'file:///scratch/effects.domain',
         validation: true
      });
      const process = await parseHelper<ProcessModel>(harness.process)(SCRATCH_PROCESS, {
         documentUri: 'file:///scratch/effects.process',
         validation: true
      });
      expect(process.parseResult.parserErrors).toHaveLength(0);

      const write = soleWrite(process.parseResult.value);
      expect(write.entity.ref?.name).toBe('Order');
      expect(write.field.ref?.name).toBe('id');
      // `OrderFlowProcessScopeProvider.createLiteralScope` hops from the field to
      // its declared type, and with a primitive-typed field that hop lands in the
      // seeded document — a `.domain` target read by the `.process` language's own
      // scope provider, so the seeding has to hold for a language that never
      // declares the primitives itself.
      const declared = write.field.ref!.type.declared;
      expect(declared?.ref?.name).toBe('String');
      expect(AstUtils.getDocument(declared!.ref!).uri.toString()).toBe(ORDER_FLOW_STDLIB_URI.toString());
      // So the effect offers no literal and fails to link: an enum literal is
      // only assignable where an enum is declared.
      expect(effectCandidates(harness, write, 'literal')).toEqual([]);
      expect(write.literal.ref).toBeUndefined();

      // The universal tier ADDS to the reference-type filter rather than
      // bypassing it. No `.process` or `.layout` reference site takes a
      // `Declaration` — they take `Entity`, `Field`, `EnumLiteral`,
      // `ProcessModel`, `FlowNode` — so a stdlib `valuetype` is never a
      // candidate in the second and third grammars, only ever a resolved target
      // reached through one.
      const entityCandidates = effectCandidates(harness, write, 'entity');
      expect(entityCandidates).toContain('Order');
      expect(entityCandidates).not.toContain('String');
      expect(entityCandidates).not.toContain('Number');
      expect(entityCandidates).not.toContain('Boolean');
   });
});
