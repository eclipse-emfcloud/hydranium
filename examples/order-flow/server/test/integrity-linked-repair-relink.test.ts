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
 * `Linked` phase resolves into the repaired document's current AST once the
 * build reaches `IntegrityService.SettledState`.
 *
 * The repair relinks its dependents within the build, and adds those the
 * build was not linking. Every sync mode and open state is covered, because
 * they decide whether the repair reaches the text the re-parse reads. A
 * re-parse replaces the document's nodes. A closed document in `'editor'`
 * mode keeps its AST, where the repair renames in place.
 */

import {
   DefaultCstResidencyService,
   DefaultIntegrityService,
   HydraniumDocumentBuilder,
   type IntegrityRule,
   IntegrityPhase,
   type IntegritySyncMode,
   isCstShed
} from '@hydranium/core';
import { makeCapturingTracer } from '@hydranium/core/testing';
import { makeFakeClock } from '@hydranium/protocol/testing';
import {
   type AstNode,
   AstUtils,
   Deferred,
   DocumentState,
   OperationCancelled,
   isMultiReference,
   type LangiumDocument,
   URI
} from '@hydranium/langium';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';
import { type DomainModel, type Entity, isEntity, type ProcessModel } from '../src/language-server/ast.js';
import { CancellationToken, CancellationTokenSource } from 'vscode-languageserver';
import { makeServices, type OrderFlowHarness } from './order-flow-harness.js';

/** The `extra` field is what the rules below rename. */
const REPAIRABLE_SOURCE = `enum OrderStatus { NEW, PAID }

entity Order {
   status: OrderStatus
   extra: string
}
`;
const FULFILLMENT_SOURCE = `process Fulfillment for Order {
   task Ship reads Order.status
}
`;
// Every reference resolves, so the document may shed its CST.
const RESOLVING_REPAIRABLE = REPAIRABLE_SOURCE.replace('extra: string', 'extra: OrderStatus');

/** Counts its repairs. `again` makes it rename its own repair on every pass, a rule that never settles. */
function renameRule(options: { again?: boolean } = {}): IntegrityRule & { repairs: number; armed: boolean } {
   return {
      id: 'test-linked-rename',
      nodeType: 'Field',
      phase: IntegrityPhase.Linked,
      repairs: 0,
      armed: true,
      enforce(node: AstNode): boolean {
         const named = node as AstNode & { name?: string };
         const repairable = options.again ? named.name?.startsWith('extra') : named.name === 'extra';
         if (!this.armed || !repairable) {
            return false;
         }
         named.name = `${named.name}Repaired`;
         this.repairs++;
         return true;
      }
   };
}

/** Renames the `nodeType` node named `from` to `to`, and counts its repairs. */
function renameTarget(nodeType: string, from: string, to: string): IntegrityRule & { repairs: number } {
   return {
      id: `test-linked-rename-${from}`,
      nodeType,
      phase: IntegrityPhase.Linked,
      repairs: 0,
      enforce(node: AstNode): boolean {
         const named = node as AstNode & { name?: string };
         if (named.name !== from) {
            return false;
         }
         named.name = to;
         this.repairs++;
         return true;
      }
   };
}

interface Fixture {
   readonly harness: OrderFlowHarness;
   readonly orderDocument: LangiumDocument<DomainModel>;
   readonly processDocument: LangiumDocument<ProcessModel>;
   /** Every build requested after one, which none of these repairs needs. */
   readonly recovery: MockInstance;
   /** Add a document backed by a real file. */
   create<T extends AstNode>(name: string, text: string): LangiumDocument<T>;
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
      maxRepeatRepairs?: number;
   }
): Fixture {
   const { syncMode, maxRepeatRepairs, open = false, orderSource = REPAIRABLE_SOURCE } = options;
   const harness = makeServices({
      ...options.harnessOptions,
      extraLanguageModules: [
         { integrity: { IntegrityService: services => new DefaultIntegrityService(services, { syncMode, maxRepeatRepairs }) } }
      ]
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
   return { harness, orderDocument, processDocument, recovery, create };
}

async function build(fixture: Fixture, documents: LangiumDocument[]): Promise<void> {
   const workspace = fixture.harness.shared.workspace;
   await workspace.WorkspaceLock.write(token => workspace.DocumentBuilder.build(documents, { validation: true }, token));
}

/** Wait out every build in progress. */
async function settle(fixture: Fixture): Promise<void> {
   const builder = fixture.harness.shared.workspace.DocumentBuilder;
   for (let round = 0; round < 10 && builder.activeBuild !== undefined; round++) {
      await builder.activeBuild;
   }
}

/** What `read` returns at `IntegrityService.SettledState` in every build from now on. */
function atSettled<T>(fixture: Fixture, read: (documents: readonly LangiumDocument[]) => T): T[] {
   const seen: T[] = [];
   fixture.harness.shared.workspace.DocumentBuilder.onBuildPhase(DocumentState.IndexedReferences, documents => {
      seen.push(read(documents));
   });
   return seen;
}

function order(document: LangiumDocument<DomainModel>): Entity {
   const declaration = document.parseResult.value.declarations.find(isEntity);
   if (declaration === undefined) {
      throw new Error('Expected an entity');
   }
   return declaration;
}

/** The references of `dependent` into `repaired` that resolve to a node outside its current AST. */
function stale(dependent: LangiumDocument, repaired: LangiumDocument): string[] {
   const root = repaired.parseResult.value;
   const found: string[] = [];
   for (const reference of dependent.references) {
      if (isMultiReference(reference) || reference.error !== undefined) {
         continue;
      }
      if (reference.$nodeDescription?.documentUri.toString() !== repaired.uri.toString()) {
         continue;
      }
      const target = reference.ref;
      if (target === undefined || AstUtils.findRootNode(target) !== root) {
         found.push(reference.$refText);
      }
   }
   return found;
}

function unresolved(document: LangiumDocument): string[] {
   return document.references.filter(reference => reference.error !== undefined).map(reference => reference.$refText);
}

const MODES = [
   ['silent', false],
   ['silent', true],
   ['editor', false],
   ['editor', true]
] as const;
const MODE_ROWS = MODES.map(([syncMode, open]) => [`${syncMode}, ${open ? 'open' : 'closed'}`, syncMode, open] as const);
// A closed document in `'editor'` mode keeps its AST, so its row would pass without the relink.
const REPARSED_ROWS = MODE_ROWS.filter(([, syncMode, open]) => syncMode === 'silent' || open);

describe('a Linked-phase integrity repair', () => {
   it.each(REPARSED_ROWS)(
      'leaves a dependent resolving into the re-parsed AST at the settled state, with no build after it (%s)',
      async (_label, syncMode, open) => {
         const rule = renameRule();
         const fixture = setUp(rule, { syncMode, open });
         const staleAtSettled = atSettled(fixture, () => stale(fixture.processDocument, fixture.orderDocument));
         await build(fixture, [fixture.orderDocument, fixture.processDocument]);
         await settle(fixture);

         expect(rule.repairs).toBe(1);
         expect(staleAtSettled).toEqual([[]]);
         expect(order(fixture.orderDocument).fields.map(field => field.name)).toEqual(['status', 'extraRepaired']);
         expect(fixture.processDocument.parseResult.value.subject.ref).toBe(order(fixture.orderDocument));
         expect(fixture.recovery).not.toHaveBeenCalled();
      }
   );

   it.each(MODE_ROWS)('leaves a dependent of a renamed target unresolved at the settled state (%s)', async (_label, syncMode, open) => {
      const fixture = setUp(renameTarget('Field', 'status', 'state'), { syncMode, open });
      const unresolvedAtSettled = atSettled(fixture, () => unresolved(fixture.processDocument));
      await build(fixture, [fixture.orderDocument, fixture.processDocument]);
      await settle(fixture);

      expect(unresolvedAtSettled).toEqual([['status']]);
      expect(fixture.recovery).not.toHaveBeenCalled();
   });

   it.each(MODE_ROWS)(
      'indexes a renamed entity by its new name at the settled state, for dependents of either name (%s)',
      async (_label, syncMode, open) => {
         const fixture = setUp(renameTarget('Entity', 'Order', 'Purchase'), { syncMode, open });
         const billing = fixture.create<ProcessModel>(
            'billing.process',
            'process Billing for Purchase {\n   task Bill reads Purchase.status\n}\n'
         );
         const atSettledState = atSettled(fixture, () => ({
            fulfillment: unresolved(fixture.processDocument),
            billing: unresolved(billing),
            billingTarget: billing.parseResult.value.subject.ref === order(fixture.orderDocument)
         }));
         await build(fixture, [fixture.orderDocument, fixture.processDocument, billing]);
         await settle(fixture);

         expect(atSettledState).toEqual([{ fulfillment: ['Order', 'Order', 'status'], billing: [], billingTarget: true }]);
      }
   );

   it.each(['run to the end', 'cancelled before validation'])(
      'adds a dependent the build was not linking, when an update relinks the repaired document only (%s)',
      async label => {
         const cancelled = label === 'cancelled before validation';
         const rule = renameRule();
         rule.armed = false;
         const fixture = setUp(rule, { syncMode: 'silent', orderSource: REPAIRABLE_SOURCE.replace('extra: string', 'extra: Kind') });
         const kind = fixture.create('kind.domain', 'enum Kind { X }\n');
         const builder = fixture.harness.shared.workspace.DocumentBuilder;
         await build(fixture, [fixture.orderDocument, fixture.processDocument, kind]);
         let retry: Promise<void> | undefined;
         const atSettledState = atSettled(fixture, documents => {
            if (cancelled && retry === undefined) {
               // A queued write cancels the update before it validates.
               retry = builder.scheduleUpdate([kind.uri], []);
            }
            return { inBuild: documents.includes(fixture.processDocument), stale: stale(fixture.processDocument, fixture.orderDocument) };
         });

         rule.armed = true;
         writeFileSync(kind.uri.fsPath, 'enum Kind { X, Y }\n');
         await builder.scheduleUpdate([kind.uri], []);
         await retry;
         await settle(fixture);

         expect(rule.repairs).toBe(1);
         expect(atSettledState[0]).toEqual({ inBuild: true, stale: [] });
         expect(fixture.processDocument.state).toBe(DocumentState.Validated);
         expect(fixture.processDocument.parseResult.value.subject.ref).toBe(order(fixture.orderDocument));
         expect(fixture.recovery).not.toHaveBeenCalled();
      }
   );

   it.each([
      ['inside the lock', false, true],
      ['inside the lock, with the dependent built before', true, true],
      ['outside the lock', false, false],
      ['outside the lock, with the dependent built before', true, false]
   ])(
      'adds a dependent to an explicit build of a new copy of the repaired document %s, leaving the caller array alone',
      async (_label, withDependent, locked) => {
         const rule = renameRule();
         rule.armed = false;
         const fixture = setUp(rule, { syncMode: 'silent' });
         const workspace = fixture.harness.shared.workspace;
         await build(fixture, [fixture.orderDocument, fixture.processDocument]);
         workspace.LangiumDocuments.deleteDocument(fixture.orderDocument.uri);
         const copy = fixture.create<DomainModel>('order.domain', REPAIRABLE_SOURCE);
         const staleAtSettled = atSettled(fixture, () => stale(fixture.processDocument, copy));
         const documents: LangiumDocument[] = withDependent ? [copy, fixture.processDocument] : [copy];

         rule.armed = true;
         if (locked) {
            await build(fixture, documents);
         } else {
            await workspace.DocumentBuilder.build(documents, { validation: true });
         }
         await settle(fixture);

         expect(rule.repairs).toBe(1);
         expect(staleAtSettled).toEqual([[]]);
         expect(documents).toHaveLength(withDependent ? 2 : 1);
         expect(fixture.processDocument.state).toBe(DocumentState.Validated);
         expect(fixture.recovery).not.toHaveBeenCalled();
      }
   );

   /** A fixture built once, with a new copy of the repaired document whose build the rule repairs. */
   async function setUpCopy(
      harnessOptions?: Parameters<typeof makeServices>[0],
      syncMode: IntegritySyncMode = 'silent'
   ): Promise<{ fixture: Fixture; copy: LangiumDocument<DomainModel>; rule: ReturnType<typeof renameRule> }> {
      const rule = renameRule();
      rule.armed = false;
      const fixture = setUp(rule, { syncMode, harnessOptions });
      await build(fixture, [fixture.orderDocument, fixture.processDocument]);
      await settle(fixture);
      fixture.harness.shared.workspace.LangiumDocuments.deleteDocument(fixture.orderDocument.uri);
      const copy = fixture.create<DomainModel>('order.domain', REPAIRABLE_SOURCE);
      rule.armed = true;
      return { fixture, copy, rule };
   }

   it('hands a dependent the repair adds to the build to the build-phase passes after integrity', async () => {
      const { fixture, copy, rule } = await setUpCopy();
      const passed: LangiumDocument[][] = [];
      fixture.harness.shared.workspace.BuildPhasePassService.register({
         id: 'test-after-integrity',
         phase: DocumentState.Linked,
         run: async documents => {
            passed.push([...documents]);
         }
      });
      await build(fixture, [copy]);

      expect(rule.repairs).toBe(1);
      expect(passed).toEqual([[copy, fixture.processDocument]]);
   });

   it('validates a dependent the repair adds to the build in every category it ran, after a build that added one', async () => {
      const rule = renameRule();
      rule.armed = false;
      const fixture = setUp(rule, { syncMode: 'silent' });
      const workspace = fixture.harness.shared.workspace;
      const builder = workspace.DocumentBuilder;
      const broken = fixture.create('broken.process', 'process Broken for Order {\n   task Pay reads Order.missing\n}\n');
      const messages = (): string[] => (broken.diagnostics ?? []).map(diagnostic => String(diagnostic.message));
      await workspace.WorkspaceLock.write(token =>
         builder.build([fixture.orderDocument, broken], { validation: { categories: ['built-in', 'fast'] } }, token)
      );
      // Langium stores only the category this build adds as the document's options.
      await workspace.WorkspaceLock.write(token => builder.build([broken], { validation: { categories: ['slow'] } }, token));
      const validated = messages();
      expect(validated.some(message => message.includes('missing'))).toBe(true);
      workspace.LangiumDocuments.deleteDocument(fixture.orderDocument.uri);
      const copy = fixture.create<DomainModel>('order.domain', REPAIRABLE_SOURCE);

      rule.armed = true;
      await workspace.WorkspaceLock.write(token => builder.build([copy], { validation: true }, token));

      expect(rule.repairs).toBe(1);
      expect(stale(broken, copy)).toEqual([]);
      expect(messages()).toEqual(validated);
   });

   it.each<[string, { validation: false | { categories: string[] } }, string[]]>([
      ['a category it did not run', { validation: { categories: ['slow'] } }, ['missing', 'slow check']],
      ['no validation', { validation: false }, ['missing']]
   ])(
      'validates a dependent in the build that requests %s in the categories it ran and those the build requests',
      async (_label, options, expected) => {
         const rule = renameRule();
         rule.armed = false;
         const fixture = setUp(rule, { syncMode: 'silent' });
         const workspace = fixture.harness.shared.workspace;
         const builder = workspace.DocumentBuilder;
         fixture.harness.process.validation.ValidationRegistry.register<{ ProcessModel: ProcessModel }>(
            { ProcessModel: (node, accept) => accept('warning', 'slow check', { node }) },
            undefined,
            'slow'
         );
         const broken = fixture.create('broken.process', 'process Broken for Order {\n   task Pay reads Order.missing\n}\n');
         const messages = (): string[] => (broken.diagnostics ?? []).map(diagnostic => String(diagnostic.message));
         await workspace.WorkspaceLock.write(token =>
            builder.build([fixture.orderDocument, broken], { validation: { categories: ['built-in', 'fast'] } }, token)
         );
         workspace.LangiumDocuments.deleteDocument(fixture.orderDocument.uri);
         const copy = fixture.create<DomainModel>('order.domain', REPAIRABLE_SOURCE);

         rule.armed = true;
         await workspace.WorkspaceLock.write(token => builder.build([copy, broken], options, token));

         expect(rule.repairs).toBe(1);
         expect(stale(broken, copy)).toEqual([]);
         expect(expected.every(text => messages().some(message => message.includes(text)))).toBe(true);
         expect(messages().some(message => message.includes('slow check'))).toBe(expected.includes('slow check'));
      }
   );

   it('validates a dependent that has validated nothing as the build requests, when the repair adds it to the build', async () => {
      const rule = renameRule();
      rule.armed = false;
      const fixture = setUp(rule, { syncMode: 'silent' });
      const workspace = fixture.harness.shared.workspace;
      const builder = workspace.DocumentBuilder;
      const broken = fixture.create('broken.process', 'process Broken for Order {\n   task Pay reads Order.missing\n}\n');
      await workspace.WorkspaceLock.write(token => builder.build([fixture.orderDocument, broken], {}, token));
      expect(broken.diagnostics).toBeUndefined();
      workspace.LangiumDocuments.deleteDocument(fixture.orderDocument.uri);
      const copy = fixture.create<DomainModel>('order.domain', REPAIRABLE_SOURCE);

      rule.armed = true;
      await workspace.WorkspaceLock.write(token => builder.build([copy], { validation: true }, token));

      expect(rule.repairs).toBe(1);
      expect((broken.diagnostics ?? []).some(diagnostic => String(diagnostic.message).includes('missing'))).toBe(true);
   });

   it('runs the rules of a dependent the repair adds to the build, against the repair', async () => {
      const { fixture, copy } = await setUpCopy();
      const seen: (Entity | undefined)[] = [];
      fixture.harness.process.integrity.IntegrityService.register({
         id: 'test-read-subject',
         nodeType: 'ProcessModel',
         phase: IntegrityPhase.Linked,
         enforce(node: AstNode): boolean {
            seen.push((node as ProcessModel).subject.ref);
            return false;
         }
      });
      await build(fixture, [copy]);

      expect(seen).toEqual([order(copy)]);
   });

   it('relinks the dependents of a repair in a build after it when another build without a token overlaps its linking', async () => {
      const { fixture, copy, rule } = await setUpCopy();
      const workspace = fixture.harness.shared.workspace;
      const builder = workspace.DocumentBuilder;
      const otherLinked = new Deferred<void>();
      const otherReleased = new Deferred<void>();
      let paused = false;
      // Holds the first build at its `Linked` phase, so the second links while it runs.
      builder.onBuildPhase(DocumentState.Linked, async () => {
         if (!paused) {
            paused = true;
            otherLinked.resolve();
            await otherReleased.promise;
         }
      });
      const relink = vi.spyOn(builder, 'relinkInRunningBuild');
      const unrelated = fixture.create('other.domain', 'entity Other {\n   status: string\n}\n');
      const other = builder.build([unrelated], { validation: true });
      await otherLinked.promise;
      await builder.build([copy], { validation: true });
      otherReleased.resolve();
      await other;
      await workspace.VersionSyncService.recoveryBuildsSettled();
      await settle(fixture);

      const relinked = await Promise.all(relink.mock.results.map(result => result.value));
      expect(rule.repairs).toBe(1);
      expect(relinked).toContain(false);
      expect(relinked).not.toContain(true);
      expect(stale(fixture.processDocument, copy)).toEqual([]);
      expect(fixture.recovery.mock.calls.map(call => String(call[0]))).toContain(copy.uri.toString());
   });

   it('relinks the dependents of a repair in a build after it when another build without a token starts during its link', async () => {
      const { fixture, copy, rule } = await setUpCopy();
      const workspace = fixture.harness.shared.workspace;
      const builder = workspace.DocumentBuilder;
      const unrelated = fixture.create('other.domain', 'entity Other {\n   status: string\n}\n');
      const [inLink, releaseLink, otherHeld, releaseOther] = [0, 1, 2, 3].map(() => new Deferred<void>());
      let [linkHeld, otherStarted] = [false, false];
      // Holds the repairing build inside its link, before integrity runs, until the other build has started.
      builder.onDocumentPhase(DocumentState.Linked, async document => {
         if (document === copy && !linkHeld) {
            linkHeld = true;
            inLink.resolve();
            await releaseLink.promise;
         }
      });
      // Holds the other build until the repairing one has ended.
      builder.onBuildPhase(DocumentState.IndexedContent, async documents => {
         if (documents.includes(unrelated) && !otherStarted) {
            otherStarted = true;
            otherHeld.resolve();
            await releaseOther.promise;
         }
      });
      const relink = vi.spyOn(builder, 'relinkInRunningBuild');
      const repairing = builder.build([copy], { validation: true });
      await inLink.promise;
      const other = builder.build([unrelated], { validation: true });
      await otherHeld.promise;
      releaseLink.resolve();
      await repairing;
      releaseOther.resolve();
      await other;
      await workspace.VersionSyncService.recoveryBuildsSettled();
      await settle(fixture);

      const relinked = await Promise.all(relink.mock.results.map(result => result.value));
      expect(rule.repairs).toBe(1);
      expect(relinked).not.toContain(true);
      expect(stale(fixture.processDocument, copy)).toEqual([]);
      expect(fixture.recovery.mock.calls.map(call => String(call[0]))).toContain(copy.uri.toString());
   });

   it('leaves a dependent that resolves its references lazily resolving into the repair', async () => {
      const rule = renameRule();
      rule.armed = false;
      const fixture = setUp(rule, { syncMode: 'silent' });
      const workspace = fixture.harness.shared.workspace;
      await build(fixture, [fixture.orderDocument]);
      await workspace.WorkspaceLock.write(token =>
         workspace.DocumentBuilder.build([fixture.processDocument], { eagerLinking: false }, token)
      );
      const subject = fixture.processDocument.parseResult.value.subject;
      expect(subject.ref).toBe(order(fixture.orderDocument));

      rule.armed = true;
      // Built again explicitly, so no update resets the lazy dependent first.
      workspace.DocumentBuilder.resetToState(fixture.orderDocument, DocumentState.Changed);
      fixture.orderDocument.state = DocumentState.Changed;
      await build(fixture, [fixture.orderDocument]);

      expect(rule.repairs).toBe(1);
      expect(fixture.processDocument.state).toBeLessThan(DocumentState.Linked);
      expect(subject.ref).toBe(order(fixture.orderDocument));
   });

   it('validates a validated dependent that resolves its references lazily again, without linking it or running its rules', async () => {
      const rule = renameRule();
      rule.armed = false;
      const fixture = setUp(rule, { syncMode: 'silent' });
      const workspace = fixture.harness.shared.workspace;
      let processRuns = 0;
      fixture.harness.process.integrity.IntegrityService.register({
         id: 'test-linked-process-runs',
         nodeType: 'ProcessModel',
         phase: IntegrityPhase.Linked,
         enforce(): boolean {
            processRuns++;
            return false;
         }
      });
      await build(fixture, [fixture.orderDocument]);
      await workspace.WorkspaceLock.write(token =>
         workspace.DocumentBuilder.build([fixture.processDocument], { eagerLinking: false, validation: true }, token)
      );
      expect(fixture.processDocument.state).toBe(DocumentState.Validated);
      const linked: LangiumDocument[] = [];
      workspace.DocumentBuilder.onDocumentPhase(DocumentState.Linked, document => {
         linked.push(document);
      });
      const validate = vi.spyOn(fixture.harness.process.validation.DocumentValidator, 'validateDocument');

      rule.armed = true;
      workspace.DocumentBuilder.resetToState(fixture.orderDocument, DocumentState.Changed);
      fixture.orderDocument.state = DocumentState.Changed;
      await build(fixture, [fixture.orderDocument]);

      expect(rule.repairs).toBe(1);
      expect(validate.mock.calls.map(call => call[0])).toEqual([fixture.processDocument]);
      expect(fixture.processDocument.state).toBe(DocumentState.Validated);
      expect(linked).not.toContain(fixture.processDocument);
      expect(processRuns).toBe(0);
      expect(stale(fixture.processDocument, fixture.orderDocument)).toEqual([]);
      expect(fixture.processDocument.parseResult.value.subject.ref).toBe(order(fixture.orderDocument));
   });

   it('runs a Linked pass that runs before integrity on the dependents again, in a build after the repair', async () => {
      const rule = renameRule();
      const fixture = setUp(rule, { syncMode: 'silent' });
      const seen: (Entity | undefined)[] = [];
      fixture.harness.shared.workspace.BuildPhasePassService.register({
         id: 'test-before-integrity',
         phase: DocumentState.Linked,
         priority: -2000,
         run: async documents => {
            if (documents.includes(fixture.processDocument)) {
               seen.push(fixture.processDocument.parseResult.value.subject.ref);
            }
         }
      });
      await build(fixture, [fixture.orderDocument, fixture.processDocument]);
      await Promise.all(fixture.recovery.mock.results.map(result => result.value));
      await settle(fixture);

      expect(rule.repairs).toBe(1);
      expect(fixture.recovery.mock.calls.map(call => String(call[0]))).toEqual([fixture.orderDocument.uri.toString()]);
      expect(seen.at(-1)).toBe(order(fixture.orderDocument));
   });

   it('requests one build for a Linked pass before integrity after a rule that repairs in every build', async () => {
      const fixture = setUp(renameRule({ again: true }), { syncMode: 'silent' });
      const workspace = fixture.harness.shared.workspace;
      workspace.BuildPhasePassService.register({
         id: 'test-before-integrity',
         phase: DocumentState.Linked,
         priority: -2000,
         run: async () => {}
      });
      await build(fixture, [fixture.orderDocument, fixture.processDocument]);
      // Never settles while each build requests the next.
      await workspace.VersionSyncService.recoveryBuildsSettled();
      await settle(fixture);

      expect(fixture.recovery).toHaveBeenCalledTimes(1);
   });

   it('requests no build after the repair when no Linked pass runs before integrity', async () => {
      const fixture = setUp(renameRule(), { syncMode: 'silent' });
      fixture.harness.shared.workspace.BuildPhasePassService.register({
         id: 'test-after-integrity',
         phase: DocumentState.Linked,
         run: async () => {}
      });
      await build(fixture, [fixture.orderDocument, fixture.processDocument]);

      expect(fixture.recovery).not.toHaveBeenCalled();
   });

   it('links nothing in a build whose token was cancelled before it started', async () => {
      const { fixture, copy, rule } = await setUpCopy();
      const source = new CancellationTokenSource();
      source.cancel();
      await expect(fixture.harness.shared.workspace.DocumentBuilder.build([copy], { validation: true }, source.token)).rejects.toBe(
         OperationCancelled
      );

      expect(copy.state).toBe(DocumentState.Parsed);
      expect(rule.repairs).toBe(0);
   });

   it('relinks a dependent the repair adds to the build when it refreshes cross-document computed scopes', async () => {
      const { fixture, copy, rule } = await setUpCopy({
         extraSharedModules: [
            {
               workspace: {
                  DocumentBuilder: services => new HydraniumDocumentBuilder(services, { refreshCrossDocumentComputedScopes: true })
               }
            }
         ]
      });
      const staleAtSettled = atSettled(fixture, () => stale(fixture.processDocument, copy));
      await build(fixture, [copy]);

      expect(rule.repairs).toBe(1);
      expect(staleAtSettled).toEqual([[]]);
      expect(fixture.processDocument.state).toBe(DocumentState.Validated);
      expect(fixture.processDocument.localSymbols).toBeDefined();
   });

   it.each([
      ['links eagerly', { validation: true }],
      ['resolves its references lazily', { eagerLinking: false, validation: true }]
   ] as const)(
      're-reads a shed dependent that %s whose CST it cannot graft within the build, and relinks the documents that reference it',
      async (_label, lineOptions) => {
         const clock = makeFakeClock();
         const { fixture, copy, rule } = await setUpCopy({
            extraSharedModules: [
               {
                  Clock: () => clock,
                  workspace: {
                     CstResidencyService: services =>
                        new DefaultCstResidencyService(services, { strategy: { kind: 'shed-closed-when-idle', idleMs: 1 } })
                  }
               }
            ]
         });
         const workspace = fixture.harness.shared.workspace;
         const line = fixture.create('line.domain', 'entity Line {\n   order: Order\n}\n');
         const cart = fixture.create('cart.domain', 'entity Cart {\n   line: Line\n}\n');
         await workspace.WorkspaceLock.write(token => workspace.DocumentBuilder.build([line, cart], { validation: true }, token));
         // Validated again under its own options, which a lazy dependent keeps along with its links.
         await workspace.WorkspaceLock.write(token => workspace.DocumentBuilder.build([line], lineOptions, token));
         clock.advance(1);
         expect(isCstShed(line, workspace.ModelLedger)).toBe(true);
         const residency = workspace.CstResidencyService;
         const rehydrate = residency.rehydrate.bind(residency);
         let refusals = 0;
         // Both grafts of the relink fail, so it re-parses the dependent and replaces its nodes.
         vi.spyOn(residency, 'rehydrate').mockImplementation(document => {
            if (document === line && refusals < 2) {
               refusals++;
               return;
            }
            rehydrate(document);
         });
         const indexed = atSettled(fixture, () => ({
            exports: workspace.IndexManager.allElements()
               .filter(description => description.documentUri.toString() === line.uri.toString())
               .count(),
            stale: [...stale(line, copy), ...stale(cart, line)]
         }));
         await build(fixture, [copy]);

         expect(rule.repairs).toBe(1);
         expect(indexed[0]).toEqual({ exports: 1, stale: [] });
         expect(refusals).toBe(2);
      }
   );

   it('runs the Parsed rules of a shed dependent it re-reads within the build, so a repair staged for it holds (editor, closed)', async () => {
      const clock = makeFakeClock();
      const { fixture, copy, rule } = await setUpCopy(
         {
            extraSharedModules: [
               {
                  Clock: () => clock,
                  workspace: {
                     CstResidencyService: services =>
                        new DefaultCstResidencyService(services, { strategy: { kind: 'shed-closed-when-idle', idleMs: 1 } })
                  }
               }
            ]
         },
         'editor'
      );
      const workspace = fixture.harness.shared.workspace;
      // The Parsed rule renames the second `Spare`, a repair `'editor'` mode stages and disk never sees.
      const line = fixture.create<DomainModel>('line.domain', 'entity Line {\n   order: Order\n}\nentity Spare {\n}\nentity Spare {\n}\n');
      await workspace.WorkspaceLock.write(token => workspace.DocumentBuilder.build([line], { validation: true }, token));
      const repaired = line.parseResult.value.declarations.map(declaration => declaration.name);
      expect(repaired).not.toEqual(['Line', 'Spare', 'Spare']);
      clock.advance(1);
      expect(isCstShed(line, workspace.ModelLedger)).toBe(true);
      const residency = workspace.CstResidencyService;
      const rehydrate = residency.rehydrate.bind(residency);
      let refused = false;
      // The graft of the relink fails, so it re-reads the dependent from disk.
      vi.spyOn(residency, 'rehydrate').mockImplementation(document => {
         if (document === line && !refused) {
            refused = true;
            return;
         }
         rehydrate(document);
      });
      const names = atSettled(fixture, () => line.parseResult.value.declarations.map(declaration => declaration.name));
      await build(fixture, [copy]);
      await settle(fixture);

      expect(refused).toBe(true);
      expect(rule.repairs).toBe(1);
      expect(names[0]).toEqual(repaired);
   });

   it('validates a dependent the repair adds to an explicit build that validates nothing', async () => {
      const { fixture, copy, rule } = await setUpCopy();
      const workspace = fixture.harness.shared.workspace;
      const before = fixture.processDocument.diagnostics;
      await workspace.WorkspaceLock.write(token => workspace.DocumentBuilder.build([copy], { validation: false }, token));

      expect(rule.repairs).toBe(1);
      expect(stale(fixture.processDocument, copy)).toEqual([]);
      // Validated again, so not the diagnostics of the links from before the repair.
      expect(fixture.processDocument.diagnostics).toBeDefined();
      expect(fixture.processDocument.diagnostics).not.toBe(before);
   });

   it('leaves a dependent of a renamed target unresolved when a shed CST replays the repair from disk (editor, closed)', async () => {
      const { tracer, lines } = makeCapturingTracer();
      const clock = makeFakeClock();
      const rule = renameTarget('Field', 'status', 'state');
      const fixture = setUp(rule, {
         syncMode: 'editor',
         orderSource: RESOLVING_REPAIRABLE,
         harnessOptions: {
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
         }
      });
      const builder = fixture.harness.shared.workspace.DocumentBuilder;
      // Idle after every build, so the document sheds its CST before the next one re-reads disk.
      builder.onBuildEnded(() => clock.advance(1));
      const unresolvedAtSettled = atSettled(fixture, () => unresolved(fixture.processDocument));
      await build(fixture, [fixture.orderDocument, fixture.processDocument]);
      await settle(fixture);
      // A later build re-reads the unchanged disk text, as a watcher event would.
      await builder.scheduleUpdate([fixture.orderDocument.uri], []);
      await settle(fixture);

      expect(rule.repairs).toBe(2);
      expect(unresolvedAtSettled).toEqual([['status'], ['status']]);
      expect(unresolved(fixture.processDocument)).toEqual(['status']);
      expect(lines.filter(line => line.level === 'warn')).toHaveLength(0);
   });

   it('runs the rules of a dependent again when they ran before the repair, so they read its links into the repair', async () => {
      const rule = renameRule();
      const fixture = setUp(rule, { syncMode: 'silent' });
      const seen: (Entity | undefined)[] = [];
      fixture.harness.process.integrity.IntegrityService.register({
         id: 'test-read-subject',
         nodeType: 'ProcessModel',
         phase: IntegrityPhase.Linked,
         enforce(node: AstNode): boolean {
            seen.push((node as ProcessModel).subject.ref);
            return false;
         }
      });
      // The process language's batch runs first, before the repair.
      await build(fixture, [fixture.processDocument, fixture.orderDocument]);
      await settle(fixture);

      expect(rule.repairs).toBe(1);
      // The first run read the entity the repair's re-parse replaced.
      expect(seen.map(entity => entity === order(fixture.orderDocument))).toEqual([false, true]);
   });

   it.each([
      [3, undefined],
      [1, 1]
   ])(
      'stops two documents whose rules repair each other within one build, with a warning, after %s repairs again',
      async (repairs, maxRepeatRepairs) => {
         const { tracer, lines } = makeCapturingTracer();
         const rule = renameRule({ again: true });
         const fixture = setUp(rule, {
            syncMode: 'silent',
            maxRepeatRepairs,
            orderSource: REPAIRABLE_SOURCE.replace('extra: string', 'extra: Other'),
            harnessOptions: { extraSharedModules: [{ Tracer: () => tracer }] }
         });
         const other = fixture.create('other.domain', 'entity Other {\n   extraBack: Order\n}\n');
         await build(fixture, [fixture.orderDocument, other, fixture.processDocument]);
         await settle(fixture);

         // Each document's first repair, then `repairs` more for each.
         expect(rule.repairs).toBe(2 * (repairs + 1));
         const warnings = lines.filter(line => line.level === 'warn').map(line => line.message);
         expect(warnings).toHaveLength(1);
         expect(warnings.every(warning => warning.startsWith("Integrity rule 'test-linked-rename' repaired a document"))).toBe(true);
         expect(fixture.recovery).not.toHaveBeenCalled();
      }
   );

   it('reports the last repair of each of two documents whose rules repair each other to the version sequence last', async () => {
      const rule = renameRule({ again: true });
      const fixture = setUp(rule, { syncMode: 'silent', orderSource: REPAIRABLE_SOURCE.replace('extra: string', 'extra: Other') });
      const other = fixture.create('other.domain', 'entity Other {\n   extraBack: Order\n}\n');
      const produced = new Map<string, string>();
      const versionSync = fixture.harness.shared.workspace.VersionSyncService;
      const modelProduced = versionSync.modelProduced.bind(versionSync);
      vi.spyOn(versionSync, 'modelProduced').mockImplementation((document, origin) => {
         if (origin?.text !== undefined) {
            produced.set(document.uri.toString(), origin.text);
         }
         modelProduced(document, origin);
      });
      await build(fixture, [fixture.orderDocument, other]);
      await settle(fixture);

      for (const document of [fixture.orderDocument, other]) {
         expect(produced.get(document.uri.toString())).toBe(readFileSync(document.uri.fsPath, 'utf8'));
      }
   });

   it('re-versions a repaired document when the relink of its dependents throws', async () => {
      const fixture = setUp(renameRule(), { syncMode: 'silent' });
      const workspace = fixture.harness.shared.workspace;
      vi.spyOn(workspace.DocumentBuilder, 'relinkInRunningBuild').mockRejectedValueOnce(new Error('relink failed'));
      const modelProduced = vi.spyOn(workspace.VersionSyncService, 'modelProduced');
      await expect(build(fixture, [fixture.orderDocument, fixture.processDocument])).rejects.toThrow('relink failed');

      expect(modelProduced).toHaveBeenCalledWith(fixture.orderDocument, {
         text: readFileSync(fixture.orderDocument.uri.fsPath, 'utf8')
      });
   });

   it('relinks the dependents of a repair within its build when a build outside the lock linked them meanwhile', async () => {
      const otherBuildEnded = new Deferred<void>();
      const rule = renameRule();
      let stage: 'locked' | 'other' | 'after' = 'locked';
      const fixture = setUp(
         {
            ...rule,
            // The locked build waits at its first node until the other build, which links the same documents, ends.
            async enforce(...args: Parameters<IntegrityRule['enforce']>): Promise<boolean> {
               if (stage === 'locked') {
                  stage = 'other';
                  await otherBuildEnded.promise;
                  stage = 'after';
               }
               return stage === 'after' && (await rule.enforce(...args));
            }
         },
         { syncMode: 'silent' }
      );
      const builder = fixture.harness.shared.workspace.DocumentBuilder;
      const locked = build(fixture, [fixture.orderDocument, fixture.processDocument]);
      await vi.waitUntil(() => stage === 'other');
      await builder.update([fixture.processDocument.uri], [], CancellationToken.None);
      otherBuildEnded.resolve();
      await locked;
      await settle(fixture);

      expect(rule.repairs).toBe(1);
      expect(stale(fixture.processDocument, fixture.orderDocument)).toEqual([]);
   });

   it('leaves a dependent that a build outside the lock is still building to it, and relinks it in a build after both', async () => {
      const repairAllowed = new Deferred<void>();
      const rule = renameRule();
      let stage: 'locked' | 'other' | 'after' = 'locked';
      const fixture = setUp(
         {
            ...rule,
            // The locked build waits at its first node until the other build has indexed the dependent's references.
            async enforce(...args: Parameters<IntegrityRule['enforce']>): Promise<boolean> {
               if (stage === 'locked') {
                  stage = 'other';
                  await repairAllowed.promise;
                  stage = 'after';
               }
               return stage === 'after' && (await rule.enforce(...args));
            }
         },
         { syncMode: 'silent' }
      );
      const workspace = fixture.harness.shared.workspace;
      const builder = workspace.DocumentBuilder;
      // The other build waits once it indexed the dependent's references, until the locked build has repaired.
      const otherIndexed = new Deferred<void>();
      const otherResumes = new Deferred<void>();
      let pauseOther = false;
      builder.onDocumentPhase(DocumentState.IndexedReferences, async (document, token) => {
         if (pauseOther && token === CancellationToken.None && document === fixture.processDocument) {
            pauseOther = false;
            otherIndexed.resolve();
            await otherResumes.promise;
         }
      });
      // The locked build waits after its Linked passes until the other build ends.
      const lockedLinked = new Deferred<void>();
      const otherEnded = new Deferred<void>();
      let pauseLocked = false;
      builder.onBuildPhase(DocumentState.Linked, async (_documents, token) => {
         if (pauseLocked && token !== CancellationToken.None) {
            pauseLocked = false;
            lockedLinked.resolve();
            await otherEnded.promise;
         }
      });
      const locked = build(fixture, [fixture.orderDocument, fixture.processDocument]);
      await vi.waitUntil(() => stage === 'other');
      pauseOther = true;
      const other = builder.update([fixture.processDocument.uri], [], CancellationToken.None);
      await otherIndexed.promise;
      pauseLocked = true;
      repairAllowed.resolve();
      await lockedLinked.promise;
      otherResumes.resolve();
      await other;
      otherEnded.resolve();
      await locked;
      await workspace.VersionSyncService.recoveryBuildsSettled();
      await settle(fixture);

      expect(rule.repairs).toBe(1);
      expect(stale(fixture.processDocument, fixture.orderDocument)).toEqual([]);
      // Indexed, so an edit of the repaired document relinks it again.
      expect(workspace.IndexManager.isAffected(fixture.processDocument, new Set([fixture.orderDocument.uri.toString()]))).toBe(true);
      expect(fixture.recovery).toHaveBeenCalledTimes(1);
   });

   it('relinks its dependents in a build after it when the relink of the repaired document throws', async () => {
      const rule = renameRule();
      rule.armed = false;
      const fixture = setUp(rule, { syncMode: 'silent' });
      await build(fixture, [fixture.orderDocument, fixture.processDocument]);
      const workspace = fixture.harness.shared.workspace;
      const builder = workspace.DocumentBuilder;
      // Re-parsed, so the dependents hold discarded nodes, and failed before the relink ends.
      vi.spyOn(builder, 'reparseAndRelink').mockImplementationOnce(async (document, token) => {
         await builder.reparse(document, token);
         throw new Error('relink failed');
      });

      rule.armed = true;
      writeFileSync(fixture.orderDocument.uri.fsPath, REPAIRABLE_SOURCE.replace('status:', 'status :'));
      await expect(workspace.WorkspaceLock.write(token => builder.update([fixture.orderDocument.uri], [], token))).rejects.toThrow(
         'relink failed'
      );
      await Promise.all(fixture.recovery.mock.results.map(result => result.value));
      await settle(fixture);

      expect(rule.repairs).toBe(1);
      expect(fixture.recovery).toHaveBeenCalledTimes(1);
      expect(stale(fixture.processDocument, fixture.orderDocument)).toEqual([]);
   });

   it('relinks a dependent in a build after it when its relink within the build throws', async () => {
      const rule = renameRule();
      rule.armed = false;
      const fixture = setUp(rule, { syncMode: 'silent' });
      await build(fixture, [fixture.orderDocument, fixture.processDocument]);
      const workspace = fixture.harness.shared.workspace;
      const linker = fixture.harness.process.references.Linker;
      const link = linker.link.bind(linker);
      let links = 0;
      // The build links the dependent first, and the repair relinks it second.
      vi.spyOn(linker, 'link').mockImplementation(async (document, token) => {
         await link(document, token);
         if (++links === 2) {
            throw new Error('link failed');
         }
      });

      rule.armed = true;
      writeFileSync(fixture.orderDocument.uri.fsPath, REPAIRABLE_SOURCE.replace('status:', 'status :'));
      await expect(
         workspace.WorkspaceLock.write(token => workspace.DocumentBuilder.update([fixture.orderDocument.uri], [], token))
      ).rejects.toThrow('link failed');
      await Promise.all(fixture.recovery.mock.results.map(result => result.value));
      await settle(fixture);

      expect(fixture.recovery.mock.calls.map(call => String(call[0]))).toEqual([fixture.orderDocument.uri.toString()]);
      expect(stale(fixture.processDocument, fixture.orderDocument)).toEqual([]);
      expect(fixture.processDocument.state).toBeGreaterThanOrEqual(DocumentState.Validated);
   });

   it('relinks the dependents after one whose rules throw when run against the repair, in a build after it', async () => {
      const rule = renameRule();
      rule.armed = false;
      const fixture = setUp(rule, { syncMode: 'silent' });
      const billing = fixture.create<ProcessModel>('billing.process', FULFILLMENT_SOURCE.replace('Fulfillment', 'Billing'));
      await build(fixture, [fixture.orderDocument, fixture.processDocument, billing]);
      await settle(fixture);
      fixture.harness.shared.workspace.LangiumDocuments.deleteDocument(fixture.orderDocument.uri);
      const copy = fixture.create<DomainModel>('order.domain', REPAIRABLE_SOURCE);
      let thrown = false;
      fixture.harness.process.integrity.IntegrityService.register({
         id: 'test-throw-once',
         nodeType: 'ProcessModel',
         phase: IntegrityPhase.Linked,
         enforce(): boolean {
            if (rule.armed && !thrown) {
               thrown = true;
               throw new Error('rule failed');
            }
            return false;
         }
      });

      rule.armed = true;
      // The dependents are not in this build, so the repair pulls them in and runs their rules.
      await expect(build(fixture, [copy])).rejects.toThrow('rule failed');
      await Promise.all(fixture.recovery.mock.results.map(result => result.value));
      await settle(fixture);

      expect({ fulfillment: stale(fixture.processDocument, copy), billing: stale(billing, copy) }).toEqual({
         fulfillment: [],
         billing: []
      });
      expect(fixture.recovery.mock.calls.map(call => String(call[0]))).toEqual([copy.uri.toString()]);
   });

   it('requests one build after a relink of the repaired document that throws in every build', async () => {
      const rule = renameRule({ again: true });
      rule.armed = false;
      const fixture = setUp(rule, { syncMode: 'silent' });
      await build(fixture, [fixture.orderDocument, fixture.processDocument]);
      const workspace = fixture.harness.shared.workspace;
      const builder = workspace.DocumentBuilder;
      vi.spyOn(builder, 'reparseAndRelink').mockImplementation(async (document, token) => {
         await builder.reparse(document, token);
         throw new Error('relink failed');
      });

      rule.armed = true;
      await expect(workspace.WorkspaceLock.write(token => builder.update([fixture.orderDocument.uri], [], token))).rejects.toThrow(
         'relink failed'
      );
      // Never settles while each failed build requests the next.
      await workspace.VersionSyncService.recoveryBuildsSettled();

      expect(fixture.recovery).toHaveBeenCalledTimes(1);
   });

   it('requests one build after a relink of a dependent that throws in every build', async () => {
      const rule = renameRule({ again: true });
      rule.armed = false;
      const fixture = setUp(rule, { syncMode: 'silent' });
      await build(fixture, [fixture.orderDocument, fixture.processDocument]);
      const workspace = fixture.harness.shared.workspace;
      const builder = workspace.DocumentBuilder;
      const relinkInRunningBuild = builder.relinkInRunningBuild.bind(builder);
      let relinking = false;
      vi.spyOn(builder, 'relinkInRunningBuild').mockImplementation(async (document, cause, cancelToken) => {
         relinking = true;
         try {
            return await relinkInRunningBuild(document, cause, cancelToken);
         } finally {
            relinking = false;
         }
      });
      const linker = fixture.harness.process.references.Linker;
      const link = linker.link.bind(linker);
      // Only the relink after the repair throws, so each build the failure requests repairs again.
      vi.spyOn(linker, 'link').mockImplementation(async (document, token) => {
         if (relinking) {
            throw new Error('relink failed');
         }
         await link(document, token);
      });

      rule.armed = true;
      writeFileSync(fixture.orderDocument.uri.fsPath, REPAIRABLE_SOURCE.replace('status:', 'status :'));
      await expect(
         workspace.WorkspaceLock.write(token => workspace.DocumentBuilder.update([fixture.orderDocument.uri], [], token))
      ).rejects.toThrow('relink failed');
      // Never settles while each failed build requests the next.
      await workspace.VersionSyncService.recoveryBuildsSettled();

      expect(fixture.recovery).toHaveBeenCalledTimes(1);
   });

   it('requests one build after a relink of a dependent only by a linking error that throws in every build', async () => {
      const rule = renameRule({ again: true });
      rule.armed = false;
      const fixture = setUp(rule, { syncMode: 'silent' });
      const broken = fixture.create<ProcessModel>('broken.process', 'process Broken for Missing {\n   task Pay\n}\n');
      await build(fixture, [fixture.orderDocument, fixture.processDocument, broken]);
      expect(unresolved(broken)).toEqual(['Missing']);
      const workspace = fixture.harness.shared.workspace;
      const builder = workspace.DocumentBuilder;
      const relinkInRunningBuild = builder.relinkInRunningBuild.bind(builder);
      // Only the deferred relink throws, after the repaired document's own rules ran without one.
      vi.spyOn(builder, 'relinkInRunningBuild').mockImplementation(async (document, cause, cancelToken) => {
         if (document === broken) {
            throw new Error('relink failed');
         }
         return relinkInRunningBuild(document, cause, cancelToken);
      });

      rule.armed = true;
      writeFileSync(fixture.orderDocument.uri.fsPath, REPAIRABLE_SOURCE.replace('status:', 'status :'));
      await expect(
         workspace.WorkspaceLock.write(token => workspace.DocumentBuilder.update([fixture.orderDocument.uri], [], token))
      ).rejects.toThrow('relink failed');
      // Never settles while each failed build requests the next.
      await workspace.VersionSyncService.recoveryBuildsSettled();

      expect(fixture.recovery).toHaveBeenCalledTimes(1);
   });

   it('relinks the dependents of a document whose repair an edit superseded, once the reconcile replaced its nodes', async () => {
      const rule = renameRule();
      const fixture = setUp(rule, { syncMode: 'silent' });
      // An edit lands on disk between the parse and the repair's commit.
      vi.spyOn(fixture.harness.shared.workspace.TextDocuments, 'commitRepair').mockImplementationOnce(() => {
         writeFileSync(fixture.orderDocument.uri.fsPath, REPAIRABLE_SOURCE.replace('status:', 'status :'));
         return { status: 'stale' };
      });
      const staleAtSettled = atSettled(fixture, () => stale(fixture.processDocument, fixture.orderDocument));
      await build(fixture, [fixture.orderDocument, fixture.processDocument]);
      await settle(fixture);

      expect(rule.repairs).toBe(1);
      expect(staleAtSettled).toEqual([[]]);
   });

   it('requests a build again after a later relink of the repaired document throws, once a build succeeded between', async () => {
      const rule = renameRule();
      rule.armed = false;
      const fixture = setUp(rule, { syncMode: 'silent' });
      await build(fixture, [fixture.orderDocument, fixture.processDocument]);
      const workspace = fixture.harness.shared.workspace;
      const builder = workspace.DocumentBuilder;
      const reparseAndRelink = vi.spyOn(builder, 'reparseAndRelink');
      const failOnce = (): void => {
         reparseAndRelink.mockImplementationOnce(async (document, token) => {
            await builder.reparse(document, token);
            throw new Error('relink failed');
         });
      };
      const repairOnDisk = async (): Promise<void> => {
         writeFileSync(fixture.orderDocument.uri.fsPath, REPAIRABLE_SOURCE);
         await expect(workspace.WorkspaceLock.write(token => builder.update([fixture.orderDocument.uri], [], token))).rejects.toThrow(
            'relink failed'
         );
         await workspace.VersionSyncService.recoveryBuildsSettled();
         await settle(fixture);
      };

      rule.armed = true;
      failOnce();
      await repairOnDisk();
      failOnce();
      await repairOnDisk();

      expect(rule.repairs).toBe(2);
      expect(fixture.recovery).toHaveBeenCalledTimes(2);
      expect(stale(fixture.processDocument, fixture.orderDocument)).toEqual([]);
   });

   it.each([0, 1.5, Number.NaN])('rejects %s as the maxRepeatRepairs option', maxRepeatRepairs => {
      const fixture = setUp(renameRule(), { syncMode: 'silent' });

      expect(() => new DefaultIntegrityService(fixture.harness.domain, { maxRepeatRepairs })).toThrow(RangeError);
   });

   it.each(MODE_ROWS)('relinks no dependent after a Parsed-phase repair (%s)', async (_label, syncMode, open) => {
      const rule: IntegrityRule = { ...renameRule(), phase: IntegrityPhase.Parsed };
      const fixture = setUp(rule, { syncMode, open });
      const relink = vi.spyOn(fixture.harness.shared.workspace.DocumentBuilder, 'relinkInRunningBuild');
      await build(fixture, [fixture.orderDocument, fixture.processDocument]);
      await settle(fixture);

      expect(order(fixture.orderDocument).fields.map(field => field.name)).toEqual(['status', 'extraRepaired']);
      expect(relink).not.toHaveBeenCalled();
   });
});
