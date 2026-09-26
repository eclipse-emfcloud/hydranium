/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, expect, it } from 'vitest';
import { type LangiumDocument, URI } from '@hydranium/langium';
import { isVirtualUri, VirtualFileSystemProvider, virtualUri } from '../../../src/langium/workspace/virtual-document.js';
import { type ServerSharedServicesMinimal } from '../../../src/langium/shared-services.js';
import { makeNoopSharedServices } from '../../../src/testing/index.js';

function servicesWith(docs: Record<string, string>): ServerSharedServicesMinimal {
   return makeNoopSharedServices({
      workspace: {
         LangiumDocuments: {
            getDocument(uri: URI): LangiumDocument | undefined {
               const text = docs[uri.toString()];
               return text === undefined ? undefined : ({ uri, textDocument: { getText: () => text } } as unknown as LangiumDocument);
            }
         }
      }
   });
}

describe('virtualUri', () => {
   it('builds a contributor-tagged URI with no segments', () => {
      const uri = virtualUri('stdlib');
      expect(uri.toString()).toBe('virtual:stdlib');
      expect(uri.scheme).toBe('virtual');
      expect(uri.path).toBe('stdlib');
   });

   it('appends segments after the contributor', () => {
      expect(virtualUri('stdlib', 'types', 'Any').toString()).toBe('virtual:stdlib/types/Any');
   });

   it('round-trips cleanly through URI.parse (no percent-encoding)', () => {
      const uri = virtualUri('contrib', 'a', 'b');
      expect(uri.toString()).not.toContain('%');
   });
});

describe('isVirtualUri', () => {
   it('returns true for URIs built by virtualUri', () => {
      expect(isVirtualUri(virtualUri('foo'))).toBe(true);
   });

   it('returns true for any URI with the virtual: scheme', () => {
      expect(isVirtualUri(URI.parse('virtual:bare'))).toBe(true);
   });

   it('returns false for file URIs', () => {
      expect(isVirtualUri(URI.parse('file:///a/b.test'))).toBe(false);
   });
});

/**
 * The framework's provider for `virtual:`. Contract:
 * - a document `LangiumDocuments` holds is served by every read, as a file
 *   carrying the URI asked about, an empty one included;
 * - any other URI is absent: `exists` says so, and the other reads refuse
 *   with a Node-shaped missing-file error;
 * - it has no directories, and refuses every write.
 */
describe('VirtualFileSystemProvider', () => {
   const element = virtualUri('builtin', 'Element');
   const missing = virtualUri('builtin', 'Missing');
   const provider = (docs: Record<string, string> = { [element.toString()]: 'element Element' }): VirtualFileSystemProvider =>
      new VirtualFileSystemProvider(servicesWith(docs));

   it('serves a registered document by every read', async () => {
      const files = provider();
      expect(files.existsSync(element)).toBe(true);
      expect(await files.exists(element)).toBe(true);
      expect(files.readFileSync(element)).toBe('element Element');
      expect(await files.readFile(element)).toBe('element Element');
      expect(files.readBinarySync(element)).toEqual(new TextEncoder().encode('element Element'));
      expect(await files.readBinary(element)).toEqual(new TextEncoder().encode('element Element'));
      for (const node of [files.statSync(element), await files.stat(element)]) {
         expect(node).toEqual({ isFile: true, isDirectory: false, uri: element });
      }
   });

   it('serves an empty document, which is present rather than missing', () => {
      const empty = virtualUri('builtin', 'Empty');
      const files = provider({ [empty.toString()]: '' });
      expect(files.existsSync(empty)).toBe(true);
      expect(files.readFileSync(empty)).toBe('');
   });

   it('reports an unregistered URI absent and refuses to read or stat it', async () => {
      const files = provider();
      expect(files.existsSync(missing)).toBe(false);
      expect(await files.exists(missing)).toBe(false);
      expect(() => files.readFileSync(missing)).toThrow(expect.objectContaining({ code: 'ENOENT', path: missing.fsPath }));
      expect(() => files.statSync(missing)).toThrow(expect.objectContaining({ code: 'ENOENT' }));
      expect(() => files.readBinarySync(missing)).toThrow();
      await expect(files.readFile(missing)).rejects.toThrow();
      await expect(files.readBinary(missing)).rejects.toThrow();
      await expect(files.stat(missing)).rejects.toThrow();
   });

   it('lists no children and refuses a write', async () => {
      const files = provider();
      expect(files.readDirectorySync(element)).toEqual([]);
      expect(await files.readDirectory(element)).toEqual([]);
      await expect(files.writeFile(element, 'element Other')).rejects.toThrow();
      expect(files.readFileSync(element)).toBe('element Element');
   });
});
