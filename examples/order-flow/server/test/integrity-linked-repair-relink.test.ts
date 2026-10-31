/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * Whether a document that references one an integrity rule repaired at the
 * `Linked` phase resolves into the repaired document's current AST.
 *
 * The repair relinks only the repaired document within the build, so its
 * dependents are relinked by a build after it. Every sync mode and open state
 * is covered, because they decide whether the repair reaches the text the
 * re-parse reads. A re-parse replaces the document's nodes. A closed document
 * in `'editor'` mode keeps its AST, where the repair renames in place, and the
 * build after the repair re-reads its unrepaired disk text, which must not
 * repair it again.
 */

import {
   DefaultCstResidencyService,
   DefaultIntegrityService,
   type IntegrityRule,
   IntegrityPhase,
   type IntegritySyncMode,
   type VersionSyncService
} from '@hydranium/core';
import { makeCapturingTracer } from '@hydranium/core/testing';
import { makeFakeClock } from '@hydranium/protocol/testing';
import { type AstNode, AstUtils, DocumentState, type LangiumDocument, URI } from '@hydranium/langium';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';
import { type DomainModel, type Entity, isEntity, type ProcessModel } from '../src/language-server/ast.js';
import { makeServices, type OrderFlowHarness } from './order-flow-harness.js';

const CLEAN_SOURCE = `enum OrderStatus { NEW, PAID }

entity Order {
   status: OrderStatus
}
`;
/** The `extra` field is what the rules below rename. */
const REPAIRABLE_SOURCE = `enum OrderStatus { NEW, PAID }

entity Order {
   status: OrderStatus
   extra: string
}
`;
/** An edit after a repair: the field to repair, and one more. */
const EDITED_SOURCE = `enum OrderStatus { NEW, PAID }

entity Order {
   status: OrderStatus
   extra: string
   note: string
}
`;
const FULFILLMENT_SOURCE = `process Fulfillment for Order {
   task Ship reads Order.status
}
`;

/**
 * Counts its repairs. `again` makes it rename its own repair on every pass, a
 * rule that never settles. `onRepaired` runs when it meets its repair.
 */
function renameRule(
   options: { again?: boolean; onRepaired?: () => void } = {}
): IntegrityRule & { repairs: number; enforce(node: AstNode): boolean } {
   return {
      id: 'test-linked-rename',
      nodeType: 'Field',
      phase: IntegrityPhase.Linked,
      repairs: 0,
      enforce(node: AstNode): boolean {
         const named = node as AstNode & { name?: string };
         if (named.name === 'extraRepaired') {
            options.onRepaired?.();
         }
         const repairable = options.again ? named.name?.startsWith('extra') : named.name === 'extra';
         if (!repairable) {
            return false;
         }
         named.name = `${named.name}Repaired`;
         this.repairs++;
         return true;
      }
   };
}

interface Fixture {
   readonly harness: OrderFlowHarness;
   readonly orderDocument: LangiumDocument<DomainModel>;
   readonly processDocument: LangiumDocument<ProcessModel>;
   /** Every follow-up build requested so far, so a test can wait them out. */
   readonly recovery: MockInstance<VersionSyncService['requestRecoveryBuild']>;
}

let folder = '';
beforeEach(() => {
   folder = mkdtempSync(join(tmpdir(), 'order-flow-linked-repair-'));
});
afterEach(() => rmSync(folder, { recursive: true, force: true }));

/** Real files, because a re-parse of a closed document reads disk. */
function setUp(
   rule: IntegrityRule,
   options: {
      syncMode: IntegritySyncMode;
      open?: boolean;
      orderSource?: string;
      harnessOptions?: Parameters<typeof makeServices>[0];
      integrityService?: typeof DefaultIntegrityService;
   }
): Fixture {
   const { syncMode, open = false, orderSource = REPAIRABLE_SOURCE, integrityService: Service = DefaultIntegrityService } = options;
   const harness = makeServices({
      ...options.harnessOptions,
      extraLanguageModules: [{ integrity: { IntegrityService: services => new Service(services, { syncMode }) } }]
   });
   harness.domain.integrity.IntegrityService.register(rule);
   const workspace = harness.shared.workspace;
   const create = <T extends AstNode>(name: string, text: string): LangiumDocument<T> => {
      writeFileSync(join(folder, name), text);
      const document = workspace.LangiumDocumentFactory.fromString<T>(text, URI.file(join(folder, name)));
      workspace.LangiumDocuments.addDocument(document);
      return document;
   };
   const orderDocument = create<DomainModel>('order.domain', orderSource);
   const processDocument = create<ProcessModel>('fulfillment.process', FULFILLMENT_SOURCE);
   if (open) {
      workspace.TextDocuments.notifyDidOpenTextDocument({
         textDocument: { uri: orderDocument.uri.toString(), languageId: 'domain', version: 1, text: orderSource }
      });
   }
   const recovery = vi.spyOn(workspace.VersionSyncService, 'requestRecoveryBuild');
   return { harness, orderDocument, processDocument, recovery };
}

async function build(fixture: Fixture, documents: LangiumDocument[]): Promise<void> {
   const workspace = fixture.harness.shared.workspace;
   await workspace.WorkspaceLock.write(token => workspace.DocumentBuilder.build(documents, { validation: true }, token));
}

/** Wait out every requested build, and the builds those request, failing rather than hanging on a chain that does not end. */
async function settle(fixture: Fixture): Promise<void> {
   let waited = 0;
   for (let round = 0; round < 5; round++) {
      const pending = fixture.recovery.mock.results.slice(waited).map(result => result.value);
      if (pending.length === 0) {
         return;
      }
      waited += pending.length;
      await Promise.all(pending);
   }
   // Builds nothing more, so a runaway chain does not starve the tests after this one.
   fixture.recovery.mockResolvedValue(undefined);
   throw new Error(`Builds still requested after ${waited} of them`);
}

function order(document: LangiumDocument<DomainModel>): Entity {
   const declaration = document.parseResult.value.declarations.find(candidate => candidate.name === 'Order');
   if (!isEntity(declaration)) {
      throw new Error(`Expected an entity named Order, got ${declaration?.$type ?? 'nothing'}`);
   }
   return declaration;
}

const MODES = [
   ['silent', false],
   ['silent', true],
   ['editor', false],
   ['editor', true]
] as const;
const MODE_ROWS = MODES.map(([syncMode, open]) => [`${syncMode}, ${open ? 'open' : 'closed'}`, syncMode, open] as const);
// A closed document in `'editor'` mode keeps its AST, so its row would pass without the build after the repair.
const REPARSED_ROWS = MODE_ROWS.filter(([, syncMode, open]) => syncMode === 'silent' || open);
// Every reference resolves, so the document may shed its CST.
const RESOLVING_REPAIRABLE = REPAIRABLE_SOURCE.replace('extra: string', 'extra: OrderStatus');
const RESOLVING_EDITED = EDITED_SOURCE.replace('extra: string', 'extra: OrderStatus').replace('note: string', 'note: OrderStatus');

/** Sheds a closed document's CST whenever `clock` moves on. */
function shedWhenIdle(
   tracer: ReturnType<typeof makeCapturingTracer>['tracer'],
   clock: ReturnType<typeof makeFakeClock>
): Parameters<typeof makeServices>[0] {
   return {
      extraSharedModules: [
         {
            Tracer: () => tracer,
            Clock: () => clock,
            workspace: {
               CstResidencyService: services =>
                  new DefaultCstResidencyService(services, { strategy: { kind: 'shed-closed-when-idle', idleMs: 1 } })
            }
         }
      ]
   };
}

describe('a Linked-phase integrity repair', () => {
   it.each(REPARSED_ROWS)('leaves a dependent resolving into the re-parsed AST (%s)', async (_label, syncMode, open) => {
      const rule = renameRule();
      const fixture = setUp(rule, { syncMode, open });
      await build(fixture, [fixture.orderDocument, fixture.processDocument]);
      await settle(fixture);

      expect(rule.repairs).toBe(1);
      expect(order(fixture.orderDocument).fields.map(field => field.name)).toEqual(['status', 'extraRepaired']);
      expect(fixture.processDocument.parseResult.value.subject.ref).toBe(order(fixture.orderDocument));
   });

   it.each(MODE_ROWS)('leaves a dependent of a renamed target unresolved (%s)', async (_label, syncMode, open) => {
      const renameStatus: IntegrityRule = {
         id: 'test-linked-rename-target',
         nodeType: 'Field',
         phase: IntegrityPhase.Linked,
         enforce(node: AstNode): boolean {
            const named = node as AstNode & { name?: string };
            if (named.name !== 'status') {
               return false;
            }
            named.name = 'state';
            return true;
         }
      };
      const fixture = setUp(renameStatus, { syncMode, open });
      await build(fixture, [fixture.orderDocument, fixture.processDocument]);
      await settle(fixture);

      const unresolved = fixture.processDocument.references.filter(reference => reference.error !== undefined);
      expect(unresolved.map(reference => reference.$refText)).toEqual(['status']);
   });

   it.each(MODE_ROWS)('asks for one build after it, which repairs nothing (%s)', async (_label, syncMode, open) => {
      const rule = renameRule();
      const fixture = setUp(rule, { syncMode, open });
      await build(fixture, [fixture.orderDocument, fixture.processDocument]);
      await settle(fixture);

      expect(fixture.recovery).toHaveBeenCalledTimes(1);
      expect(rule.repairs).toBe(1);
   });

   it.each(MODE_ROWS)(
      'stops after three builds in a row, with a warning, when a rule never settles (%s)',
      async (_label, syncMode, open) => {
         const { tracer, lines } = makeCapturingTracer();
         const rule = renameRule({ again: true });
         const fixture = setUp(rule, { syncMode, open, harnessOptions: { extraSharedModules: [{ Tracer: () => tracer }] } });
         await build(fixture, [fixture.orderDocument, fixture.processDocument]);
         await settle(fixture);

         expect(rule.repairs).toBe(4);
         expect(fixture.recovery).toHaveBeenCalledTimes(3);
         const warnings = lines.filter(line => line.level === 'warn').map(line => line.message);
         expect(warnings).toHaveLength(1);
         expect(warnings[0]).toContain("Integrity rule 'test-linked-rename' repaired documents in 3 builds in a row");
      }
   );

   it.each(MODE_ROWS)(
      'relinks every build a rule needs, with no warning, when it settles on its second pass (%s)',
      async (_label, syncMode, open) => {
         const { tracer, lines } = makeCapturingTracer();
         const twoStep = { extra: 'extraRepaired', extraRepaired: 'extraDone' } as Record<string, string | undefined>;
         let repairs = 0;
         const rule: IntegrityRule = {
            id: 'test-two-step',
            nodeType: 'Field',
            phase: IntegrityPhase.Linked,
            enforce(node: AstNode): boolean {
               const named = node as AstNode & { name?: string };
               const next = named.name === undefined ? undefined : twoStep[named.name];
               if (next === undefined) {
                  return false;
               }
               named.name = next;
               repairs++;
               return true;
            }
         };
         const fixture = setUp(rule, { syncMode, open, harnessOptions: { extraSharedModules: [{ Tracer: () => tracer }] } });
         await build(fixture, [fixture.orderDocument, fixture.processDocument]);
         await settle(fixture);

         expect(repairs).toBe(2);
         expect(fixture.recovery).toHaveBeenCalledTimes(2);
         expect(lines.filter(line => line.level === 'warn')).toHaveLength(0);
         expect(fixture.processDocument.parseResult.value.subject.ref).toBe(order(fixture.orderDocument));
      }
   );

   it('stops a chain across two documents that reference each other, with a warning, when their rules never settle', async () => {
      const { tracer, lines } = makeCapturingTracer();
      const rule = renameRule({ again: true });
      const fixture = setUp(rule, {
         syncMode: 'silent',
         orderSource: REPAIRABLE_SOURCE.replace('extra: string', 'extra: Other'),
         harnessOptions: { extraSharedModules: [{ Tracer: () => tracer }] }
      });
      const workspace = fixture.harness.shared.workspace;
      const otherText = 'entity Other {\n   back: Order\n}\n';
      writeFileSync(join(folder, 'other.domain'), otherText);
      const other = workspace.LangiumDocumentFactory.fromString(otherText, URI.file(join(folder, 'other.domain')));
      workspace.LangiumDocuments.addDocument(other);
      // Repairs the other document only once the first build is over, so each document's build relinks the other's repair.
      let otherRepairs = 0;
      fixture.harness.domain.integrity.IntegrityService.register({
         id: 'test-other-rename',
         nodeType: 'Field',
         phase: IntegrityPhase.Linked,
         enforce(node: AstNode, document: LangiumDocument): boolean {
            const named = node as AstNode & { name?: string };
            if (rule.repairs < 2 || document !== other || !named.name?.startsWith('back')) {
               return false;
            }
            named.name = `${named.name}Again`;
            otherRepairs++;
            return true;
         }
      });
      await build(fixture, [fixture.orderDocument, other, fixture.processDocument]);
      await settle(fixture);

      expect(otherRepairs).toBeGreaterThan(0);
      expect(fixture.recovery).toHaveBeenCalledTimes(5);
      // One for each document's chain.
      expect(lines.filter(line => line.level === 'warn' && line.message.includes('builds in a row'))).toHaveLength(2);
   });

   it('stops a chain across two languages, with a warning, when their rules never settle', async () => {
      const { tracer, lines } = makeCapturingTracer();
      // Each rule moves its name one step once the other document has caught up, so neither settles alone.
      const workspace = () => fixture.harness.shared.workspace;
      const step = (uri: URI, prefix: string): number | undefined => {
         const document = workspace().LangiumDocuments.getDocument(uri);
         const name =
            document === undefined
               ? undefined
               : AstUtils.streamAst(document.parseResult.value)
                    .map(node => (node as AstNode & { name?: string }).name)
                    .find(candidate => candidate?.startsWith(prefix));
         return name === undefined ? undefined : Number(name.slice(prefix.length) || 0);
      };
      let repairs = 0;
      const follow = (nodeType: string, prefix: string, caughtUp: (own: number) => boolean): IntegrityRule => ({
         id: `test-${nodeType.toLowerCase()}-follow`,
         nodeType,
         phase: IntegrityPhase.Linked,
         enforce(node: AstNode): boolean {
            const named = node as AstNode & { name?: string };
            const own = named.name?.startsWith(prefix) ? Number(named.name.slice(prefix.length) || 0) : undefined;
            if (own === undefined || !caughtUp(own)) {
               return false;
            }
            named.name = `${prefix}${own + 1}`;
            repairs++;
            return true;
         }
      });
      // `broken` never resolves, and Langium relinks a document with a linking error in every build.
      const fixture = setUp(
         follow('Field', 'extra', own => own === step(fixture.processDocument.uri, 'Ship')),
         {
            syncMode: 'silent',
            orderSource: REPAIRABLE_SOURCE.replace('extra: string', 'extra: string\n   broken: Missing'),
            harnessOptions: { extraSharedModules: [{ Tracer: () => tracer }] }
         }
      );
      fixture.harness.process.integrity.IntegrityService.register(
         follow('Task', 'Ship', own => step(fixture.orderDocument.uri, 'extra') === own + 1)
      );
      await build(fixture, [fixture.processDocument, fixture.orderDocument]);
      await settle(fixture);

      expect(repairs).toBeGreaterThan(3);
      expect(fixture.recovery).toHaveBeenCalledTimes(4);
      // One for each document's chain.
      expect(lines.filter(line => line.level === 'warn' && line.message.includes('builds in a row'))).toHaveLength(2);
   });

   it('relinks every dependent, with no warning, when unrelated documents are repaired while the builds of the others run', async () => {
      const { tracer, lines } = makeCapturingTracer();
      const rule = renameRule();
      const fixture = setUp(rule, {
         syncMode: 'silent',
         orderSource: CLEAN_SOURCE,
         harnessOptions: { extraSharedModules: [{ Tracer: () => tracer }] }
      });
      const workspace = fixture.harness.shared.workspace;
      const add = (name: string, text: string): LangiumDocument<DomainModel> => {
         writeFileSync(join(folder, name), text);
         const document = workspace.LangiumDocumentFactory.fromString<DomainModel>(text, URI.file(join(folder, name)));
         workspace.LangiumDocuments.addDocument(document);
         return document;
      };
      // Every reference resolves, as a linking error would relink a document in every build.
      const targetText = (index: number, extra = ''): string =>
         `enum S${index} { A }\n\nentity T${index} {\n   status: S${index}\n${extra}}\n`;
      const targets = [0, 1, 2, 3, 4].map(index => add(`t${index}.domain`, targetText(index)));
      const dependents = targets.map((_target, index) => add(`u${index}.domain`, `entity U${index} {\n   up: T${index}\n}\n`));
      await build(fixture, [...targets, ...dependents]);
      const builder = workspace.DocumentBuilder;
      const edit = (index: number): Promise<void> => {
         writeFileSync(targets[index].uri.fsPath, targetText(index, `   extra: S${index}\n`));
         return builder.scheduleUpdate([targets[index].uri], []);
      };
      // Each target is edited as the build that relinks the previous one's dependents starts.
      let next = 1;
      const update = builder.update.bind(builder);
      vi.spyOn(builder, 'update').mockImplementation((changed, deleted, token) => {
         const previous = fixture.recovery.mock.calls.some(([uri]) => uri.toString() === targets[next - 1]?.uri.toString());
         if (next < targets.length && previous && changed.some(uri => uri.toString() === targets[next - 1].uri.toString())) {
            edits.push(edit(next++));
         }
         return update(changed, deleted, token);
      });
      const edits = [edit(0)];
      for (let waited = 0; waited < edits.length;) {
         const pending = edits.slice(waited);
         waited = edits.length;
         await Promise.all(pending);
         await settle(fixture);
      }

      expect(rule.repairs).toBe(5);
      expect(lines.filter(line => line.level === 'warn')).toHaveLength(0);
      const up = (dependent: LangiumDocument<DomainModel>): AstNode | undefined => {
         const entity = dependent.parseResult.value.declarations.find(isEntity);
         const field = entity?.fields.find(candidate => candidate.name === 'up');
         return field?.type.declared?.ref;
      };
      expect(dependents.map(dependent => up(dependent)?.$container)).toEqual(targets.map(target => target.parseResult.value));
   });

   it('extends no chain with a build that relinks dependents while that build waits to start', async () => {
      const { tracer, lines } = makeCapturingTracer();
      // A chain of one, so a repair that continues the waiting build's chain warns.
      class ChainOfOne extends DefaultIntegrityService {
         protected override readonly maxRelinkChain: number = 1;
      }
      const fixture = setUp(renameRule(), {
         syncMode: 'silent',
         integrityService: ChainOfOne,
         harnessOptions: { extraSharedModules: [{ Tracer: () => tracer }] }
      });
      // Every requested build passes its check and then waits, so none starts.
      const waiting: Array<() => void> = [];
      fixture.recovery.mockImplementation((_uri, request) => {
         request.stillNeeded();
         return new Promise<void>(resolve => waiting.push(resolve));
      });
      await build(fixture, [fixture.orderDocument, fixture.processDocument]);
      fixture.harness.process.integrity.IntegrityService.register({
         id: 'test-task-rename',
         nodeType: 'Task',
         phase: IntegrityPhase.Linked,
         enforce(node: AstNode): boolean {
            const named = node as AstNode & { name?: string };
            if (named.name !== 'Ship') {
               return false;
            }
            named.name = 'Shipped';
            return true;
         }
      });
      // Repairs the process document, which references the order document whose build waits.
      await fixture.harness.shared.workspace.DocumentBuilder.scheduleUpdate([fixture.processDocument.uri], []);

      expect(fixture.recovery.mock.calls.map(([uri]) => uri.toString())).toEqual([
         fixture.orderDocument.uri.toString(),
         fixture.processDocument.uri.toString()
      ]);
      expect(lines.filter(line => line.level === 'warn')).toHaveLength(0);
      // Settles the held builds, so nothing waits past the test.
      waiting.forEach(resolve => resolve());
   });

   it('starts no chain from a build that relinks dependents once an edit cancels it', async () => {
      const { tracer, lines } = makeCapturingTracer();
      // A chain of one, so a repair that continues the cancelled build's chain warns.
      class ChainOfOne extends DefaultIntegrityService {
         protected override readonly maxRelinkChain: number = 1;
      }
      const fixture = setUp(renameRule(), {
         syncMode: 'silent',
         integrityService: ChainOfOne,
         harnessOptions: { extraSharedModules: [{ Tracer: () => tracer }] }
      });
      const workspace = fixture.harness.shared.workspace;
      const otherText = 'entity Other {\n   back: Order\n}\n';
      const otherUri = URI.file(join(folder, 'other.domain'));
      writeFileSync(otherUri.fsPath, otherText);
      const other = workspace.LangiumDocumentFactory.fromString(otherText, otherUri);
      workspace.LangiumDocuments.addDocument(other);
      // The build that relinks the order document's dependents starts, and an edit of the other document cancels it.
      const update = workspace.DocumentBuilder.update.bind(workspace.DocumentBuilder);
      let edit: Promise<void> | undefined;
      vi.spyOn(workspace.DocumentBuilder, 'update').mockImplementation((changed, deleted, token) => {
         if (edit === undefined && changed.some(uri => uri.toString() === fixture.orderDocument.uri.toString())) {
            writeFileSync(otherUri.fsPath, otherText.replace('back: Order', 'back: Order\n   extra: string'));
            edit = workspace.DocumentBuilder.scheduleUpdate([otherUri], []);
         }
         return update(changed, deleted, token);
      });
      await build(fixture, [fixture.orderDocument, fixture.processDocument, other]);
      await settle(fixture);
      await edit;
      await settle(fixture);

      expect(edit).toBeDefined();
      expect(lines.filter(line => line.level === 'warn')).toHaveLength(0);
      expect(fixture.recovery.mock.calls.map(([uri]) => uri.toString())).toContain(otherUri.toString());
   });

   it.each(['silent', 'editor'] as const)(
      'asks for no build after a repair abandoned because an edit replaced the text it came from, which the edit relinks (%s, open)',
      async syncMode => {
         const { tracer, lines } = makeCapturingTracer();
         const rule = renameRule();
         const fixture = setUp(rule, { syncMode, open: true, harnessOptions: { extraSharedModules: [{ Tracer: () => tracer }] } });
         const workspace = fixture.harness.shared.workspace;
         const uri = fixture.orderDocument.uri;
         // The edit lands after the parse the repair comes from, and its own build follows.
         workspace.TextDocuments.applyContentChange(uri.toString(), CLEAN_SOURCE, 'test-client');
         await build(fixture, [fixture.orderDocument, fixture.processDocument]);
         await workspace.DocumentBuilder.scheduleUpdate([uri], []);
         await settle(fixture);
         const current = workspace.LangiumDocuments.getDocument(uri) as LangiumDocument<DomainModel>;

         expect(rule.repairs).toBe(1);
         expect(order(current).fields.map(field => field.name)).toEqual(['status']);
         expect(fixture.recovery).not.toHaveBeenCalled();
         expect(lines.filter(line => line.level === 'warn')).toHaveLength(0);
         expect(fixture.processDocument.parseResult.value.subject.ref).toBe(order(current));
      }
   );

   it('names no rule in the warning when an override of the Linked pass records none', async () => {
      const { tracer, lines } = makeCapturingTracer();
      const linked = renameRule({ again: true });
      // Records itself in every Parsed pass, before the Linked one, and changes nothing.
      const parsed: IntegrityRule = { id: 'test-parsed-noop', nodeType: 'Entity', phase: IntegrityPhase.Parsed, enforce: () => true };
      class UnrecordedLinkedPass extends DefaultIntegrityService {
         override async enforceIntegrity(...args: Parameters<DefaultIntegrityService['enforceIntegrity']>): Promise<boolean> {
            const [document, phase] = args;
            if (phase !== DocumentState.Linked) {
               return super.enforceIntegrity(...args);
            }
            let mutated = false;
            for (const node of AstUtils.streamAst(document.parseResult.value)) {
               mutated = linked.enforce(node) || mutated;
            }
            return mutated;
         }
      }
      const fixture = setUp(parsed, {
         syncMode: 'editor',
         open: true,
         integrityService: UnrecordedLinkedPass,
         harnessOptions: { extraSharedModules: [{ Tracer: () => tracer }] }
      });
      await build(fixture, [fixture.orderDocument, fixture.processDocument]);
      await settle(fixture);

      expect(linked.repairs).toBe(4);
      const warnings = lines.filter(line => line.level === 'warn').map(line => line.message);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatch(/^An integrity rule repaired documents in 3 builds in a row/);
   });

   it('leaves a second repair, of edited text, to the build the first one asked for, while that build waits', async () => {
      const { tracer, lines } = makeCapturingTracer();
      const rule = renameRule();
      const fixture = setUp(rule, {
         syncMode: 'silent',
         orderSource: CLEAN_SOURCE,
         harnessOptions: { extraSharedModules: [{ Tracer: () => tracer }] }
      });
      await build(fixture, [fixture.orderDocument, fixture.processDocument]);
      const workspace = fixture.harness.shared.workspace;
      const uri = fixture.orderDocument.uri;

      // Both builds in one write, so the requested build waits behind them.
      await workspace.WorkspaceLock.write(async token => {
         for (const source of [REPAIRABLE_SOURCE, EDITED_SOURCE]) {
            writeFileSync(uri.fsPath, source);
            await workspace.DocumentBuilder.update([uri], [], token);
         }
      });
      await settle(fixture);

      expect(rule.repairs).toBe(2);
      expect(fixture.recovery).toHaveBeenCalledTimes(1);
      expect(lines.filter(line => line.level === 'warn')).toHaveLength(0);
      expect(fixture.processDocument.parseResult.value.subject.ref).toBe(order(fixture.orderDocument));
   });

   it('leaves a repair to the build it asked for, with no warning, when an edit cancels that build and repairs again', async () => {
      const { tracer, lines } = makeCapturingTracer();
      let fixture: Fixture | undefined = undefined;
      let edited = false;
      // Met first in the build that relinks the dependents, where an edit that brings the field back cancels it.
      const rule = renameRule({
         onRepaired: () => {
            if (!edited && fixture !== undefined) {
               edited = true;
               writeFileSync(fixture.orderDocument.uri.fsPath, REPAIRABLE_SOURCE);
               void fixture.harness.shared.workspace.DocumentBuilder.scheduleUpdate([fixture.orderDocument.uri], []);
            }
         }
      });
      fixture = setUp(rule, { syncMode: 'silent', harnessOptions: { extraSharedModules: [{ Tracer: () => tracer }] } });
      await build(fixture, [fixture.orderDocument, fixture.processDocument]);
      await settle(fixture);

      expect(edited).toBe(true);
      expect(rule.repairs).toBe(2);
      expect(fixture.recovery).toHaveBeenCalledTimes(1);
      expect(lines.filter(line => line.level === 'warn')).toHaveLength(0);
      expect(fixture.processDocument.parseResult.value.subject.ref).toBe(order(fixture.orderDocument));
   });

   // A closed document in `'editor'` mode still has the unrepaired text on disk, so a revert there changes nothing.
   it.each([
      ['changes', 'silent', EDITED_SOURCE, ['status', 'extraRepaired', 'note']],
      ['changes', 'editor', EDITED_SOURCE, ['status', 'extraRepaired', 'note']],
      ['reverts', 'silent', REPAIRABLE_SOURCE, ['status', 'extraRepaired']]
   ] as const)(
      'asks for another build, with no warning, when the text %s while the build after it runs (%s, closed)',
      async (_change, syncMode, source, fields) => {
         const { tracer, lines } = makeCapturingTracer();
         const rule = renameRule();
         const fixture = setUp(rule, { syncMode, harnessOptions: { extraSharedModules: [{ Tracer: () => tracer }] } });
         const builder = fixture.harness.shared.workspace.DocumentBuilder;
         // The build after the repair is the first update. The file changes once it runs, before it parses.
         const update = builder.update.bind(builder);
         vi.spyOn(builder, 'update').mockImplementationOnce((changed, deleted, token) => {
            writeFileSync(fixture.orderDocument.uri.fsPath, source);
            return update(changed, deleted, token);
         });
         await build(fixture, [fixture.orderDocument, fixture.processDocument]);
         await settle(fixture);

         expect(rule.repairs).toBe(2);
         expect(order(fixture.orderDocument).fields.map(field => field.name)).toEqual(fields);
         expect(fixture.recovery).toHaveBeenCalledTimes(2);
         expect(lines.filter(line => line.level === 'warn')).toHaveLength(0);
         expect(fixture.processDocument.parseResult.value.subject.ref).toBe(order(fixture.orderDocument));
      }
   );

   it('asks for another build, with no warning, when the client reverts the text while the build after it runs (editor, open)', async () => {
      const { tracer, lines } = makeCapturingTracer();
      const rule = renameRule();
      const fixture = setUp(rule, { syncMode: 'editor', open: true, harnessOptions: { extraSharedModules: [{ Tracer: () => tracer }] } });
      const workspace = fixture.harness.shared.workspace;
      const uri = fixture.orderDocument.uri.toString();
      // The build after the repair is the first update. The client undoes the repair once it runs, before it parses.
      const update = workspace.DocumentBuilder.update.bind(workspace.DocumentBuilder);
      vi.spyOn(workspace.DocumentBuilder, 'update').mockImplementationOnce((changed, deleted, token) => {
         const version = workspace.TextDocuments.get(uri)!.version + 1;
         workspace.TextDocuments.notifyDidChangeTextDocument({
            textDocument: { uri, version },
            contentChanges: [{ text: REPAIRABLE_SOURCE }]
         });
         return update(changed, deleted, token);
      });
      await build(fixture, [fixture.orderDocument, fixture.processDocument]);
      await settle(fixture);

      expect(rule.repairs).toBe(2);
      expect(fixture.recovery).toHaveBeenCalledTimes(2);
      expect(lines.filter(line => line.level === 'warn')).toHaveLength(0);
      expect(fixture.processDocument.parseResult.value.subject.ref).toBe(order(fixture.orderDocument));
   });

   it('asks for no build after it when no other document references the repaired one', async () => {
      const rule = renameRule();
      const fixture = setUp(rule, { syncMode: 'silent' });
      const workspace = fixture.harness.shared.workspace;
      workspace.LangiumDocuments.deleteDocument(fixture.processDocument.uri);
      const update = vi.spyOn(workspace.DocumentBuilder, 'update');
      await build(fixture, [fixture.orderDocument]);
      await settle(fixture);

      expect(rule.repairs).toBe(1);
      expect(fixture.recovery).toHaveBeenCalledTimes(1);
      expect(update).not.toHaveBeenCalled();
   });

   it('asks for no build when a shed CST replays the repair from disk, after the build it asked for or a later one (editor, closed)', async () => {
      const { tracer, lines } = makeCapturingTracer();
      const clock = makeFakeClock();
      const rule = renameRule();
      const fixture = setUp(rule, { syncMode: 'editor', orderSource: RESOLVING_REPAIRABLE, harnessOptions: shedWhenIdle(tracer, clock) });
      // Idle after every build, so the document sheds its CST before the next one re-reads disk.
      const ended = fixture.harness.shared.workspace.DocumentBuilder.onBuildEnded(() => clock.advance(1));
      await build(fixture, [fixture.orderDocument, fixture.processDocument]);
      await settle(fixture);
      // A later build re-reads the unchanged disk text, as a watcher event would.
      await fixture.harness.shared.workspace.DocumentBuilder.scheduleUpdate([fixture.orderDocument.uri], []);
      await settle(fixture);
      ended.dispose();

      expect(rule.repairs).toBe(3);
      expect(fixture.recovery).toHaveBeenCalledTimes(1);
      expect(lines.filter(line => line.level === 'warn')).toHaveLength(0);
      expect(fixture.processDocument.parseResult.value.subject.ref).toBe(order(fixture.orderDocument));
   });

   it('asks for another build when the client reverts to the unrepaired text after opening a document whose repair was staged (editor)', async () => {
      const { tracer, lines } = makeCapturingTracer();
      const clock = makeFakeClock();
      const rule = renameRule();
      const fixture = setUp(rule, { syncMode: 'editor', orderSource: RESOLVING_REPAIRABLE, harnessOptions: shedWhenIdle(tracer, clock) });
      const workspace = fixture.harness.shared.workspace;
      const uri = fixture.orderDocument.uri.toString();
      // Idle after every build, so the revert re-parses rather than keeping the CST of the same text.
      const ended = workspace.DocumentBuilder.onBuildEnded(() => clock.advance(1));
      await build(fixture, [fixture.orderDocument, fixture.processDocument]);
      await settle(fixture);
      // The open takes the staged repair.
      workspace.TextDocuments.notifyDidOpenTextDocument({
         textDocument: { uri, languageId: 'domain', version: 1, text: RESOLVING_REPAIRABLE }
      });
      await settle(fixture);
      const requested = fixture.recovery.mock.calls.length;
      const version = workspace.TextDocuments.get(uri)!.version + 1;
      workspace.TextDocuments.notifyDidChangeTextDocument({
         textDocument: { uri, version },
         contentChanges: [{ text: RESOLVING_REPAIRABLE }]
      });
      await workspace.DocumentBuilder.scheduleUpdate([fixture.orderDocument.uri], []);
      await settle(fixture);
      ended.dispose();

      expect(rule.repairs).toBe(3);
      expect(fixture.recovery).toHaveBeenCalledTimes(requested + 1);
      expect(lines.filter(line => line.level === 'warn')).toHaveLength(0);
      expect(fixture.processDocument.parseResult.value.subject.ref).toBe(order(fixture.orderDocument));
   });

   it('asks for no build when a shed CST replays a second repair made while the build it asked for waited (editor, closed)', async () => {
      const { tracer, lines } = makeCapturingTracer();
      const clock = makeFakeClock();
      const rule = renameRule();
      const fixture = setUp(rule, { syncMode: 'editor', orderSource: CLEAN_SOURCE, harnessOptions: shedWhenIdle(tracer, clock) });
      const workspace = fixture.harness.shared.workspace;
      await build(fixture, [fixture.orderDocument, fixture.processDocument]);
      const ended = workspace.DocumentBuilder.onBuildEnded(() => clock.advance(1));
      const uri = fixture.orderDocument.uri;
      // Both builds in one write, so the requested build waits behind them.
      await workspace.WorkspaceLock.write(async token => {
         for (const source of [RESOLVING_REPAIRABLE, RESOLVING_EDITED]) {
            writeFileSync(uri.fsPath, source);
            await workspace.DocumentBuilder.update([uri], [], token);
         }
      });
      await settle(fixture);
      // A later build re-reads the unchanged disk text, as a watcher event would.
      await workspace.DocumentBuilder.scheduleUpdate([uri], []);
      await settle(fixture);
      ended.dispose();

      expect(rule.repairs).toBe(4);
      expect(fixture.recovery).toHaveBeenCalledTimes(1);
      expect(lines.filter(line => line.level === 'warn')).toHaveLength(0);
   });

   it.each(REPARSED_ROWS)(
      'keeps no repair to compare a later one with when the document writes its repairs (%s)',
      async (_label, syncMode, open) => {
         class Recording extends DefaultIntegrityService {
            recorded(document: LangiumDocument): string | undefined {
               return this.replayKeys.get(document);
            }
         }
         const fixture = setUp(renameRule(), { syncMode, open, integrityService: Recording });
         await build(fixture, [fixture.orderDocument, fixture.processDocument]);
         await settle(fixture);

         expect(fixture.recovery).toHaveBeenCalledTimes(1);
         const service = fixture.harness.domain.integrity.IntegrityService;
         expect(service instanceof Recording && service.recorded(fixture.orderDocument)).toBeUndefined();
      }
   );

   it('asks for no build after one a deferral held back, for a repair while it waited', async () => {
      const rule = renameRule();
      const fixture = setUp(rule, { syncMode: 'silent', orderSource: CLEAN_SOURCE });
      await build(fixture, [fixture.orderDocument, fixture.processDocument]);
      const workspace = fixture.harness.shared.workspace;
      const uri = fixture.orderDocument.uri;
      // Held back as a deferral would, which never asks whether the build is still needed.
      let release = (): void => undefined;
      fixture.recovery.mockImplementationOnce(() => new Promise<void>(resolve => (release = resolve)));
      await workspace.WorkspaceLock.write(async token => {
         for (const source of [REPAIRABLE_SOURCE, EDITED_SOURCE]) {
            writeFileSync(uri.fsPath, source);
            await workspace.DocumentBuilder.update([uri], [], token);
         }
      });
      release();
      await settle(fixture);

      expect(rule.repairs).toBe(2);
      expect(fixture.recovery).toHaveBeenCalledTimes(1);
   });

   it('relinks its dependents when the relink of the repaired document throws', async () => {
      const rule = renameRule();
      const fixture = setUp(rule, { syncMode: 'silent', orderSource: CLEAN_SOURCE });
      await build(fixture, [fixture.orderDocument, fixture.processDocument]);
      const workspace = fixture.harness.shared.workspace;
      const builder = workspace.DocumentBuilder;
      // Re-parsed, so the dependents hold discarded nodes, and failed before the relink ends.
      vi.spyOn(builder, 'reparseAndRelink').mockImplementationOnce(async (document, token) => {
         await builder.reparse(document, token);
         throw new Error('relink failed');
      });

      writeFileSync(fixture.orderDocument.uri.fsPath, REPAIRABLE_SOURCE);
      await expect(workspace.WorkspaceLock.write(token => builder.update([fixture.orderDocument.uri], [], token))).rejects.toThrow(
         'relink failed'
      );
      await settle(fixture);

      expect(rule.repairs).toBe(1);
      expect(fixture.processDocument.parseResult.value.subject.ref).toBe(order(fixture.orderDocument));
   });
});
