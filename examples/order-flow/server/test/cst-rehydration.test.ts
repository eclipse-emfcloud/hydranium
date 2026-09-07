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

import { asMutable } from '@hydranium/protocol';
import {
   type AstNode,
   AstUtils,
   type CstNode,
   isReference,
   type LangiumDocument,
   type MultiReference,
   type Reference,
   URI
} from '@hydranium/langium';
import { describe, expect, it } from 'vitest';
import { type DomainModel, type Entity, isEntity, isTask, type ProcessModel, type Task } from '../src/language-server/ast.js';
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

/** Replicate the residency service's shed: null every node's `$cstNode` and every reference's `$refNode`. */
function shed(document: LangiumDocument): void {
   for (const node of AstUtils.streamAst(document.parseResult.value)) {
      asMutable(node).$cstNode = undefined;
   }
   for (const reference of document.references ?? []) {
      asMutable(reference).$refNode = undefined;
   }
}

/** Shed BOTH documents, so a rehydrate of one is never helped by the other. */
function shedBoth(fixture: RehydrationFixture): void {
   shed(fixture.domainDocument);
   shed(fixture.processDocument);
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

describe('CstResidencyService.rehydrate — identity-preserving CST graft', () => {
   // `it.each` substitutes `$<prop>` from the case object, so a title may not
   // spell `$cstNode` / `$refNode` — those render as `undefined`.
   it.each(GRAMMARS)(
      'restores every CST range, AST node identity, the CST→AST back-pointer and every reference range ($label)',
      async ({ label, pick }) => {
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

         expect(fixture.harness.shared.workspace.CstResidencyService.rehydrate(document)).toBe(true);

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

      expect(fixture.harness.shared.workspace.CstResidencyService.rehydrate(fixture.processDocument)).toBe(true);

      for (let i = 0; i < crossGrammar.length; i++) {
         expect(crossGrammar[i].$refNode).toBeDefined();
         expect(rangeKey(crossGrammar[i].$refNode!)).toBe(rangeBefore[i]);
         expect(resolvedTarget(crossGrammar[i])).toBe(targetBefore[i]);
      }
   });

   it.each(GRAMMARS)('is idempotent — a second call is a no-op and keeps the same CST ($label)', async ({ label, pick }) => {
      const fixture = await buildPair(`idempotent-${label.slice(1)}`);
      const document = pick(fixture);
      shedBoth(fixture);

      const residency = fixture.harness.shared.workspace.CstResidencyService;
      expect(residency.rehydrate(document)).toBe(true);
      const rootCst = document.parseResult.value.$cstNode;
      expect(residency.rehydrate(document)).toBe(true);
      expect(document.parseResult.value.$cstNode).toBe(rootCst); // unchanged — early-return on resident CST
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

   it('rehydrates ACROSS the grammar boundary — the .process NameProvider on a shed .domain target', async () => {
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
