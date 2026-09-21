/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { type LangiumDocument, URI } from '@hydranium/langium';
import { describe, expect, it } from 'vitest';
import { type ServerSharedServicesMinimal } from '../../../src/langium/shared-services.js';
import { DefaultEmptyFileSystemProvider } from '../../../src/langium/workspace/file-system-provider.js';
import { virtualUri } from '../../../src/langium/workspace/virtual-document.js';
import { makeNoopSharedServices } from '../../../src/testing/index.js';

function servicesWith(virtualDocuments: Record<string, string> = {}): ServerSharedServicesMinimal {
   return makeNoopSharedServices({
      workspace: {
         LangiumDocuments: {
            getDocument(uri: URI): LangiumDocument | undefined {
               const text = virtualDocuments[uri.toString()];
               return text === undefined ? undefined : ({ uri, textDocument: { getText: () => text } } as unknown as LangiumDocument);
            }
         }
      }
   });
}

/**
 * The portable default, which has no disk at all. Contract:
 * - a registered virtual document is served by every read, because this is the
 *   provider a browser or CLI host boots on and a virtual stdlib is the one
 *   thing such a host does have;
 * - everything else keeps the empty base's answers, so "no filesystem" is still
 *   distinguishable from "an empty one".
 *
 * Its Node and in-memory siblings make the same agreement, and that uniformity
 * is the point: a head that swaps providers must not watch the same URI change
 * its answer.
 */
describe('DefaultEmptyFileSystemProvider', () => {
   const uri = virtualUri('builtin', 'types.a');
   const provider = (virtualDocuments: Record<string, string> = {}): DefaultEmptyFileSystemProvider =>
      new DefaultEmptyFileSystemProvider(servicesWith(virtualDocuments));
   const serving = (): DefaultEmptyFileSystemProvider => provider({ [uri.toString()]: 'element Any' });

   describe('a registered virtual document', () => {
      it('is reported present', async () => {
         expect(serving().existsSync(uri)).toBe(true);
         expect(await serving().exists(uri)).toBe(true);
      });

      it('stats as a file', async () => {
         expect(serving().statSync(uri)).toMatchObject({ isFile: true, isDirectory: false });
         expect(await serving().stat(uri)).toMatchObject({ isFile: true, isDirectory: false });
      });

      it('reads as text and as bytes', async () => {
         expect(serving().readFileSync(uri)).toBe('element Any');
         expect(await serving().readFile(uri)).toBe('element Any');
         expect(serving().readBinarySync(uri)).toEqual(new TextEncoder().encode('element Any'));
         expect(await serving().readBinary(uri)).toEqual(new TextEncoder().encode('element Any'));
      });
   });

   describe('anything else', () => {
      it('reports absent rather than throwing', async () => {
         // `exists` is the one read the empty base answers instead of refusing,
         // and that stays true for an unregistered virtual URI as well as a file.
         expect(provider().existsSync(uri)).toBe(false);
         expect(provider().existsSync(URI.parse('file:///a.a'))).toBe(false);
         expect(await provider().exists(URI.parse('file:///a.a'))).toBe(false);
      });

      // The async reads refuse SYNCHRONOUSLY rather than returning a rejected
      // promise, because the empty base throws from a method merely declared to
      // return one. Asserted as `toThrow` on the call and not `rejects`, which
      // would pass a non-promise to the matcher and fail for its own reason —
      // inherited behaviour, pinned here so a change to it is visible.
      it('refuses to read or stat', () => {
         const files = provider();
         const uri = URI.parse('file:///a.a');
         expect(() => files.readFileSync(uri)).toThrow();
         expect(() => files.readFile(uri)).toThrow();
         expect(() => files.readBinarySync(uri)).toThrow();
         expect(() => files.readBinary(uri)).toThrow();
         expect(() => files.statSync(uri)).toThrow();
         expect(() => files.stat(uri)).toThrow();
      });

      it('drops writes without failing', async () => {
         await expect(provider().writeFile(URI.parse('file:///a.a'), 'content')).resolves.toBeUndefined();
      });
   });
});
