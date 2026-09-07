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
}

function makeStubProxy(calls: StubCalls): DataServerProtocol<FakeRoot> {
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
         return TransferDocument.create<FakeRoot>(args.uri, 1, {
            $type: 'FakeRoot',
            name: typeof args.model === 'string' ? args.model : 'structured'
         });
      },
      openModelDocument: () => Promise.reject(new Error('not exercised')),
      closeModelDocument: () => Promise.reject(new Error('not exercised')),
      watchModelDocument: () => Promise.reject(new Error('not exercised')),
      unwatchModelDocument: () => Promise.reject(new Error('not exercised')),
      getProjects: () => Promise.reject(new Error('not exercised')),
      getProjectForUri: () => Promise.reject(new Error('not exercised')),
      waitForReady: () => Promise.reject(new Error('not exercised'))
   };
}

function emptyCalls(): StubCalls {
   return { getModelDocument: [], saveModelDocument: [], updateModelDocument: [] };
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
      expect(calls.saveModelDocument).toEqual([{ uri: 'file:///workspace/A.fake', clientId: 'hydranium-cli', model: 'name:literal' }]);
      expect(written).toHaveLength(1);
      const parsed = JSON.parse(written[0]);
      expect(parsed.root.name).toBe('name:literal');
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
