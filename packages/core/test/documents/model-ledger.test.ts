/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, expect, it } from 'vitest';
import { type AstNode, type LangiumDocument, URI } from '@hydranium/langium';
import { UNRECORDED_VERSION } from '@hydranium/protocol';
import { CancellationToken } from 'vscode-languageserver-protocol';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { DefaultModelLedger } from '../../src/documents/model-ledger.js';
import { DefaultVersionSyncService } from '../../src/documents/version-sync-service.js';
import type { ServerSharedServices } from '../../src/langium/module.js';
import { HydraniumLangiumDocumentFactory } from '../../src/langium/workspace/hydranium-langium-document-factory.js';
import { makeFakeAstNode } from '../../src/testing/fake-document.js';
import { makeNoopTracer } from '../../src/testing/make-test-tracer.js';

const URI_STRING = 'file:///a.x';

/** A root carrying the text it was parsed from, which Langium compares to skip a re-parse. */
function parse(text: string): { value: AstNode; lexerErrors: []; parserErrors: [] } {
   return { value: makeFakeAstNode({ $type: 'Element', $cstNode: { root: { fullText: text } } }), lexerErrors: [], parserErrors: [] };
}

interface Rig {
   readonly factory: HydraniumLangiumDocumentFactory;
   readonly ledger: DefaultModelLedger;
   /** The store's text document, shared with every document the factory builds from it. */
   readonly stored: TextDocument;
   /** `duringParse` runs while the asynchronous parse is in flight. */
   readonly hooks: { duringParse?: () => void };
}

function makeRig(text: string, version: number): Rig {
   const stored = TextDocument.create(URI_STRING, 'x', version, text);
   const hooks: Rig['hooks'] = {};
   const ledger = new DefaultModelLedger();
   const services = {
      Tracer: makeNoopTracer(),
      ServiceRegistry: {
         getServices: () => ({
            LanguageMetaData: { languageId: 'x' },
            parser: {
               LangiumParser: { parse },
               AsyncParser: {
                  parse: async (source: string) => {
                     hooks.duringParse?.();
                     return parse(source);
                  }
               }
            }
         })
      },
      workspace: {
         TextDocuments: { get: (uri: string) => (uri === URI_STRING ? stored : undefined) },
         FileSystemProvider: {},
         ModelLedger: ledger,
         VersionSyncService: undefined as unknown
      }
   } as unknown as ServerSharedServices;
   services.workspace.VersionSyncService = new DefaultVersionSyncService(services);
   return { factory: new HydraniumLangiumDocumentFactory(services), ledger, stored, hooks };
}

function edit(stored: TextDocument, text: string): void {
   TextDocument.update(stored, [{ text }], stored.version + 1);
}

describe('the version the document factory records', () => {
   it('keeps the version a root was parsed from after the store’s text document moves on in place', () => {
      const { factory, ledger, stored } = makeRig('a', 1);
      const document = factory.fromTextDocument(stored, URI.parse(URI_STRING));

      edit(stored, 'a b');

      expect(document.textDocument.version).toBe(2);
      expect(ledger.versionOf(document.parseResult.value)).toBe(1);
   });

   it('keeps an older root’s version once its document re-parses into a new root', async () => {
      const { factory, ledger, stored } = makeRig('a', 1);
      const document: LangiumDocument = factory.fromTextDocument(stored, URI.parse(URI_STRING));
      const older = document.parseResult.value;

      edit(stored, 'a b');
      await factory.update(document, CancellationToken.None);

      expect(document.parseResult.value).not.toBe(older);
      expect({ older: ledger.versionOf(older), current: ledger.versionOf(document.parseResult.value) }).toEqual({ older: 1, current: 2 });
   });

   it('moves the record to the store’s version when the re-parse is skipped for unchanged text', async () => {
      const { factory, ledger, stored } = makeRig('a', 1);
      const document = factory.fromTextDocument(stored, URI.parse(URI_STRING));
      const root = document.parseResult.value;

      edit(stored, 'a');
      await factory.update(document, CancellationToken.None);

      expect(document.parseResult.value).toBe(root);
      expect(ledger.versionOf(root)).toBe(2);
   });

   it('records the version of the text the re-parse read, not of an edit arriving while it runs', async () => {
      const rig = makeRig('a', 1);
      const document = rig.factory.fromTextDocument(rig.stored, URI.parse(URI_STRING));
      edit(rig.stored, 'a b');
      rig.hooks.duringParse = () => edit(rig.stored, 'a b c');

      await rig.factory.update(document, CancellationToken.None);

      expect({ version: rig.stored.version, recorded: rig.ledger.versionOf(document.parseResult.value) }).toEqual({
         version: 3,
         recorded: 2
      });
   });

   it('records the version of the text an asynchronous first parse read, not of an edit arriving while it runs', async () => {
      const rig = makeRig('a', 1);
      rig.hooks.duringParse = () => edit(rig.stored, 'a b');

      const document = await rig.factory.fromTextDocument(rig.stored, URI.parse(URI_STRING), CancellationToken.None);

      expect({ version: rig.stored.version, recorded: rig.ledger.versionOf(document.parseResult.value) }).toEqual({
         version: 2,
         recorded: 1
      });
   });
});

describe('DefaultModelLedger', () => {
   it('answers UNRECORDED_VERSION for a root nothing recorded', () => {
      expect(new DefaultModelLedger().versionOf(makeFakeAstNode({ $type: 'Element' }))).toBe(UNRECORDED_VERSION);
   });

   it('answers the text recorded with the version over the CST’s, and keeps it when only a version is recorded again', () => {
      const ledger = new DefaultModelLedger();
      const root = parse('unrepaired').value;

      ledger.record(root, 1, 'repaired');
      ledger.record(root, 2);

      expect({ text: ledger.textOf(root), version: ledger.versionOf(root) }).toEqual({ text: 'repaired', version: 2 });
   });

   it('answers the CST’s text for a root recorded without one, and none for a root with neither', () => {
      const ledger = new DefaultModelLedger();
      const root = parse('parsed').value;

      ledger.record(root, 1);

      expect({ parsed: ledger.textOf(root), bare: ledger.textOf(makeFakeAstNode({ $type: 'Element' })) }).toEqual({
         parsed: 'parsed',
         bare: undefined
      });
   });

   it('drops the record of a root it marks a placeholder, and tells that root from others', () => {
      const ledger = new DefaultModelLedger();
      const placeholder = parse('').value;
      const parsed = parse('parsed').value;
      ledger.record(placeholder, 3, 'text');
      ledger.record(parsed, 3);

      ledger.markPlaceholder(placeholder);

      expect({
         version: ledger.versionOf(placeholder),
         text: ledger.textOf(placeholder),
         placeholder: ledger.isPlaceholder(placeholder),
         other: ledger.isPlaceholder(parsed)
      }).toEqual({ version: UNRECORDED_VERSION, text: '', placeholder: true, other: false });
   });

   it('keeps one ledger’s records apart from another’s', () => {
      const root = parse('a').value;
      const first = new DefaultModelLedger();
      first.record(root, 4);

      expect({ first: first.versionOf(root), second: new DefaultModelLedger().versionOf(root) }).toEqual({
         first: 4,
         second: UNRECORDED_VERSION
      });
   });
});
