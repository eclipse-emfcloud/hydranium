/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * Cross-project visibility over a **folder-scoped** project model, and the
 * negative that makes it a demonstration rather than an assertion.
 *
 * `commerce-core` marks `Money` / `ID` / `Address` `public` and leaves
 * `AuditStamp` unmarked. `orders` requires `commerce-core`. So from `orders`
 * the first three resolve and the fourth must not — neither by linking nor in
 * the candidate set a completion dropdown would show. A visibility tier you
 * cannot observe failing is not demonstrated.
 *
 * A project is a folder here, with several files and two grammars in it, so
 * `getProject`'s closest-ancestor-descriptor-folder rule is doing real work
 * rather than acting as the identity map it degenerates to when every project
 * holds a single file.
 */

import { AstUtils, DocumentState, type ReferenceInfo } from '@hydranium/langium';
import { describe, expect, it } from 'vitest';
import { type DomainModel, type Entity, type Field, isEntity } from '../src/language-server/ast.js';
import { ORDER_FLOW_STDLIB_URI } from '../src/language-server/order-flow-stdlib.js';
import { documentFor, makeWorkspaceHarness, type OrderFlowHarness, workspaceUri } from './order-flow-harness.js';

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

describe('order-flow workspace — folder-scoped projects', () => {
   it('discovers one project per folder from the .domain file carrying the project header', async () => {
      const harness = await makeWorkspaceHarness();
      const projects = harness.shared.workspace.ProjectManager;

      expect(
         projects
            .getProjects()
            .map(project => project.id)
            .sort()
      ).toEqual(['commerce-core', 'orders']);
      expect(projects.getProjectById('orders')?.dependencies).toEqual(['commerce-core']);
      expect(projects.getProjectById('commerce-core')?.dependencies).toBeUndefined();
   });

   it('treats headerless .domain files and .process files as members of the enclosing folder', async () => {
      const harness = await makeWorkspaceHarness();
      const projects = harness.shared.workspace.ProjectManager;

      expect(projects.getProject(workspaceUri('commerce-core/internal.domain'))?.id).toBe('commerce-core');
      expect(projects.getProject(workspaceUri('orders/audit-leak.domain'))?.id).toBe('orders');
      expect(projects.getProject(workspaceUri('orders/fulfillment.process'))?.id).toBe('orders');
      expect(projects.getProject(workspaceUri('orders/returns.process'))?.id).toBe('orders');
   });

   it('walks the dependency edge one way only', async () => {
      const harness = await makeWorkspaceHarness();
      const projects = harness.shared.workspace.ProjectManager;

      expect([...projects.getVisibleProjects('orders')].sort()).toEqual(['commerce-core', 'orders']);
      expect([...projects.getVisibleProjects('commerce-core')]).toEqual(['commerce-core']);
   });

   it('builds every workspace document through the editor-equivalent init path', async () => {
      const harness = await makeWorkspaceHarness();

      // The descriptors are a strict subset of the model files here, so this
      // is also the regression guard for `performStartup`'s descriptor
      // back-fill: without it the four `.domain` files stay at `Parsed`.
      // Seven workspace files (four `.domain`, two `.process`, one `.layout`)
      // plus the stdlib virtual document, which the workspace manager seeds at
      // startup and which is built through the same pipeline as any file —
      // asserted by URI rather than by count alone, so a stdlib that silently
      // stopped loading cannot be masked by an off-by-one.
      const documents = harness.shared.workspace.LangiumDocuments.all.toArray();
      expect(documents).toHaveLength(8);
      // The `.layout` file is discovered by the SAME walk, which is what makes
      // its cross-document reference resolvable without any extra wiring.
      expect(documents.map(document => document.uri.path.split('/').pop())).toContain('fulfillment.layout');
      expect(documents.map(document => document.uri.toString())).toContain(ORDER_FLOW_STDLIB_URI.toString());
      for (const document of documents) {
         expect(document.state, document.uri.path).toBeGreaterThanOrEqual(DocumentState.Linked);
         expect(document.parseResult.parserErrors, document.uri.path).toHaveLength(0);
      }
   });
});

describe('order-flow visibility — the universal tier, via the stdlib', () => {
   it('exports stdlib declarations at tier universal, with no owning project', async () => {
      // The mechanism itself, asserted rather than inferred from the fact that
      // resolution happens to work. `Money` is the contrast: a project-owned
      // declaration carries `project` + `public` siblings and a `projectId`,
      // while a stdlib declaration carries `universal` and no project at all.
      const harness = await makeWorkspaceHarness();
      const descriptions = harness.shared.workspace.IndexManager.getElementsByName('String');

      expect(descriptions).toHaveLength(1);
      const description = descriptions[0] as unknown as { tier?: string; projectId?: string };
      expect(description.tier).toBe('universal');
      expect(description.projectId).toBeUndefined();
      expect(descriptions[0].documentUri.toString()).toBe(ORDER_FLOW_STDLIB_URI.toString());
   });

   it('resolves stdlib primitives from a project that requires nothing', async () => {
      // `commerce-core` has no `requires` at all, so anything it resolves that
      // is not its own is reaching the universal tier. That tier is not
      // configured anywhere: the framework emits a document's exports at
      // `tier: 'universal'` precisely when the document has no owning project,
      // and the stdlib is headerless. Declaring the primitives in a document
      // rather than as grammar keywords is what makes the tier observable at
      // all — a keyword resolves inside the parser, with no scope to test.
      const harness = await makeWorkspaceHarness();
      const address = entityNamed(documentFor<DomainModel>(harness, 'commerce-core/money.domain').parseResult.value, 'Address');

      const street = fieldNamed(address, 'street');
      expect(street.type.declared?.ref?.name).toBe('String');
      // Identity, not just the name: asserts it resolved to the STDLIB document
      // rather than to some same-named declaration that happened to be in scope.
      expect(AstUtils.getDocument(street.type.declared!.ref!).uri.toString()).toBe(ORDER_FLOW_STDLIB_URI.toString());
   });

   it('resolves stdlib primitives from a dependent project too', async () => {
      // The other side: `orders` DOES require `commerce-core`, so this proves
      // the universal tier is not being reached incidentally through a project
      // dependency edge — `String` is in neither project.
      const harness = await makeWorkspaceHarness();
      const lineItem = entityNamed(documentFor<DomainModel>(harness, 'orders/orders.domain').parseResult.value, 'LineItem');

      expect(fieldNamed(lineItem, 'quantity').type.declared?.ref?.name).toBe('Number');
      const quantityType = fieldNamed(lineItem, 'quantity').type.declared!.ref!;
      expect(AstUtils.getDocument(quantityType).uri.toString()).toBe(ORDER_FLOW_STDLIB_URI.toString());
   });
});

describe('order-flow visibility — public declarations cross the project boundary', () => {
   it('resolves commerce-core public declarations from orders', async () => {
      const harness = await makeWorkspaceHarness();
      const order = entityNamed(documentFor<DomainModel>(harness, 'orders/orders.domain').parseResult.value, 'Order');

      expect(fieldNamed(order, 'id').type.declared?.ref?.name).toBe('ID');
      expect(fieldNamed(order, 'total').type.declared?.ref?.name).toBe('Money');
      expect(fieldNamed(order, 'shipTo').type.declared?.ref?.name).toBe('Address');
   });

   it('resolves a project-visible declaration across files WITHIN its own project', async () => {
      const harness = await makeWorkspaceHarness();
      const auditStamp = entityNamed(documentFor<DomainModel>(harness, 'commerce-core/internal.domain').parseResult.value, 'AuditStamp');

      // `ID` lives in money.domain — same project, different file.
      expect(fieldNamed(auditStamp, 'stamp').type.declared?.ref?.name).toBe('ID');
   });

   it('does NOT resolve a project-visible declaration from a dependent project', async () => {
      const harness = await makeWorkspaceHarness();
      const shipmentLog = entityNamed(documentFor<DomainModel>(harness, 'orders/audit-leak.domain').parseResult.value, 'ShipmentLog');
      const stamp = fieldNamed(shipmentLog, 'stamp');

      // The reference parses — `AuditStamp` is a structurally valid target
      // name — and fails to link, because it carries no `public` modifier and
      // therefore has no public-tier description for `orders` to see.
      expect(stamp.type.declared?.ref).toBeUndefined();
      expect(stamp.type.declared?.$refText).toBe('AuditStamp');
      expect(stamp.type.declared?.error?.message).toContain('AuditStamp');
   });

   it('keeps the unmarked declaration out of the candidate set completion would show', async () => {
      const harness = await makeWorkspaceHarness();
      const shipmentLog = entityNamed(documentFor<DomainModel>(harness, 'orders/audit-leak.domain').parseResult.value, 'ShipmentLog');

      const candidates = typeCandidates(harness, fieldNamed(shipmentLog, 'stamp'));
      expect(candidates).toContain('Money');
      expect(candidates).toContain('Address');
      expect(candidates).toContain('Order');
      expect(candidates).not.toContain('AuditStamp');
   });

   it('offers the unmarked declaration inside its own project', async () => {
      const harness = await makeWorkspaceHarness();
      const auditStamp = entityNamed(documentFor<DomainModel>(harness, 'commerce-core/internal.domain').parseResult.value, 'AuditStamp');

      const candidates = typeCandidates(harness, fieldNamed(auditStamp, 'stamp'));
      expect(candidates).toContain('AuditStamp');
      expect(candidates).toContain('Money');
      // No transitive visibility the other way: commerce-core does not require orders.
      expect(candidates).not.toContain('Order');
   });
});
