/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * `makeParseSemanticRoot` against a real grammar, which is the only place its
 * claim can be checked.
 *
 * The helper's whole point is the WORKSPACE half — that the parsed text is on
 * the filesystem, not merely in `LangiumDocuments`. A stub tree cannot witness
 * that: it has no parser, and nothing in it reads a file. So this runs on the
 * three-grammar example, over an in-memory writable filesystem, and asserts the
 * two things that only hold with the write:
 *
 * - a rebuild through `DocumentBuilder.update` re-reads the document's text
 *   from the provider, so a document that was parsed but never written comes
 *   back EMPTY and every reference into it breaks;
 * - the workspace walk finds the documents, which is what a project-scoped
 *   reference resolves through.
 *
 * The cross-grammar chain (`.process` → `.domain`) is deliberate rather than
 * incidental: a reference that lives inside one language could resolve from the
 * document registry alone, so it would not discriminate.
 */

import { inMemoryFileSystem } from '@hydranium/core';
import { makeParseSemanticRoot } from '@hydranium/core/testing';
import { AstUtils, URI } from '@hydranium/langium';
import { beforeEach, describe, expect, it } from 'vitest';
import { type DomainModel, type ProcessModel, isDomainModel, isProcessModel } from '../src/language-server/ast.js';
import { createOrderFlowServices, type OrderFlowServices, type OrderFlowSharedServices } from '../src/language-server/order-flow-module.js';

const ROOT = 'file:///workspace';
const DESCRIPTOR_URI = `${ROOT}/orders/orders.domain`;
const DOMAIN_URI = `${ROOT}/orders/order.domain`;
const PROCESS_URI = `${ROOT}/orders/fulfil.process`;

const DESCRIPTOR_TEXT = `project orders

public entity Order {
   id: String
   status: OrderStatus
}

public enum OrderStatus { NEW, DONE }
`;

const DOMAIN_TEXT = `entity Shipment {
   code: String
}
`;

const PROCESS_TEXT = `process Fulfil for Order {
   task Begin writes Order.status = NEW
   task Finish writes Order.status = DONE
   transition Begin -> Finish
}
`;

let shared: OrderFlowSharedServices;
let language: OrderFlowServices;

describe('makeParseSemanticRoot over a real grammar', () => {
   beforeEach(() => {
      const services = createOrderFlowServices({ ...inMemoryFileSystem() });
      shared = services.shared;
      language = services.Domain;
   });

   it('returns the document root when the grammar makes it the semantic root', async () => {
      const parseDomain = makeParseSemanticRoot<DomainModel>(language, isDomainModel);

      const root = await parseDomain(DOMAIN_TEXT, { documentUri: DOMAIN_URI });

      expect(root.$type).toBe('DomainModel');
      expect(root.declarations.map(declaration => declaration.name)).toEqual(['Shipment']);
   });

   it('throws on a syntax error rather than handing back a half-parsed root', async () => {
      const parseDomain = makeParseSemanticRoot<DomainModel>(language, isDomainModel);

      await expect(parseDomain('entity {{{ broken', { documentUri: DOMAIN_URI })).rejects.toThrow(/parser error/);
   });

   it('accepts a deliberately malformed document when the expected error count says so', async () => {
      const parseDomain = makeParseSemanticRoot<DomainModel>(language, isDomainModel);

      // The count, not merely non-zero: a test whose subject IS the malformed
      // input still wants to know when the number of errors moves.
      const root = await parseDomain('entity Broken {', { documentUri: DOMAIN_URI, parserErrors: 1 });

      expect(root.$type).toBe('DomainModel');
   });

   it('throws naming the parse root when nothing matches the guard', async () => {
      const parseProcess = makeParseSemanticRoot<ProcessModel>(language, isProcessModel);

      // A `.domain` document parsed by the domain language cannot contain a
      // ProcessModel, so the guard finds nothing — and the message has to say
      // what it DID find, or the failure reads as a parse failure.
      await expect(parseProcess(DOMAIN_TEXT, { documentUri: DOMAIN_URI })).rejects.toThrow(/parse root is 'DomainModel'/);
   });

   it('puts the text on the filesystem, so a rebuild re-reads it and cross-grammar references survive', async () => {
      const parseDomain = makeParseSemanticRoot<DomainModel>(language, isDomainModel);
      const parseProcess = makeParseSemanticRoot<ProcessModel>(shared.ServiceRegistry.getServices(URI.parse(PROCESS_URI)), isProcessModel);

      await parseDomain(DESCRIPTOR_TEXT, { documentUri: DESCRIPTOR_URI });
      await parseDomain(DOMAIN_TEXT, { documentUri: DOMAIN_URI });
      const process = await parseProcess(PROCESS_TEXT, { documentUri: PROCESS_URI });

      // The reference resolves after the parse.
      expect(process.subject.ref?.name).toBe('Order');

      // Now force the framework to go BACK TO THE FILESYSTEM for all three.
      // `DocumentBuilder.update` re-reads each document's text from the
      // provider, so this is the step a parse-only helper cannot survive: with
      // no write, the provider has nothing and the rebuilt documents are empty.
      await shared.workspace.DocumentBuilder.update([URI.parse(DESCRIPTOR_URI), URI.parse(DOMAIN_URI), URI.parse(PROCESS_URI)], []);

      const rebuilt = shared.workspace.LangiumDocuments.getDocument(URI.parse(PROCESS_URI));
      const rebuiltRoot = rebuilt?.parseResult.value as ProcessModel | undefined;
      expect(rebuiltRoot?.name).toBe('Fulfil');
      // The load-bearing assertion: the cross-grammar reference still resolves
      // after the rebuild, which requires BOTH documents' text to have been on
      // the provider.
      expect(rebuiltRoot?.subject.ref?.name).toBe('Order');
   });

   it('leaves the text on the filesystem provider under the document URI', async () => {
      const parseDomain = makeParseSemanticRoot<DomainModel>(language, isDomainModel);

      await parseDomain(DOMAIN_TEXT, { documentUri: DOMAIN_URI });

      // Read straight off the provider, which is the claim in its most direct
      // form and the one every filesystem reader in the framework depends on.
      // Going through the document registry instead would be satisfied by
      // Langium's `parseHelper` alone and prove nothing this helper adds.
      expect(await shared.workspace.FileSystemProvider.readFile(URI.parse(DOMAIN_URI))).toBe(DOMAIN_TEXT);
   });

   it('mints a URI and writes under THAT one when the caller supplies none', async () => {
      const parseDomain = makeParseSemanticRoot<DomainModel>(language, isDomainModel);

      const root = await parseDomain(DOMAIN_TEXT);

      // The write has to land on the URI Langium actually registered the
      // document under. A helper that wrote to a URI it computed itself would
      // leave the two identities diverged, and every filesystem reader would
      // see nothing at the URI the document is keyed by.
      const uri = AstUtils.getDocument(root).uri;
      expect(await shared.workspace.FileSystemProvider.readFile(uri)).toBe(DOMAIN_TEXT);
   });
});
