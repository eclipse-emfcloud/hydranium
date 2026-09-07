/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * The `validation.DocumentValidator` slot, over a real adopter boot.
 *
 * # What is pinned
 *
 * `createServerLanguageModule` binds `HydraniumDocumentValidator` on Langium's
 * stock slot, and that binding is what makes its documented capabilities run.
 * Asserted here: that the binding is in place on every language, the `element` /
 * `property` enrichment a form client needs to attach an error to a field, and
 * the whole-document skip for virtual URIs. All against a booted workspace
 * rather than a constructed validator, because a client cannot tell an unbound
 * slot from an enriched-but-empty payload: `TransferEncoder.toTransferDiagnostic`
 * defaults the wire field to `element: diagnostic.element ?? ''`, so losing the
 * binding degrades the payload instead of failing.
 *
 * # Why the assertions are split the way they are
 *
 * The *existence* of the AuditStamp error and its *enrichment* are asserted in
 * separate tests on purpose. Dropping the binding must leave the first green
 * and turn the second red — an existence assertion alone passes under Langium's
 * `DefaultDocumentValidator` too, so on its own it measures that validation
 * runs rather than that the framework validator ran.
 *
 * # Why the virtual-document assertion uses a broken document
 *
 * The real stdlib (`ORDER_FLOW_STDLIB_URI`) is grammar-clean and resolves
 * everything, so it reports zero diagnostics whichever validator is bound and
 * an assertion over it cannot fail. The skip is therefore pinned with a virtual
 * document that WOULD report an error if it were validated.
 */

import { HydraniumDocumentValidator, virtualUri } from '@hydranium/core';
import { URI } from '@hydranium/langium';
import type { Diagnostic } from 'vscode-languageserver';
import { afterEach, describe, expect, it } from 'vitest';
import { type DomainModel, isEntity } from '../src/language-server/ast.js';
import { ORDER_FLOW_STDLIB_URI } from '../src/language-server/order-flow-stdlib.js';
import { WORKSPACE_FILES, makeScratchWorkspaceHarness, type OrderFlowHarness, type ScratchOrderFlowHarness } from './order-flow-harness.js';

/**
 * A `.domain` source whose one reference cannot resolve, so validating it
 * yields exactly one linking diagnostic. Used as VIRTUAL content, which is the
 * only way the virtual-document skip is observable — see the file header.
 */
const UNRESOLVABLE_VIRTUAL_SOURCE = `entity Ghost {
   missing: NoSuchType
}
`;

/**
 * True when `diagnostic` carries the framework validator's protocol-level
 * `element` path. Langium's `DefaultDocumentValidator` produces a plain
 * `Diagnostic`, so this predicate is the binding's observable signature.
 */
function hasElementPath(diagnostic: Diagnostic): diagnostic is Diagnostic & { element: string; property?: string } {
   return 'element' in diagnostic && typeof diagnostic.element === 'string';
}

/**
 * Build `uri` to `Validated` and return its diagnostics.
 *
 * The workspace boots through the editor-equivalent init path, whose
 * `initialBuildOptions` leave `validation` unset — so a suite that reads
 * `document.diagnostics` straight after the harness resolves reads `undefined`
 * for every file, including the deliberate negative.
 */
async function validate(harness: OrderFlowHarness, uri: URI): Promise<Diagnostic[]> {
   const document = await harness.shared.workspace.LangiumDocuments.getOrCreateDocument(uri);
   await harness.shared.workspace.DocumentBuilder.build([document], { validation: true });
   return document.diagnostics ?? [];
}

describe('validation.DocumentValidator — the framework validator on the stock Langium slot', () => {
   let booted: ScratchOrderFlowHarness | undefined;

   afterEach(() => {
      booted?.workspace.dispose();
      booted = undefined;
   });

   /**
    * A scratch copy, because validating rebuilds documents and the integrity
    * service's default `silent` sync mode persists its repairs with
    * `FileSystemProvider.writeFile`.
    */
   async function boot(): Promise<ScratchOrderFlowHarness> {
      booted = await makeScratchWorkspaceHarness();
      return booted;
   }

   it('is bound on every language, not left at Langium default', async () => {
      const { harness } = await boot();

      // Pinned per language: the binding lives in `createServerLanguageModule`,
      // which each of the three grammars composes independently, so a binding
      // moved to one adopter language module would pass a single-language check.
      expect(harness.domain.validation.DocumentValidator).toBeInstanceOf(HydraniumDocumentValidator);
      expect(harness.process.validation.DocumentValidator).toBeInstanceOf(HydraniumDocumentValidator);
      expect(harness.layout.validation.DocumentValidator).toBeInstanceOf(HydraniumDocumentValidator);
   });

   it('still reports the deliberate AuditStamp error at all', async () => {
      // The half that must stay GREEN if the binding is dropped: it proves
      // validation runs, which is what makes the enrichment test below a
      // measurement of the enrichment rather than of validation.
      const { harness, workspace } = await boot();
      const diagnostics = await validate(harness, URI.file(workspace.resolve(WORKSPACE_FILES.auditLeak)));

      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0].message).toContain('AuditStamp');
   });

   it('enriches that error with an element path that resolves back to the offending node', async () => {
      const { harness, workspace } = await boot();
      const uri = URI.file(workspace.resolve(WORKSPACE_FILES.auditLeak));
      const diagnostics = await validate(harness, uri);
      const [diagnostic] = diagnostics;

      expect(hasElementPath(diagnostic)).toBe(true);
      if (!hasElementPath(diagnostic)) {
         return;
      }
      // Not merely non-empty: the path has to round-trip. An empty `element` is
      // what the encoder's fallback produces, and an unresolvable path is just
      // as useless to a client trying to focus the field.
      expect(diagnostic.element).not.toBe('');
      expect(diagnostic.property).toBe('declared');

      const document = harness.shared.workspace.LangiumDocuments.getDocument(uri);
      const root = document?.parseResult.value as DomainModel;
      const shipmentLog = root.declarations[0];
      if (!isEntity(shipmentLog)) {
         throw new Error(`Expected an entity, got ${shipmentLog.$type}`);
      }
      // Identity, not shape: the path names THIS `TypeReference`, the one whose
      // `declared` reference failed, and its container is the `stamp` field.
      const stamp = shipmentLog.fields[0];
      expect(stamp.name).toBe('stamp');
      expect(harness.domain.workspace.AstNodeLocator.getAstNode(root, diagnostic.element)).toBe(stamp.type);
   });

   it('skips a virtual document, so built-in content reports nothing', async () => {
      const { harness } = await boot();
      const uri = virtualUri('order-flow-test', 'unresolvable.domain');
      const document = harness.shared.workspace.LangiumDocumentFactory.fromString(UNRESOLVABLE_VIRTUAL_SOURCE, uri);
      harness.shared.workspace.LangiumDocuments.addDocument(document);
      await harness.shared.workspace.DocumentBuilder.build([document], { validation: true });

      // The document links (its reference is genuinely unresolvable) but is
      // never validated, so nothing is reported on a URI no editor can open.
      expect(document.references.filter(reference => reference.error)).toHaveLength(1);
      expect(document.diagnostics ?? []).toEqual([]);
   });

   it('leaves the real stdlib clean, on the same skip', async () => {
      const { harness } = await boot();
      const stdlib = harness.shared.workspace.LangiumDocuments.getDocument(ORDER_FLOW_STDLIB_URI);

      await harness.shared.workspace.DocumentBuilder.build([stdlib!], { validation: true });
      expect(stdlib?.diagnostics ?? []).toEqual([]);
   });
});
