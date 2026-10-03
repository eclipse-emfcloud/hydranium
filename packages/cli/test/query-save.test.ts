/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, expect, it } from 'vitest';
import { TransferDocument } from '@hydranium/protocol';
import type { DataServerProtocol, TransferSaveDocumentArgs, TransferUpdateDocumentArgs } from '@hydranium/protocol/data';
import { runQuery } from '../src/commands/query.js';
import { runSave } from '../src/commands/save.js';

interface FakeRoot {
   readonly $type: 'FakeRoot';
   readonly name: string;
   readonly uri?: string;
}

interface StubCalls {
   getModelDocument: Array<{ uri: string }>;
   saveModelDocument: TransferSaveDocumentArgs<FakeRoot>[];
   updateModelDocument: TransferUpdateDocumentArgs<FakeRoot>[];
   /** The document calls in arrival order, as `method clientId uri`. */
   sequence: string[];
}

function makeStubProxy(
   calls: StubCalls,
   options: { failSave?: boolean; failEnd?: boolean; noFile?: boolean; failCreate?: string; failOpen?: string } = {}
): DataServerProtocol<FakeRoot> {
   return {
      async getModelDocument(args) {
         calls.getModelDocument.push(args);
         return TransferDocument.create<FakeRoot>(args.uri, 1, { $type: 'FakeRoot', name: 'echo', uri: args.uri }, 'hash');
      },
      async updateModelDocument(args) {
         calls.updateModelDocument.push(args);
         return TransferDocument.create<FakeRoot>(args.uri, 1, { $type: 'FakeRoot', name: 'updated' }, 'hash');
      },
      async saveModelDocument(args) {
         calls.saveModelDocument.push(args);
         calls.sequence.push(`save ${args.clientId} ${args.uri}`);
         if (options.failSave) {
            throw new Error('disk refused');
         }
         const saved = TransferDocument.create<FakeRoot>(
            args.uri,
            1,
            {
               $type: 'FakeRoot',
               name: typeof args.model === 'string' ? args.model : 'structured'
            },
            'hash'
         );
         return { ...saved, persisted: { version: 1 } };
      },
      persistModelDocument: () => Promise.reject(new Error('not exercised')),
      async openModelDocument(args) {
         calls.sequence.push(`open ${args.clientId} ${args.uri}`);
         if (options.failOpen) {
            throw new Error(options.failOpen);
         }
         return TransferDocument.create<FakeRoot>(args.uri, 1, { $type: 'FakeRoot', name: 'opened' }, 'hash');
      },
      async createSession(args) {
         calls.sequence.push(`session ${args.clientId}`);
      },
      async closeSession(args) {
         calls.sequence.push(`end ${args.clientId}`);
         if (options.failEnd) {
            throw new Error('end refused');
         }
      },
      async createModelDocument(args) {
         calls.sequence.push(`create ${args.clientId} ${args.uri} ${args.text}`);
         if (options.failCreate) {
            throw new Error(options.failCreate);
         }
         if (!options.noFile) {
            throw new Error(`Cannot create ${args.uri}: the file exists`);
         }
         return TransferDocument.create<FakeRoot>(args.uri, 0, { $type: 'FakeRoot', name: 'created' }, 'hash');
      },
      closeModelDocument: () => Promise.reject(new Error('not exercised')),
      updateModelDocuments: () => Promise.reject(new Error('not exercised')),
      watchModelDocument: () => Promise.reject(new Error('not exercised')),
      unwatchModelDocument: () => Promise.reject(new Error('not exercised')),
      getProjects: () => Promise.reject(new Error('not exercised')),
      getProjectForUri: () => Promise.reject(new Error('not exercised')),
      waitForReady: () => Promise.reject(new Error('not exercised'))
   };
}

function emptyCalls(): StubCalls {
   return { getModelDocument: [], saveModelDocument: [], updateModelDocument: [], sequence: [] };
}

describe('runQuery', () => {
   it('forwards uri and writes the envelope as one JSON line', async () => {
      const calls = emptyCalls();
      const written: string[] = [];
      await runQuery({
         serverCommand: 'unused',
         uri: 'file:///workspace/A.fake',
         write: line => written.push(line),
         __proxyForTest: makeStubProxy(calls)
      });
      expect(calls.getModelDocument).toEqual([{ uri: 'file:///workspace/A.fake', includeDiagnostics: true }]);
      expect(written).toHaveLength(1);
      expect(written[0].endsWith('\n')).toBe(true);
      const parsed = JSON.parse(written[0]);
      expect(parsed.uri).toBe('file:///workspace/A.fake');
   });
});

describe('runSave', () => {
   it('forwards literal content + default clientId', async () => {
      const calls = emptyCalls();
      const written: string[] = [];
      await runSave({
         serverCommand: 'unused',
         uri: 'file:///workspace/A.fake',
         content: 'name:literal',
         write: line => written.push(line),
         __proxyForTest: makeStubProxy(calls)
      });
      expect(calls.saveModelDocument).toEqual([
         { uri: 'file:///workspace/A.fake', clientId: 'hydranium-cli', model: 'name:literal', baseVersion: 'any' }
      ]);
      expect(written).toHaveLength(1);
      const parsed = JSON.parse(written[0]);
      expect(parsed.model.root.name).toBe('name:literal');
   });

   it('saves through a session that opens the document first and ends afterwards, also when the save fails', async () => {
      const saved = emptyCalls();
      await runSave({
         serverCommand: 'unused',
         uri: 'file:///workspace/A.fake',
         content: 'name:literal',
         write: () => undefined,
         __proxyForTest: makeStubProxy(saved)
      });
      const failed = emptyCalls();
      await expect(
         runSave({
            serverCommand: 'unused',
            uri: 'file:///workspace/A.fake',
            content: 'name:literal',
            write: () => undefined,
            __proxyForTest: makeStubProxy(failed, { failSave: true })
         })
      ).rejects.toThrow('disk refused');

      // Created only when the server finds no file; an existing one is opened.
      const expected = [
         'session hydranium-cli',
         'create hydranium-cli file:///workspace/A.fake name:literal',
         'open hydranium-cli file:///workspace/A.fake',
         'save hydranium-cli file:///workspace/A.fake',
         'end hydranium-cli'
      ];
      expect(saved.sequence).toEqual(expected);
      expect(failed.sequence).toEqual(expected);
   });

   it('creates the document from the content when there is no file to open', async () => {
      const calls = emptyCalls();
      await runSave({
         serverCommand: 'unused',
         uri: 'file:///workspace/New.fake',
         content: 'name:literal',
         write: () => undefined,
         __proxyForTest: makeStubProxy(calls, { noFile: true })
      });
      expect(calls.sequence).toEqual([
         'session hydranium-cli',
         'create hydranium-cli file:///workspace/New.fake name:literal',
         'save hydranium-cli file:///workspace/New.fake',
         'end hydranium-cli'
      ]);
   });

   it('reports why the create failed as well, when the open after it fails too', async () => {
      await expect(
         runSave({
            serverCommand: 'unused',
            uri: 'file:///workspace/A.fake',
            content: 'name:literal',
            write: () => undefined,
            __proxyForTest: makeStubProxy(emptyCalls(), { failCreate: 'create refused by policy', failOpen: 'open refused' })
         })
      ).rejects.toThrow(/open refused[\s\S]*create refused by policy/);
   });

   it("reports a failed save's error, not the failing session end after it", async () => {
      await expect(
         runSave({
            serverCommand: 'unused',
            uri: 'file:///workspace/A.fake',
            content: 'name:literal',
            write: () => undefined,
            __proxyForTest: makeStubProxy(emptyCalls(), { failSave: true, failEnd: true })
         })
      ).rejects.toThrow('disk refused');
   });

   it('reads content from @<file> via the injected reader', async () => {
      const calls = emptyCalls();
      const written: string[] = [];
      await runSave({
         serverCommand: 'unused',
         uri: 'file:///workspace/A.fake',
         content: '@/tmp/payload.txt',
         clientId: 'integration-test',
         write: line => written.push(line),
         __proxyForTest: makeStubProxy(calls),
         __readFileForTest: async path => {
            expect(path).toBe('/tmp/payload.txt');
            return 'name:from-file';
         }
      });
      expect(calls.saveModelDocument[0].model).toBe('name:from-file');
      expect(calls.saveModelDocument[0].clientId).toBe('integration-test');
   });

   it('escapes a leading `\\@` so content can legitimately start with `@`', async () => {
      const calls = emptyCalls();
      await runSave({
         serverCommand: 'unused',
         uri: 'file:///workspace/A.fake',
         content: '\\@literal-at-prefix',
         write: () => undefined,
         __proxyForTest: makeStubProxy(calls)
      });
      expect(calls.saveModelDocument[0].model).toBe('@literal-at-prefix');
   });
});
