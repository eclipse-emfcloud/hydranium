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

import { Deferred } from '@hydranium/protocol';
import {
   AstUtils,
   DefaultLexer,
   DocumentState,
   type LexerResult,
   type LexingDiagnostic,
   type ReferenceInfo,
   type TokenizeOptions,
   URI,
   UriUtils
} from '@hydranium/langium';
import { readFileSync } from 'node:fs';
import { describe, expect, it, onTestFinished } from 'vitest';
import { type DomainModel, type Entity, type Field, isEntity } from '../src/language-server/ast.js';
import type { OrderFlowSharedServices } from '../src/language-server/order-flow-module.js';
import { OrderFlowProjectManager } from '../src/language-server/order-flow-project-manager.js';
import { ORDER_FLOW_STDLIB_URI } from '../src/language-server/order-flow-stdlib.js';
import {
   documentFor,
   makeScratchWorkspaceHarness,
   makeWorkspaceHarness,
   type OrderFlowHarness,
   WORKSPACE_FILES,
   workspaceUri
} from './order-flow-harness.js';

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

describe('order-flow workspace with folder-scoped projects', () => {
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

describe('order-flow visibility of the universal tier through the stdlib', () => {
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

describe('order-flow visibility of public declarations across the project boundary', () => {
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

describe('order-flow project descriptors that do not lex', () => {
   /** Reports an error on the `orders` descriptor that only a token builder would, which leaves the parse clean. */
   class DescriptorFlaggingLexer extends DefaultLexer {
      override tokenize(text: string, options?: TokenizeOptions): LexerResult {
         const result = super.tokenize(text, options);
         if (!text.includes('project orders')) {
            return result;
         }
         const diagnostic: LexingDiagnostic = { severity: 'error', message: 'Invalid dedent', offset: 0, length: 0, line: 1, column: 1 };
         return { ...result, report: { diagnostics: [...(result.report?.diagnostics ?? []), diagnostic] } };
      }
   }

   it('skips a descriptor whose lexer reports an error', async () => {
      const { harness, workspace } = await makeScratchWorkspaceHarness(undefined, {
         extraLanguageModules: [{ parser: { Lexer: services => new DescriptorFlaggingLexer(services) } }]
      });
      onTestFinished(() => workspace.dispose());
      const projects = harness.shared.workspace.ProjectManager;

      expect({ orders: projects.getProjectById('orders'), core: projects.getProjectById('commerce-core')?.id }).toEqual({
         orders: undefined,
         core: 'commerce-core'
      });
   });
});

describe('order-flow projects after a descriptor change', () => {
   it('takes effect in the build the edit starts', async () => {
      const { harness, workspace } = await makeScratchWorkspaceHarness();
      onTestFinished(() => workspace.dispose());
      const projects = harness.shared.workspace.ProjectManager;
      const builder = harness.shared.workspace.DocumentBuilder;
      const ordersPath = workspace.resolve(WORKSPACE_FILES.ordersDomain);
      const ordersUri = URI.file(ordersPath);
      const original = readFileSync(ordersPath, 'utf8');
      const totalTypeName = (): string | undefined => {
         const model = harness.shared.workspace.LangiumDocuments.getDocument(ordersUri)!.parseResult.value as DomainModel;
         return fieldNamed(entityNamed(model, 'Order'), 'total').type.declared?.ref?.name;
      };

      workspace.write(WORKSPACE_FILES.ordersDomain, original.replace('project orders requires commerce-core', 'project orders'));
      await builder.update([ordersUri], []);
      expect(projects.getProjectById('orders')?.dependencies).toBeUndefined();
      expect(totalTypeName()).toBeUndefined();

      workspace.write(WORKSPACE_FILES.ordersDomain, original);
      await builder.update([ordersUri], []);
      expect(projects.getProjectById('orders')?.dependencies).toEqual(['commerce-core']);
      expect(totalTypeName()).toBe('Money');
   });

   it('registers a descriptor created by an update in that update', async () => {
      const { harness, workspace } = await makeScratchWorkspaceHarness();
      onTestFinished(() => workspace.dispose());
      const projects = harness.shared.workspace.ProjectManager;
      const refundsUri = URI.file(
         workspace.write('refunds/refunds.domain', 'project refunds requires commerce-core\n\nentity Refund {\n   amount: Money\n}\n')
      );

      await harness.shared.workspace.DocumentBuilder.update([refundsUri], []);

      expect(projects.getProjectById('refunds')?.dependencies).toEqual(['commerce-core']);
      const model = harness.shared.workspace.LangiumDocuments.getDocument(refundsUri)!.parseResult.value as DomainModel;
      expect(fieldNamed(entityNamed(model, 'Refund'), 'amount').type.declared?.ref?.name).toBe('Money');
   });
});

describe('order-flow projects with a deferred member relink', () => {
   // A headerless member of `orders` that resolves a `commerce-core` type.
   const REFUND = 'orders/refund.domain';

   /** Holds the next descriptor load on {@link descriptorGate} once it is set. */
   class GatedProjectManager extends OrderFlowProjectManager {
      descriptorGate?: Promise<void>;
      readonly descriptorHeld = new Deferred<void>();

      protected override async loadDescriptor(uri: URI) {
         const gate = this.descriptorGate;
         this.descriptorGate = undefined;
         if (gate) {
            this.descriptorHeld.resolve();
            await gate;
         }
         return super.loadDescriptor(uri);
      }

      /** Register the member phase listeners, as an earlier deferral does. */
      registerMemberListeners(): void {
         this.registerMemberPhaseListeners();
      }
   }

   interface DropOptions {
      readonly deferMemberRelink: boolean;
      /** Build the change with an unlocked `update` rather than a scheduled one. */
      readonly unlocked?: boolean;
      /** Cancel the first follow-up build as it starts, with a write that builds nothing. */
      readonly cancelFollowUp?: boolean;
      /** Cancel the first follow-up build from a listener of the layout's last phase, ahead of one the cancel skips. */
      readonly cancelInLastPhaseListeners?: boolean;
      /** Build without validation, so the last phase is `IndexedReferences`. */
      readonly withoutValidation?: boolean;
      /**
       * Link the refund in an unlocked build while the change awaits its
       * descriptor, so under the old dependencies, and run that build's
       * `Linked` listeners only once the build of the change has ended.
       */
      readonly staleLinkDuringChange?: boolean;
   }

   interface DropResult {
      readonly buildsEnded: string[];
      readonly relinked: string[];
      /** Per follow-up build start, whether another build was running. */
      readonly startedDuringBuild: boolean[];
      readonly finished: boolean[];
      /**
       * How often every listener of its last phase ran for the layout once a
       * follow-up build started. Unlike the refund, its references still resolve, so no
       * update relinks it unasked.
       */
      readonly layoutDelivered: number;
   }

   /** Drop `orders`' dependency, as a save does, and record each build's end. */
   async function dropDependency(options: DropOptions): Promise<DropResult> {
      const { deferMemberRelink } = options;
      const { harness, workspace } = await makeScratchWorkspaceHarness(
         scratch => scratch.write(REFUND, 'entity Refund {\n   amount: Money\n}\n'),
         {
            extraSharedModules: [
               {
                  workspace: {
                     ProjectManager: (services: OrderFlowSharedServices) => new GatedProjectManager(services, { deferMemberRelink })
                  }
               }
            ]
         }
      );
      const projects = harness.shared.workspace.ProjectManager;
      if (!(projects instanceof GatedProjectManager)) {
         throw new Error('The module override did not bind the project manager');
      }
      onTestFinished(async () => {
         await projects.memberRelinkSettled();
         workspace.dispose();
      });
      const builder = harness.shared.workspace.DocumentBuilder;
      if (options.withoutValidation) {
         builder.updateBuildOptions.validation = false;
      }
      const lastPhase = builder.finalBuildState();
      const refundUri = URI.file(workspace.resolve(REFUND));
      const refundAmount = (): string | undefined => {
         const model = harness.shared.workspace.LangiumDocuments.getDocument(refundUri)!.parseResult.value as DomainModel;
         return fieldNamed(entityNamed(model, 'Refund'), 'amount').type.declared?.ref?.name;
      };
      expect(refundAmount()).toBe('Money');

      const result = {
         buildsEnded: [] as string[],
         relinked: [] as string[],
         startedDuringBuild: [] as boolean[],
         finished: [] as boolean[],
         layoutDelivered: 0
      };
      builder.onBuildEnded(({ completed }) => result.buildsEnded.push(`completed=${completed} amount=${refundAmount()}`));
      projects.onMemberRelinkStarted(documents => {
         result.relinked.push(...documents.map(uri => UriUtils.basename(uri)));
         result.startedDuringBuild.push(builder.activeBuild !== undefined);
         if (options.cancelFollowUp && result.finished.length === 0) {
            void harness.shared.workspace.WorkspaceLock.write(() => undefined);
         }
      });
      projects.onMemberRelinkFinished(({ completed }) => result.finished.push(completed));
      const isLayout = (uri: URI): boolean => UriUtils.basename(uri) === 'fulfillment.layout';
      builder.onDocumentPhaseDelivered(lastPhase, document => {
         if (result.relinked.length > 0 && isLayout(document.uri)) {
            result.layoutDelivered++;
         }
      });
      if (options.cancelInLastPhaseListeners) {
         builder.onDocumentPhase(lastPhase, document => {
            if (result.relinked.length > 0 && result.finished.length === 0 && isLayout(document.uri)) {
               void harness.shared.workspace.WorkspaceLock.write(() => undefined);
            }
         });
         builder.onDocumentPhase(lastPhase, () => undefined);
      }
      const ordersPath = workspace.resolve(WORKSPACE_FILES.ordersDomain);
      workspace.write(
         WORKSPACE_FILES.ordersDomain,
         readFileSync(ordersPath, 'utf8').replace('project orders requires commerce-core', 'project orders')
      );
      if (options.staleLinkDuringChange) {
         const linkHeld = new Deferred<void>();
         const linkGate = new Deferred<void>();
         const linkedHeld = new Deferred<void>();
         const linkedGate = new Deferred<void>();
         const descriptorGate = new Deferred<void>();
         let holdLink = true;
         let holdLinked = false;
         const linker = harness.domain.references.Linker;
         const link = linker.link.bind(linker);
         linker.link = async (document, token) => {
            if (holdLink && document.uri.toString() === refundUri.toString()) {
               holdLink = false;
               linkHeld.resolve();
               await linkGate.promise;
            }
            return link(document, token);
         };
         // Ahead of the project manager's, so it holds the link back from them.
         builder.onDocumentPhase(DocumentState.Linked, async document => {
            if (holdLinked && document.uri.toString() === refundUri.toString()) {
               holdLinked = false;
               linkedHeld.resolve();
               await linkedGate.promise;
            }
         });
         projects.registerMemberListeners();

         const unlocked = builder.update([refundUri], []);
         await linkHeld.promise;
         projects.descriptorGate = descriptorGate.promise;
         const change = builder.scheduleUpdate([URI.file(ordersPath)], []);
         await projects.descriptorHeld.promise;
         holdLinked = true;
         linkGate.resolve();
         await linkedHeld.promise;
         expect(refundAmount(), 'the refund was not linked under the old dependencies').toBe('Money');
         descriptorGate.resolve();
         await change;
         linkedGate.resolve();
         await unlocked;
      } else if (options.unlocked) {
         await builder.update([URI.file(ordersPath)], []);
      } else {
         await builder.scheduleUpdate([URI.file(ordersPath)], []);
      }
      await projects.memberRelinkSettled();

      expect(projects.getProjectById('orders')?.dependencies).toBeUndefined();
      expect(refundAmount()).toBeUndefined();
      expect(harness.shared.workspace.LangiumDocuments.getDocument(refundUri)!.state).toBe(lastPhase);
      return result;
   }

   it('relinks the members of a changed project in the build of the change by default', async () => {
      const { buildsEnded, relinked } = await dropDependency({ deferMemberRelink: false });

      expect(buildsEnded).toEqual(['completed=true amount=undefined']);
      expect(relinked).toEqual([]);
   });

   it('relinks the members of a changed project in a follow-up build once the build of the change has completed', async () => {
      const { buildsEnded, relinked } = await dropDependency({ deferMemberRelink: true });

      expect(buildsEnded).toEqual(['completed=true amount=Money', 'completed=true amount=undefined']);
      expect(relinked).toContain('refund.domain');
      expect(relinked).not.toContain('orders.domain');
   });

   it('starts the follow-up build only once an unlocked build of the change has ended', async () => {
      const { startedDuringBuild, finished } = await dropDependency({ deferMemberRelink: true, unlocked: true });

      expect(startedDuringBuild).toEqual([false]);
      expect(finished).toEqual([true]);
   });

   it.each([
      ['validating', false],
      ['not validating', true]
   ])(
      'delivers the members in a follow-up build queued again after a write cancelled the first during their listeners, %s',
      async (_label, withoutValidation) => {
         const { relinked, finished, layoutDelivered } = await dropDependency({
            deferMemberRelink: true,
            cancelInLastPhaseListeners: true,
            withoutValidation
         });

         expect(relinked.filter(name => name === 'fulfillment.layout')).toHaveLength(2);
         expect(finished).toEqual([false, true]);
         expect(layoutDelivered).toBe(1);
      }
   );

   it('relinks in the build of the change a member an unlocked build linked under the old dependencies meanwhile', async () => {
      const { relinked } = await dropDependency({ deferMemberRelink: true, staleLinkDuringChange: true });

      // The unlocked build was part way through every member, so none is left to a follow-up.
      expect(relinked).toEqual([]);
   });

   it('relinks in the build of the change, once, a member that resolves only once the change adds the dependency', async () => {
      const { harness, workspace } = await makeScratchWorkspaceHarness(
         scratch => {
            scratch.write(REFUND, 'entity Refund {\n   amount: Money\n}\n');
            const ordersPath = scratch.resolve(WORKSPACE_FILES.ordersDomain);
            scratch.write(
               WORKSPACE_FILES.ordersDomain,
               readFileSync(ordersPath, 'utf8').replace('project orders requires commerce-core', 'project orders')
            );
         },
         {
            extraSharedModules: [
               {
                  workspace: {
                     ProjectManager: (services: OrderFlowSharedServices) =>
                        new OrderFlowProjectManager(services, { deferMemberRelink: true })
                  }
               }
            ]
         }
      );
      const projects = harness.shared.workspace.ProjectManager;
      onTestFinished(async () => {
         await projects.memberRelinkSettled();
         workspace.dispose();
      });
      const builder = harness.shared.workspace.DocumentBuilder;
      const refundUri = URI.file(workspace.resolve(REFUND));
      const refundAmount = (): string | undefined => {
         const model = harness.shared.workspace.LangiumDocuments.getDocument(refundUri)!.parseResult.value as DomainModel;
         return fieldNamed(entityNamed(model, 'Refund'), 'amount').type.declared?.ref?.name;
      };
      expect(refundAmount()).toBeUndefined();
      let refundLinks = 0;
      builder.onDocumentPhase(DocumentState.Linked, document => {
         if (document.uri.toString() === refundUri.toString()) {
            refundLinks++;
         }
      });
      const relinked: string[] = [];
      projects.onMemberRelinkStarted(documents => relinked.push(...documents.map(uri => UriUtils.basename(uri))));

      const ordersPath = workspace.resolve(WORKSPACE_FILES.ordersDomain);
      workspace.write(
         WORKSPACE_FILES.ordersDomain,
         readFileSync(ordersPath, 'utf8').replace('project orders', 'project orders requires commerce-core')
      );
      await builder.scheduleUpdate([URI.file(ordersPath)], []);
      expect(refundAmount(), 'the build of the change did not relink the refund').toBe('Money');
      await projects.memberRelinkSettled();

      expect(relinked).not.toContain('refund.domain');
      expect(refundLinks).toBe(1);
   });

   it('builds the members in a follow-up build queued again after a write cancelled the first', async () => {
      const { buildsEnded, finished } = await dropDependency({ deferMemberRelink: true, cancelFollowUp: true });

      expect(finished).toEqual([false, true]);
      expect(buildsEnded.at(-1)).toBe('completed=true amount=undefined');
   });
});
