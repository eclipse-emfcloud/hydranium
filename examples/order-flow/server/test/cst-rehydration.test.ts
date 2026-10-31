/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * Read-side CST rehydration across a GRAMMAR boundary.
 *
 * `CstResidencyService.rehydrate` re-parses a shed document's retained text and
 * **grafts** the fresh CST onto the resident AST nodes, so every CST reader keeps
 * working without a rebuild. It lives on the SHARED tier, but the two read-side
 * seams that drive it are per-language services — `NameProvider.getNameNode` and
 * `CommentProvider.getComment` — which is the part a single-grammar example
 * cannot test: here a `.process` language's `NameProvider` is asked for the name
 * node of an `Entity` declared in a `.domain` document, which is exactly the
 * shape of a cross-grammar go-to-definition.
 *
 * **Nothing sheds by default.** `CstResidencyOptions.strategy` defaults to
 * `{ kind: 'always-keep' }` and the framework binds the service with no options,
 * so the only way to reach the rehydration path headless is to shed by hand —
 * see {@link shed}, which replicates exactly what the service's own `shed` does.
 * The policy side — when a document is armed for shedding, and what resets or
 * cancels it — is the framework's own concern and is covered by its unit suites,
 * so this suite stays on the graft and the seams that call it.
 */

import { DefaultCstResidencyService, DefaultModelLedger, DefaultVersionSyncService } from '@hydranium/core';
import { asMutable } from '@hydranium/protocol';
import {
   type AstNode,
   AstUtils,
   type CstNode,
   DocumentState,
   isReference,
   type LangiumDocument,
   type MultiReference,
   type Reference,
   URI
} from '@hydranium/langium';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
   type DomainModel,
   type Entity,
   isEntity,
   isEnumeration,
   isTask,
   isWrite,
   type ProcessModel,
   type Task
} from '../src/language-server/ast.js';
import { makeServices, type OrderFlowHarness } from './order-flow-harness.js';

/**
 * A `.domain` declaration carrying a doc comment and a cross-reference of its
 * own (`status: OrderStatus` resolves within the file), so the document has both
 * a name CST on every declared node and a `$refNode`.
 */
const DOMAIN_SOURCE = `/** The order a customer placed. */
entity Order {
   status: OrderStatus
}

enum OrderStatus { NEW, PAID }
`;

/**
 * The `.process` half. Every reference here except the two transition endpoints
 * crosses a grammar boundary into `DOMAIN_SOURCE`: the `for Order` subject, the
 * write's full `entity` → `field` → `literal` chain, and the read's `entity` →
 * `field` pair. A graft that lost a `$refNode` across that boundary is what this
 * pairing exists to catch.
 */
const PROCESS_SOURCE = `/** Fulfilment of a single order. */
process Fulfillment for Order {
   /** Charges the customer. */
   task Pay writes Order.status = PAID
   task Ship reads Order.status
   transition Pay -> Ship
}
`;

interface RehydrationFixture {
   readonly harness: OrderFlowHarness;
   readonly domainDocument: LangiumDocument<DomainModel>;
   readonly processDocument: LangiumDocument<ProcessModel>;
}

/**
 * Boot all three languages and build the `.domain` / `.process` pair in ONE
 * batch. No workspace is needed — the cross-grammar references resolve because
 * both documents share the index the single build populates, and neither carries
 * a `project` header, so their exports land at the framework's `universal` tier.
 */
async function buildPair(slug: string): Promise<RehydrationFixture> {
   const harness = makeServices();
   const factory = harness.shared.workspace.LangiumDocumentFactory;
   const domainDocument = factory.fromString<DomainModel>(DOMAIN_SOURCE, URI.parse(`file:///${slug}.domain`));
   const processDocument = factory.fromString<ProcessModel>(PROCESS_SOURCE, URI.parse(`file:///${slug}.process`));
   const documents: LangiumDocument[] = [domainDocument, processDocument];
   for (const document of documents) {
      harness.shared.workspace.LangiumDocuments.addDocument(document);
   }
   await harness.shared.workspace.DocumentBuilder.build(documents, { validation: true });
   expect(domainDocument.parseResult.parserErrors).toHaveLength(0);
   expect(processDocument.parseResult.parserErrors).toHaveLength(0);
   return { harness, domainDocument, processDocument };
}

/**
 * Replicate the residency service's shed: record the root's text in the ledger,
 * then null every node's `$cstNode` and every reference's `$refNode`.
 */
function shed(harness: OrderFlowHarness, document: LangiumDocument): void {
   const root = document.parseResult.value;
   const ledger = harness.shared.workspace.ModelLedger;
   ledger.record(root, ledger.versionOf(root), ledger.textOf(root));
   for (const node of AstUtils.streamAst(root)) {
      asMutable(node).$cstNode = undefined;
   }
   for (const reference of document.references ?? []) {
      asMutable(reference).$refNode = undefined;
   }
}

/** Shed BOTH documents, so a rehydrate of one is never helped by the other. */
function shedBoth(fixture: RehydrationFixture): void {
   shed(fixture.harness, fixture.domainDocument);
   shed(fixture.harness, fixture.processDocument);
}

/** Position fingerprint shared by `CstNode` and `DocumentSegment` (a reference description's `segment`). */
function rangeKey(segment: Pick<CstNode, 'range' | 'offset' | 'end'>): string {
   return JSON.stringify(segment.range) + `@${segment.offset}-${segment.end}`;
}

/**
 * Every cross-reference of `document`, in the stable order a re-parse reproduces.
 *
 * `streamReferences` yields a node's OWN cross-references only, never its
 * descendants', so the collection has to run per streamed node — the same
 * pairing order the graft relies on.
 */
function collectReferences(document: LangiumDocument): ReadonlyArray<Reference | MultiReference> {
   return [...AstUtils.streamAst(document.parseResult.value)].flatMap(node =>
      [...AstUtils.streamReferences(node)].map(info => info.reference)
   );
}

/**
 * The single resolved target of `reference`, or `undefined` for an unresolved or
 * multi-valued one. None of the three grammars declares a multi-reference, so
 * the guard is a type narrowing rather than a branch this suite exercises.
 */
function resolvedTarget(reference: Reference | MultiReference): AstNode | undefined {
   return isReference(reference) ? reference.ref : undefined;
}

/** The named `Entity` of a built `.domain` document, or a throw naming what was found instead. */
function entityNamed(document: LangiumDocument<DomainModel>, name: string): Entity {
   const declaration = document.parseResult.value.declarations.find(candidate => candidate.name === name);
   if (!isEntity(declaration)) {
      throw new Error(`Expected an entity named ${name}, got ${declaration?.$type ?? 'nothing'}`);
   }
   return declaration;
}

/** The named `Task` of a built `.process` document, or a throw naming what was found instead. */
function taskNamed(document: LangiumDocument<ProcessModel>, name: string): Task {
   const node = document.parseResult.value.nodes.find(candidate => candidate.name === name);
   if (!isTask(node)) {
      throw new Error(`Expected a task named ${name}, got ${node?.$type ?? 'nothing'}`);
   }
   return node;
}

/** The two grammars this suite runs each graft assertion over. */
const GRAMMARS = [
   { label: '.domain', pick: (fixture: RehydrationFixture): LangiumDocument => fixture.domainDocument },
   { label: '.process', pick: (fixture: RehydrationFixture): LangiumDocument => fixture.processDocument }
] as const;

// `[label, row]` tuples so `%s` renders the label bare; `$label` would quote it.
const GRAMMAR_ROWS = GRAMMARS.map(grammar => [grammar.label, grammar] as const);

describe('CstResidencyService.rehydrate identity-preserving CST graft', () => {
   it.each(GRAMMAR_ROWS)(
      'restores every CST range, AST node identity, the CST→AST back-pointer and every reference range (%s)',
      async (_label, { label, pick }) => {
         const fixture = await buildPair(`graft-${label.slice(1)}`);
         const document = pick(fixture);

         // Snapshot before shedding, keyed by the resident AST node identity.
         const nodes: AstNode[] = [...AstUtils.streamAst(document.parseResult.value)];
         expect(nodes.length).toBeGreaterThan(3);
         const rangeBefore = new Map<AstNode, string>();
         for (const node of nodes) {
            expect(node.$cstNode).toBeDefined();
            rangeBefore.set(node, rangeKey(node.$cstNode!));
         }
         const references = collectReferences(document);
         expect(references.length).toBeGreaterThan(0);
         const referenceRangeBefore = references.map(reference => rangeKey(reference.$refNode!));
         // The resolved cross-reference targets — must still be the same objects afterwards.
         const resolvedTargetBefore = references.map(resolvedTarget);
         expect(resolvedTargetBefore.every(target => target !== undefined)).toBe(true);

         shedBoth(fixture);
         expect(document.parseResult.value.$cstNode).toBeUndefined();
         expect(references.every(reference => reference.$refNode === undefined)).toBe(true);

         fixture.harness.shared.workspace.CstResidencyService.rehydrate(document);
         expect(document.parseResult.value.$cstNode).toBeDefined();

         // Identity preserved: streamAst yields the SAME node objects in the same order.
         const nodesAfter = [...AstUtils.streamAst(document.parseResult.value)];
         expect(nodesAfter.length).toBe(nodes.length);
         for (let i = 0; i < nodes.length; i++) {
            const node = nodes[i];
            expect(nodesAfter[i]).toBe(node); // same identity (===)
            expect(node.$cstNode).toBeDefined();
            expect(rangeKey(node.$cstNode!)).toBe(rangeBefore.get(node)); // range identical
            expect(node.$cstNode!.astNode).toBe(node); // CST→AST back-pointer repointed to the resident node
         }

         // References restored to the same range and still resolving to the same target object.
         for (let i = 0; i < references.length; i++) {
            const reference = references[i];
            expect(reference.$refNode).toBeDefined();
            expect(rangeKey(reference.$refNode!)).toBe(referenceRangeBefore[i]);
            expect(resolvedTarget(reference)).toBe(resolvedTargetBefore[i]); // resolved link identity untouched
         }
      }
   );

   it('keeps the $refNode and the resolved target of a CROSS-GRAMMAR reference', async () => {
      // `for Order` and the `writes Order.status = PAID` chain resolve into the
      // `.domain` document, so their `$refNode`s come back from a re-parse of the
      // `.process` text while their `.ref`s must keep pointing at the resident
      // `.domain` nodes. A graft that re-linked instead of grafting would swap
      // those targets for the throwaway parse's copies.
      const fixture = await buildPair('cross-grammar');
      const order = entityNamed(fixture.domainDocument, 'Order');
      const crossGrammar = collectReferences(fixture.processDocument).filter(reference => {
         const target = resolvedTarget(reference);
         return target !== undefined && AstUtils.getDocument(target).uri.path.endsWith('.domain');
      });
      expect(crossGrammar.length).toBeGreaterThanOrEqual(4); // subject + entity + field + literal, at least
      expect(crossGrammar.some(reference => resolvedTarget(reference) === order)).toBe(true);
      const rangeBefore = crossGrammar.map(reference => rangeKey(reference.$refNode!));
      const targetBefore = crossGrammar.map(resolvedTarget);

      shedBoth(fixture);

      fixture.harness.shared.workspace.CstResidencyService.rehydrate(fixture.processDocument);

      for (let i = 0; i < crossGrammar.length; i++) {
         expect(crossGrammar[i].$refNode).toBeDefined();
         expect(rangeKey(crossGrammar[i].$refNode!)).toBe(rangeBefore[i]);
         expect(resolvedTarget(crossGrammar[i])).toBe(targetBefore[i]);
      }
   });

   it.each(GRAMMAR_ROWS)('is idempotent, a second call being a no-op that keeps the same CST (%s)', async (_label, { label, pick }) => {
      const fixture = await buildPair(`idempotent-${label.slice(1)}`);
      const document = pick(fixture);
      shedBoth(fixture);

      const residency = fixture.harness.shared.workspace.CstResidencyService;
      residency.rehydrate(document);
      const rootCst = document.parseResult.value.$cstNode;
      // Pinned, because `toBe(rootCst)` below is satisfied by two `undefined`s:
      // a rehydrate that did nothing would pass the idempotence assertion.
      expect(rootCst).toBeDefined();
      residency.rehydrate(document);
      expect(document.parseResult.value.$cstNode).toBe(rootCst); // unchanged — early-return on resident CST
   });

   it('leaves a document shed, with no node grafted, when one node lost a reference its text still has', async () => {
      const fixture = await buildPair('reference-divergence');
      const typeReference = entityNamed(fixture.domainDocument, 'Order').fields[0].type;
      shedBoth(fixture);
      Reflect.deleteProperty(typeReference, 'declared');

      fixture.harness.shared.workspace.CstResidencyService.rehydrate(fixture.domainDocument);

      const nodes = [...AstUtils.streamAst(fixture.domainDocument.parseResult.value)];
      expect(nodes.every(node => node.$cstNode === undefined)).toBe(true);
   });

   it('leaves a document shed, with no node grafted, when one node has another type than its text parses to', async () => {
      const fixture = await buildPair('type-divergence');
      const order: AstNode = entityNamed(fixture.domainDocument, 'Order');
      shedBoth(fixture);
      asMutable(order).$type = 'Enumeration';

      fixture.harness.shared.workspace.CstResidencyService.rehydrate(fixture.domainDocument);

      const nodes = [...AstUtils.streamAst(fixture.domainDocument.parseResult.value)];
      expect(nodes.every(node => node.$cstNode === undefined)).toBe(true);
   });

   it('leaves a document shed, with no node grafted, when two siblings of one type traded places', async () => {
      const fixture = await buildPair('slot-divergence');
      const status = fixture.domainDocument.parseResult.value.declarations.find(isEnumeration);
      shedBoth(fixture);
      status?.literals.reverse();

      fixture.harness.shared.workspace.CstResidencyService.rehydrate(fixture.domainDocument);

      const nodes = [...AstUtils.streamAst(fixture.domainDocument.parseResult.value)];
      expect(status?.literals).toHaveLength(2);
      expect(nodes.every(node => node.$cstNode === undefined)).toBe(true);
   });

   it('leaves a document shed, with no node grafted, when two siblings of one type traded places and slots', async () => {
      const fixture = await buildPair('restamped-divergence');
      const status = fixture.domainDocument.parseResult.value.declarations.find(isEnumeration);
      shedBoth(fixture);
      status?.literals.reverse();
      status?.literals.forEach((literal, index) => {
         asMutable(literal).$containerIndex = index;
      });

      fixture.harness.shared.workspace.CstResidencyService.rehydrate(fixture.domainDocument);

      const nodes = [...AstUtils.streamAst(fixture.domainDocument.parseResult.value)];
      expect(nodes.every(node => node.$cstNode === undefined)).toBe(true);
   });

   it('leaves a document shed, with no node grafted, when one node has another name than its text', async () => {
      const fixture = await buildPair('value-divergence');
      const order = entityNamed(fixture.domainDocument, 'Order');
      shedBoth(fixture);
      asMutable(order).name = 'Purchase';

      fixture.harness.shared.workspace.CstResidencyService.rehydrate(fixture.domainDocument);

      const nodes = [...AstUtils.streamAst(fixture.domainDocument.parseResult.value)];
      expect(nodes.every(node => node.$cstNode === undefined)).toBe(true);
   });

   it('leaves a document shed, with no node grafted, when one reference has another text than its text', async () => {
      const fixture = await buildPair('reference-text-divergence');
      const typeReference = entityNamed(fixture.domainDocument, 'Order').fields[0].type;
      shedBoth(fixture);
      asMutable(typeReference.declared).$refText = 'Other';

      fixture.harness.shared.workspace.CstResidencyService.rehydrate(fixture.domainDocument);

      const nodes = [...AstUtils.streamAst(fixture.domainDocument.parseResult.value)];
      expect(nodes.every(node => node.$cstNode === undefined)).toBe(true);
   });

   it('leaves a document shed, with no node grafted, when one node holds its references in another property order', async () => {
      const fixture = await buildPair('reference-order-divergence');
      const write = AstUtils.streamAst(fixture.processDocument.parseResult.value).find(isWrite);
      if (write === undefined) {
         throw new Error('the process declares no write');
      }
      shedBoth(fixture);
      // Re-added with its own value, so it now enumerates after `field` and `literal`.
      const entity = write.entity;
      Reflect.deleteProperty(write, 'entity');
      write.entity = entity;

      fixture.harness.shared.workspace.CstResidencyService.rehydrate(fixture.processDocument);

      const nodes = [...AstUtils.streamAst(fixture.processDocument.parseResult.value)];
      expect(nodes.every(node => node.$cstNode === undefined)).toBe(true);
   });

   it('leaves a document shed when its text is not the one its AST was parsed from', async () => {
      const fixture = await buildPair('other-text');
      const root = fixture.domainDocument.parseResult.value;
      const ledger = fixture.harness.shared.workspace.ModelLedger;
      shedBoth(fixture);
      ledger.record(root, ledger.versionOf(root), 'entity Order {}\n');

      fixture.harness.shared.workspace.CstResidencyService.rehydrate(fixture.domainDocument);

      expect(root.$cstNode).toBeUndefined();
   });

   it('grafts the CST of a code-built document from its serialized text, keeping its nodes', () => {
      const harness = makeServices();
      const factory = harness.shared.workspace.LangiumDocumentFactory;
      const model = factory.fromString<DomainModel>(DOMAIN_SOURCE, URI.parse('file:///parsed.domain')).parseResult.value;
      for (const node of AstUtils.streamAst(model)) {
         asMutable(node).$cstNode = undefined;
      }
      const document = factory.fromModel(model, URI.parse('file:///code-built.domain'));
      expect(document.textDocument.getText()).not.toBe('');

      const nodes = [...AstUtils.streamAst(model)];

      harness.shared.workspace.CstResidencyService.rehydrate(document);

      expect(model.$cstNode?.root.fullText).toBe(document.textDocument.getText());
      const after = [...AstUtils.streamAst(document.parseResult.value)];
      expect(after.length === nodes.length && after.every((node, index) => node === nodes[index])).toBe(true);
      expect(nodes.every(node => node.$cstNode?.astNode === node)).toBe(true);
   });

   it('NameProvider.getNameNode transparently rehydrates a shed document in either grammar', async () => {
      // Mirrors go-to-definition / hierarchy: the target node lives in a closed
      // (shed) file and the provider reaches its name through `getNameNode`,
      // running no build. The framework override must restore the CST on demand.
      const fixture = await buildPair('get-name-node');
      const order = entityNamed(fixture.domainDocument, 'Order');
      const pay = taskNamed(fixture.processDocument, 'Pay');
      const orderNameBefore = rangeKey(fixture.harness.domain.references.NameProvider.getNameNode(order)!);
      const payNameBefore = rangeKey(fixture.harness.process.references.NameProvider.getNameNode(pay)!);

      shedBoth(fixture);
      expect(order.$cstNode).toBeUndefined();
      expect(pay.$cstNode).toBeUndefined();

      const orderName = fixture.harness.domain.references.NameProvider.getNameNode(order);
      expect(orderName).toBeDefined();
      expect(rangeKey(orderName!)).toBe(orderNameBefore);

      const payName = fixture.harness.process.references.NameProvider.getNameNode(pay);
      expect(payName).toBeDefined();
      expect(rangeKey(payName!)).toBe(payNameBefore);
   });

   it('rehydrates ACROSS the grammar boundary, for the .process NameProvider on a shed .domain target', async () => {
      // The seam is per-language, the service is shared. An LSP request is
      // dispatched by the language of the REQUESTING document, so a
      // go-to-definition from `fulfillment.process` asks the `.process`
      // `NameProvider` for the name node of an `Entity` that lives in a
      // `.domain` document. That only works because `rehydrateNode` reaches the
      // one shared `CstResidencyService` rather than a per-language one.
      const fixture = await buildPair('cross-grammar-name-node');
      const order = entityNamed(fixture.domainDocument, 'Order');
      const nameBefore = rangeKey(fixture.harness.process.references.NameProvider.getNameNode(order)!);

      shedBoth(fixture);
      expect(order.$cstNode).toBeUndefined();

      const nameNode = fixture.harness.process.references.NameProvider.getNameNode(order);
      expect(nameNode).toBeDefined();
      expect(rangeKey(nameNode!)).toBe(nameBefore);
   });

   it('CommentProvider keeps a shed target doc comment in either grammar (the hover path)', async () => {
      // Hover / completion docs resolve the TARGET node's preceding comment from
      // its `$cstNode` — a read-only request that runs no build, so a shed
      // target's documentation would silently come back empty. The framework's
      // HydraniumCommentProvider restores the CST on demand. Both grammars share
      // the `ML_COMMENT` terminal from `common.langium`, so both are hoverable.
      const fixture = await buildPair('comment');
      const order = entityNamed(fixture.domainDocument, 'Order');
      const pay = taskNamed(fixture.processDocument, 'Pay');
      expect(fixture.harness.domain.documentation.CommentProvider.getComment(order)).toContain('order a customer placed');
      expect(fixture.harness.process.documentation.CommentProvider.getComment(pay)).toContain('Charges the customer');

      shedBoth(fixture);
      expect(order.$cstNode).toBeUndefined();
      expect(pay.$cstNode).toBeUndefined();

      expect(fixture.harness.domain.documentation.CommentProvider.getComment(order)).toContain('order a customer placed');
      expect(fixture.harness.process.documentation.CommentProvider.getComment(pay)).toContain('Charges the customer');
   });

   it('findReferences keeps the declaration of a shed target whose usages are in another grammar', async () => {
      // Rename derives the declaration's own edit from `findReferences` with
      // `includeDeclaration` — Langium's `getSelfReferences` reads the target's
      // name node. For a shed target that read must go through the rehydrating
      // `getNameNode` seam; if the declaration were dropped, rename would edit
      // every `.process` usage but leave the `.domain` declaration itself with
      // the old name, dangling every reference to it.
      const fixture = await buildPair('find-references');
      const order = entityNamed(fixture.domainDocument, 'Order');
      const declarationRange = rangeKey(fixture.harness.domain.references.NameProvider.getNameNode(order)!);
      const processUri = fixture.processDocument.uri.toString();

      shedBoth(fixture);
      expect(order.$cstNode).toBeUndefined();

      const references = fixture.harness.domain.references.References.findReferences(order, { includeDeclaration: true }).toArray();
      // The `.process` usages are index-backed and always survive; the
      // `.domain` declaration is the shed-sensitive entry.
      expect(references.some(description => description.sourceUri.toString() === processUri)).toBe(true);
      const declaration = references.find(description => rangeKey(description.segment) === declarationRange);
      expect(declaration, 'declaration self-reference must survive CST shedding').toBeDefined();
   });
});

/**
 * A chain of three: `order.domain` references `status.domain`, and the
 * `.process` document references `order.domain` only. Changing `status.domain`
 * relinks `order.domain` while the `.process` document stays out of the build.
 */
const STATUS_SOURCE = `enum OrderStatus { NEW, PAID }
`;
const ORDER_SOURCE = `entity Order {
   status: OrderStatus
}
`;
const FULFILLMENT_SOURCE = `process Fulfillment for Order {
   task Ship reads Order.status
}
`;

describe('a shed document re-entering a build without a text change', () => {
   // Real files, because an update and a re-parse read the text from disk.
   let folder = '';
   beforeEach(() => {
      folder = mkdtempSync(join(tmpdir(), 'order-flow-cst-re-entry-'));
   });
   afterEach(() => rmSync(folder, { recursive: true, force: true }));

   async function buildChain(): Promise<{
      harness: OrderFlowHarness;
      statusUri: URI;
      orderDocument: LangiumDocument<DomainModel>;
      processDocument: LangiumDocument<ProcessModel>;
   }> {
      const harness = makeServices();
      const factory = harness.shared.workspace.LangiumDocumentFactory;
      const create = <T extends AstNode>(name: string, text: string): LangiumDocument<T> => {
         writeFileSync(join(folder, name), text);
         const document = factory.fromString<T>(text, URI.file(join(folder, name)));
         harness.shared.workspace.LangiumDocuments.addDocument(document);
         return document;
      };
      const statusDocument = create<DomainModel>('status.domain', STATUS_SOURCE);
      const orderDocument = create<DomainModel>('order.domain', ORDER_SOURCE);
      const processDocument = create<ProcessModel>('fulfillment.process', FULFILLMENT_SOURCE);
      const documents: LangiumDocument[] = [statusDocument, orderDocument, processDocument];
      await harness.shared.workspace.DocumentBuilder.build(documents, { validation: true });
      for (const document of documents) {
         expect(document.references.filter(reference => reference.error !== undefined)).toHaveLength(0);
      }
      return { harness, statusUri: statusDocument.uri, orderDocument, processDocument };
   }

   /** Change `status.domain` on disk and run the update that relinks `order.domain`. */
   async function changeStatus(harness: OrderFlowHarness, statusUri: URI): Promise<void> {
      writeFileSync(statusUri.fsPath, 'enum OrderStatus { NEW, PAID, SHIPPED }\n');
      // Under the lock, as the server builds, so a build it requests waits for this one.
      await harness.shared.workspace.WorkspaceLock.write(token => harness.shared.workspace.DocumentBuilder.update([statusUri], [], token));
   }

   it('keeps its AST nodes, so a dependent outside the build still resolves to them', async () => {
      const { harness, statusUri, orderDocument, processDocument } = await buildChain();
      const order = entityNamed(orderDocument, 'Order');
      const subject = processDocument.parseResult.value.subject;
      expect(subject.ref).toBe(order);

      shed(harness, orderDocument);
      await changeStatus(harness, statusUri);

      expect(orderDocument.parseResult.value.$cstNode).toBeDefined();
      expect(entityNamed(orderDocument, 'Order')).toBe(order);
      expect(subject.ref).toBe(order);
   });

   /**
    * Replace `document` with one built by `fromModel` from its model.
    * A model built in code has neither CST nodes nor `$refNode`s, and its
    * references are linker-built or, from a reference builder, object literals.
    */
   function rebuildFromModel(
      harness: OrderFlowHarness,
      document: LangiumDocument<DomainModel>,
      { literalReferences = false }: { literalReferences?: boolean } = {}
   ): LangiumDocument<DomainModel> {
      const model = document.parseResult.value;
      for (const node of AstUtils.streamAst(model)) {
         asMutable(node).$cstNode = undefined;
         for (const { reference, container, property, index } of [...AstUtils.streamReferences(node)]) {
            asMutable(reference).$refNode = undefined;
            if (literalReferences) {
               const literal = { $refText: reference.$refText, ref: resolvedTarget(reference) };
               const owner: unknown = Reflect.get(container, property);
               Reflect.set(index === undefined || !Array.isArray(owner) ? container : owner, index ?? property, literal);
            }
         }
      }
      const workspace = harness.shared.workspace;
      workspace.LangiumDocuments.deleteDocument(document.uri);
      const codeBuilt = workspace.LangiumDocumentFactory.fromModel(model, document.uri);
      workspace.LangiumDocuments.addDocument(codeBuilt);
      return codeBuilt;
   }

   it.each([
      ['linker-built', false],
      ['object-literal', true]
   ])(
      'keeps the AST nodes of a code-built document with %s references and relinks it when its target changes',
      async (_shape, literalReferences) => {
         const { harness, statusUri, orderDocument, processDocument } = await buildChain();
         const model = orderDocument.parseResult.value;
         const codeBuilt = rebuildFromModel(harness, orderDocument, { literalReferences });
         const statusBefore = harness.shared.workspace.LangiumDocuments.getDocument(statusUri)?.parseResult.value;
         // Until the first build, every reference reads the target its code set.
         const codeSet = collectReferences(codeBuilt).map(reference => resolvedTarget(reference));
         expect(codeSet.length).toBeGreaterThan(0);
         expect(codeSet.every(target => target !== undefined && AstUtils.findRootNode(target) === statusBefore)).toBe(true);

         const workspace = harness.shared.workspace;
         const rebuilt: LangiumDocument[] = [codeBuilt, processDocument];
         await workspace.DocumentBuilder.build(rebuilt, { validation: true });
         expect(codeBuilt.parseResult.value).toBe(model);
         expect(model.$cstNode).toBeDefined();
         const order = entityNamed(codeBuilt, 'Order');
         const subject = processDocument.parseResult.value.subject;
         expect(subject.ref).toBe(order);

         await changeStatus(harness, statusUri);

         expect(codeBuilt.parseResult.value).toBe(model);
         expect(entityNamed(codeBuilt, 'Order')).toBe(order);
         expect(subject.ref).toBe(order);
         const statusRoot = workspace.LangiumDocuments.getDocument(statusUri)?.parseResult.value;
         expect(statusRoot).not.toBe(statusBefore);
         const targets = collectReferences(codeBuilt).map(reference => resolvedTarget(reference));
         expect(targets.length).toBeGreaterThan(0);
         for (const target of targets) {
            expect(target && AstUtils.findRootNode(target)).toBe(statusRoot);
         }
      }
   );

   it('keeps the AST nodes of a model built in code without the defaults the parser fills in, and relinks it', async () => {
      const { harness, statusUri, orderDocument } = await buildChain();
      const workspace = harness.shared.workspace;
      const statusBefore = workspace.LangiumDocuments.getDocument(statusUri)?.parseResult.value as DomainModel;
      // No `many: false`, which a parse of the same text sets.
      const model = {
         $type: 'DomainModel',
         declarations: [
            {
               $type: 'Entity',
               name: 'Order',
               fields: [
                  {
                     $type: 'Field',
                     name: 'status',
                     type: { $type: 'TypeReference', declared: { $refText: 'OrderStatus', ref: statusBefore.declarations[0] } }
                  }
               ]
            }
         ]
      } as unknown as DomainModel;
      workspace.LangiumDocuments.deleteDocument(orderDocument.uri);
      const codeBuilt = workspace.LangiumDocumentFactory.fromModel(model, orderDocument.uri);
      workspace.LangiumDocuments.addDocument(codeBuilt);
      const nodes = [...AstUtils.streamAst(model)];

      await workspace.DocumentBuilder.build([codeBuilt], { validation: true });
      await changeStatus(harness, statusUri);

      const after = [...AstUtils.streamAst(codeBuilt.parseResult.value)];
      expect(after.length === nodes.length && after.every((node, index) => node === nodes[index])).toBe(true);
      const statusRoot = workspace.LangiumDocuments.getDocument(statusUri)?.parseResult.value;
      const targets = collectReferences(codeBuilt).map(reference => resolvedTarget(reference));
      expect(targets).toHaveLength(1);
      expect(targets[0] && AstUtils.findRootNode(targets[0])).toBe(statusRoot);
   });

   it('re-parses a code-built document from its file when the file changes on disk', async () => {
      const { harness, orderDocument } = await buildChain();
      const codeBuilt = rebuildFromModel(harness, orderDocument);
      await harness.shared.workspace.DocumentBuilder.build([codeBuilt], { validation: true });
      const renamed = ORDER_SOURCE.replace('Order', 'Renamed');

      writeFileSync(codeBuilt.uri.fsPath, renamed);
      await harness.shared.workspace.WorkspaceLock.write(token =>
         harness.shared.workspace.DocumentBuilder.update([codeBuilt.uri], [], token)
      );

      expect(codeBuilt.parseResult.value.$cstNode?.root.fullText).toBe(renamed);
      expect(entityNamed(codeBuilt, 'Renamed')).toBeDefined();
   });

   it('re-parses a code-built document from its serialized text when its graft diverges, never reading its URI', async () => {
      const { harness, orderDocument, processDocument } = await buildChain();
      const codeBuilt = rebuildFromModel(harness, orderDocument);
      // No file is left at its URI, so reading it would throw.
      rmSync(codeBuilt.uri.fsPath);
      const model = codeBuilt.parseResult.value;
      const serialized = codeBuilt.textDocument.getText();
      // Changed after serializing, the model no longer pairs with its text.
      entityNamed(codeBuilt, 'Order').name = 'Renamed';

      const recovery = vi.spyOn(harness.shared.workspace.VersionSyncService, 'requestRecoveryBuild');
      const rebuilt: LangiumDocument[] = [codeBuilt, processDocument];
      await harness.shared.workspace.DocumentBuilder.build(rebuilt, { validation: true });
      // The dependents relink in the build after this one.
      await Promise.all(recovery.mock.results.map(result => result.value));

      expect(codeBuilt.parseResult.value).not.toBe(model);
      expect(codeBuilt.parseResult.value.$cstNode?.root.fullText).toBe(serialized);
      expect(processDocument.parseResult.value.subject.ref).toBe(entityNamed(codeBuilt, 'Order'));
   });

   /** Reset `order.domain` to `Changed` once the update has picked its relinks, as a project change does. */
   async function resetToChanged(harness: OrderFlowHarness, document: LangiumDocument): Promise<void> {
      const builder = harness.shared.workspace.DocumentBuilder;
      const listener = builder.onUpdate(() => {
         listener.dispose();
         builder.resetToState(document, DocumentState.Changed);
      });
      await harness.shared.workspace.WorkspaceLock.write(token => builder.update([], [], token));
   }

   it('keeps its AST nodes across a reset to Changed, so a dependent outside the build still resolves to them', async () => {
      const { harness, orderDocument, processDocument } = await buildChain();
      const root = orderDocument.parseResult.value;
      const subject = processDocument.parseResult.value.subject;

      shed(harness, orderDocument);
      await resetToChanged(harness, orderDocument);

      expect(orderDocument.parseResult.value).toBe(root);
      expect(orderDocument.parseResult.value.$cstNode).toBeDefined();
      expect(subject.ref).toBe(entityNamed(orderDocument, 'Order'));
   });

   it('is re-parsed on a reset to Changed when its AST was not parsed from its current text', async () => {
      const { harness, orderDocument } = await buildChain();
      const root = orderDocument.parseResult.value;
      const ledger = harness.shared.workspace.ModelLedger;
      ledger.record(root, ledger.versionOf(root), 'entity Order {}\n');

      shed(harness, orderDocument);
      await resetToChanged(harness, orderDocument);

      expect(orderDocument.parseResult.value).not.toBe(root);
   });

   it('is re-parsed on a reset to Changed after a disk change, without a graft first', async () => {
      const { harness, orderDocument } = await buildChain();
      const root = orderDocument.parseResult.value;
      const rehydrate = vi.spyOn(harness.shared.workspace.CstResidencyService, 'rehydrate');

      shed(harness, orderDocument);
      writeFileSync(orderDocument.uri.fsPath, 'entity Order {\n   state: OrderStatus\n}\n');
      await resetToChanged(harness, orderDocument);

      expect(rehydrate).not.toHaveBeenCalled();
      expect(orderDocument.parseResult.value).not.toBe(root);
      expect(entityNamed(orderDocument, 'Order').fields[0].name).toBe('state');
   });

   /** Open `document` in the store with `text`, as an editor does. */
   function open(harness: OrderFlowHarness, document: LangiumDocument, text: string): void {
      const textDocument = { uri: document.uri.toString(), languageId: 'domain', version: 1, text };
      harness.shared.workspace.TextDocuments.notifyDidOpenTextDocument({ textDocument });
   }

   it('keeps the text a code-built document was edited to in the store once it is closed, never reading its URI', async () => {
      const { harness, orderDocument } = await buildChain();
      const codeBuilt = rebuildFromModel(harness, orderDocument);
      await harness.shared.workspace.DocumentBuilder.build([codeBuilt], { validation: true });
      rmSync(codeBuilt.uri.fsPath);
      const edited = ORDER_SOURCE.replace('Order', 'Purchase');

      open(harness, codeBuilt, edited);
      await resetToChanged(harness, codeBuilt);
      harness.shared.workspace.TextDocuments.notifyDidCloseTextDocument({ textDocument: { uri: codeBuilt.uri.toString() } });
      await resetToChanged(harness, codeBuilt);

      expect(codeBuilt.parseResult.value.$cstNode?.root.fullText).toBe(edited);
      expect(entityNamed(codeBuilt, 'Purchase')).toBeDefined();
   });

   it('keeps its AST nodes across a reset to Changed once opened with the text it was parsed from', async () => {
      const { harness, orderDocument, processDocument } = await buildChain();
      const root = orderDocument.parseResult.value;
      const subject = processDocument.parseResult.value.subject;

      shed(harness, orderDocument);
      open(harness, orderDocument, ORDER_SOURCE);
      await resetToChanged(harness, orderDocument);

      expect(orderDocument.parseResult.value).toBe(root);
      expect(orderDocument.parseResult.value.$cstNode).toBeDefined();
      expect(subject.ref).toBe(entityNamed(orderDocument, 'Order'));
   });

   it('is re-parsed on a reset to Changed once opened with edited text, without a graft first', async () => {
      const { harness, orderDocument } = await buildChain();
      const root = orderDocument.parseResult.value;
      const rehydrate = vi.spyOn(harness.shared.workspace.CstResidencyService, 'rehydrate');

      shed(harness, orderDocument);
      open(harness, orderDocument, 'entity Order {\n   state: OrderStatus\n}\n');
      await resetToChanged(harness, orderDocument);

      expect(rehydrate).not.toHaveBeenCalled();
      expect(orderDocument.parseResult.value).not.toBe(root);
      expect(entityNamed(orderDocument, 'Order').fields[0].name).toBe('state');
   });

   it('re-parses when the graft diverges and relinks the dependents in a build after the update', async () => {
      const { harness, statusUri, orderDocument, processDocument } = await buildChain();
      const subject = processDocument.parseResult.value.subject;
      const recovery = vi.spyOn(harness.shared.workspace.VersionSyncService, 'requestRecoveryBuild');

      shed(harness, orderDocument);
      // An AST that no longer matches its text makes the graft's node count differ.
      orderDocument.parseResult.value.declarations.pop();
      await changeStatus(harness, statusUri);
      await Promise.all(recovery.mock.results.map(result => result.value));

      const order = entityNamed(orderDocument, 'Order');
      expect(order.$cstNode).toBeDefined();
      expect(subject.ref).toBe(order);
      const built = harness.shared.workspace.LangiumDocuments.all.toArray();
      expect(built.map(document => [document.uri.path, document.state])).toEqual(
         built.map(document => [document.uri.path, DocumentState.Validated])
      );
   });

   it('keeps its AST nodes and gets its CST back when a build resumes a validation category', async () => {
      const { harness, orderDocument } = await buildChain();
      const builder = harness.shared.workspace.DocumentBuilder;
      const lock = harness.shared.workspace.WorkspaceLock;
      builder.resetToState(orderDocument, DocumentState.IndexedReferences);
      await lock.write(token => builder.build([orderDocument], { validation: { categories: ['fast'] } }, token));
      const root = orderDocument.parseResult.value;

      shed(harness, orderDocument);
      await lock.write(token => builder.build([orderDocument], { validation: { categories: ['slow'] } }, token));

      expect(orderDocument.parseResult.value).toBe(root);
      expect(root.$cstNode).toBeDefined();
      expect(orderDocument.state).toBe(DocumentState.Validated);
   });

   it('re-parses when the graft is refused and relinks the dependents in a build after the update', async () => {
      const { harness, statusUri, orderDocument, processDocument } = await buildChain();
      const root = orderDocument.parseResult.value;
      const subject = processDocument.parseResult.value.subject;
      const ledger = harness.shared.workspace.ModelLedger;
      const recovery = vi.spyOn(harness.shared.workspace.VersionSyncService, 'requestRecoveryBuild');

      shed(harness, orderDocument);
      ledger.record(root, ledger.versionOf(root), 'entity Order {}\n');
      await changeStatus(harness, statusUri);
      await Promise.all(recovery.mock.results.map(result => result.value));

      expect(orderDocument.parseResult.value).not.toBe(root);
      expect(subject.ref).toBe(entityNamed(orderDocument, 'Order'));
      expect(processDocument.state).toBe(DocumentState.Validated);
   });

   it('re-parses when the graft diverges on a reset to Changed, keeps the build whole and relinks the dependents in a build after it', async () => {
      const { harness, orderDocument, processDocument } = await buildChain();
      const subject = processDocument.parseResult.value.subject;
      const recovery = vi.spyOn(harness.shared.workspace.VersionSyncService, 'requestRecoveryBuild');
      const built = harness.shared.workspace.LangiumDocuments.all.toArray();
      const allValidated = built.map(document => [document.uri.path, DocumentState.Validated]);

      shed(harness, orderDocument);
      orderDocument.parseResult.value.declarations.pop();
      await resetToChanged(harness, orderDocument);

      // The reset came after the update picked its relinks, so a build after it relinks the dependents.
      expect(built.map(document => [document.uri.path, document.state])).toEqual(allValidated);
      await Promise.all(recovery.mock.results.map(result => result.value));
      expect(built.map(document => [document.uri.path, document.state])).toEqual(allValidated);
      expect(subject.ref).toBe(entityNamed(orderDocument, 'Order'));
   });
});

describe('the service slots', () => {
   it('takes a residency service whose constructor subscribes to the document builder', () => {
      let subscribed = false;
      const harness = makeServices({
         extraSharedModules: [
            {
               workspace: {
                  CstResidencyService: services => {
                     services.workspace.DocumentBuilder.onUpdate(() => undefined);
                     subscribed = true;
                     return new DefaultCstResidencyService(services);
                  }
               }
            }
         ]
      });
      expect(harness.shared.workspace.DocumentBuilder).toBeDefined();
      expect(subscribed).toBe(true);
   });

   it('takes a version-sync service whose constructor reads the document builder', () => {
      const harness = makeServices({
         extraSharedModules: [
            {
               workspace: {
                  VersionSyncService: services => {
                     services.workspace.DocumentBuilder.onUpdate(() => undefined);
                     return new DefaultVersionSyncService(services);
                  }
               }
            }
         ]
      });
      expect(harness.shared.workspace.VersionSyncService).toBeInstanceOf(DefaultVersionSyncService);
   });

   it('takes a version-sync service and a ledger whose constructors read the document factory', () => {
      const harness = makeServices({
         extraSharedModules: [
            {
               workspace: {
                  VersionSyncService: services => {
                     expect(services.workspace.LangiumDocumentFactory).toBeDefined();
                     return new DefaultVersionSyncService(services);
                  },
                  ModelLedger: services => {
                     expect(services.workspace.LangiumDocumentFactory).toBeDefined();
                     return new DefaultModelLedger();
                  }
               }
            }
         ]
      });
      expect(harness.shared.workspace.ModelLedger).toBeInstanceOf(DefaultModelLedger);
   });
});
