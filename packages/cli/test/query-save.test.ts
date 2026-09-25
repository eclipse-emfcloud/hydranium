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

function makeStubProxy(calls: StubCalls, options: { failSave?: boolean; failClose?: boolean } = {}): DataServerProtocol<FakeRoot> {
   return {
      async getModelDocument(args) {
         calls.getModelDocument.push(args);
         return TransferDocument.create<FakeRoot>(args.uri, 1, { $type: 'FakeRoot', name: 'echo', uri: args.uri });
      },
      async updateModelDocument(args) {
         calls.updateModelDocument.push(args);
         return TransferDocument.create<FakeRoot>(args.uri, 1, { $type: 'FakeRoot', name: 'updated' });
      },
      async saveModelDocument(args) {
         calls.saveModelDocument.push(args);
         calls.sequence.push(`save ${args.clientId} ${args.uri}`);
         if (options.failSave) {
            throw new Error('disk refused');
         }
         return TransferDocument.create<FakeRoot>(args.uri, 1, {
            $type: 'FakeRoot',
            name: typeof args.model === 'string' ? args.model : 'structured'
         });
      },
      async openModelDocument(args) {
         calls.sequence.push(`open ${args.clientId} ${args.uri} ${args.text ?? ''}`);
         return TransferDocument.create<FakeRoot>(args.uri, 1, { $type: 'FakeRoot', name: 'opened' });
      },
      async closeModelDocument(args) {
         calls.sequence.push(`close ${args.clientId} ${args.uri}`);
         if (options.failClose) {
            throw new Error('close refused');
         }
      },
      createSession: () => Promise.reject(new Error('not exercised')),
      closeSession: () => Promise.reject(new Error('not exercised')),
      createModelDocument: () => Promise.reject(new Error('not exercised')),
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
         { uri: 'file:///workspace/A.fake', clientId: 'hydranium-cli', model: 'name:literal', basedOn: 'anything' }
      ]);
      expect(written).toHaveLength(1);
      const parsed = JSON.parse(written[0]);
      expect(parsed.root.name).toBe('name:literal');
   });

   it('opens the document with the content before saving, and closes it afterwards, also when the save fails', async () => {
      // Opened with the content as its seed, so a file that does not exist yet
      // is created from it rather than read from disk.
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

      const expected = [
         'open hydranium-cli file:///workspace/A.fake name:literal',
         'save hydranium-cli file:///workspace/A.fake',
         'close hydranium-cli file:///workspace/A.fake'
      ];
      expect(saved.sequence).toEqual(expected);
      expect(failed.sequence).toEqual(expected);
   });

   it("reports a failed save's error, not the failing close after it", async () => {
      await expect(
         runSave({
            serverCommand: 'unused',
            uri: 'file:///workspace/A.fake',
            content: 'name:literal',
            write: () => undefined,
            __proxyForTest: makeStubProxy(emptyCalls(), { failSave: true, failClose: true })
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
