/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { type FileSystemNode, URI } from '@hydranium/langium';
import { describe, expect, it } from 'vitest';
import { type ServerSharedServicesMinimal } from '../../../src/langium/shared-services.js';
import {
   DefaultEmptyFileSystemProvider,
   DefaultFileSystemProviderRegistry,
   type WritableFileSystemProvider
} from '../../../src/langium/workspace/file-system-provider.js';
import { makeNoopSharedServices } from '../../../src/testing/index.js';

/**
 * The portable default, which has no disk at all. Contract:
 * - every read keeps the empty base's answers, so "no filesystem" is still
 *   distinguishable from "an empty one";
 * - a refusal from an async read arrives as a REJECTION, not as a synchronous
 *   throw the promise chain cannot see.
 */
describe('DefaultEmptyFileSystemProvider', () => {
   const uri = URI.parse('file:///a.a');
   // Typed at the slot's interface: the base declares most reads param-less.
   const provider = (): WritableFileSystemProvider => new DefaultEmptyFileSystemProvider(makeNoopSharedServices());

   it('reports absent rather than throwing', async () => {
      expect(provider().existsSync(uri)).toBe(false);
      expect(await provider().exists(uri)).toBe(false);
   });

   it('refuses to read or stat', async () => {
      const files = provider();
      expect(() => files.readFileSync(uri)).toThrow();
      expect(() => files.readBinarySync(uri)).toThrow();
      expect(() => files.statSync(uri)).toThrow();
      // `rejects` discriminates: a method that threw synchronously would
      // never hand the matcher a promise, and the case errors instead.
      await expect(files.readFile(uri)).rejects.toThrow();
      await expect(files.readBinary(uri)).rejects.toThrow();
      await expect(files.stat(uri)).rejects.toThrow();
   });

   it('drops writes without failing', async () => {
      await expect(provider().writeFile(uri, 'content')).resolves.toBeUndefined();
   });
});

/**
 * A provider that answers every read with its own label, so a test can see
 * which provider a call reached. `realpath` and `mtimeMs` are left off, as a
 * provider with no disk leaves them.
 */
class LabelledProvider implements WritableFileSystemProvider {
   readonly written: string[] = [];

   constructor(readonly label: string) {}

   async writeFile(uri: URI, content: string): Promise<void> {
      this.written.push(`${uri.toString()}=${content}`);
   }
   async stat(uri: URI): Promise<FileSystemNode> {
      return this.statSync(uri);
   }
   statSync(uri: URI): FileSystemNode {
      return { isFile: true, isDirectory: false, uri: uri.with({ fragment: this.label }) };
   }
   async exists(): Promise<boolean> {
      return this.label === 'host';
   }
   existsSync(): boolean {
      return this.label === 'host';
   }
   async readBinary(): Promise<Uint8Array> {
      return this.readBinarySync();
   }
   readBinarySync(): Uint8Array {
      return new TextEncoder().encode(this.label);
   }
   async readFile(): Promise<string> {
      return this.label;
   }
   readFileSync(): string {
      return this.label;
   }
   async readDirectory(uri: URI): Promise<FileSystemNode[]> {
      return this.readDirectorySync(uri);
   }
   readDirectorySync(uri: URI): FileSystemNode[] {
      return [this.statSync(uri)];
   }
}

function registry(
   providers: Record<string, WritableFileSystemProvider>,
   host: WritableFileSystemProvider = new LabelledProvider('host')
): DefaultFileSystemProviderRegistry {
   return new DefaultFileSystemProviderRegistry(
      makeNoopSharedServices<ServerSharedServicesMinimal & { fileSystemProviders: Record<string, WritableFileSystemProvider> }>({
         fileSystemProviders: providers
      }),
      { host }
   );
}

/**
 * The registry bound on the slot. Contract:
 * - every call goes to the provider registered for the URI's scheme, and to
 *   the host for a scheme with none, whatever that scheme is, one named like
 *   a prototype key included;
 * - `realpath` and `mtimeMs` forward to the scheme's provider; where it lacks
 *   one, `realpath` returns the URI and `mtimeMs` returns `undefined`;
 * - a provider that throws synchronously from an async method still rejects.
 */
describe('DefaultFileSystemProviderRegistry', () => {
   const registered = URI.parse('custom:/lib/a.a');
   const unclaimed = URI.parse('memory:///ws/a.a');

   it('sends every read of a registered scheme to its provider, and any other scheme to the host', async () => {
      const custom = new LabelledProvider('custom');
      const host = new LabelledProvider('host');
      const files = registry({ custom }, host);
      for (const [uri, label] of [
         [registered, 'custom'],
         [unclaimed, 'host'],
         [URI.parse('file:///ws/a.a'), 'host']
      ] as const) {
         expect(files.readFileSync(uri)).toBe(label);
         expect(await files.readFile(uri)).toBe(label);
         expect(new TextDecoder().decode(files.readBinarySync(uri))).toBe(label);
         expect(new TextDecoder().decode(await files.readBinary(uri))).toBe(label);
         expect(files.statSync(uri).uri.fragment).toBe(label);
         expect((await files.stat(uri)).uri.fragment).toBe(label);
         expect(files.existsSync(uri)).toBe(label === 'host');
         expect(await files.exists(uri)).toBe(label === 'host');
         expect(files.providerFor(uri)).toBe(label === 'custom' ? custom : host);
      }
   });

   it("lists a directory through the provider of the directory's scheme", async () => {
      const files = registry({ custom: new LabelledProvider('custom') }, new LabelledProvider('host'));
      expect(files.readDirectorySync(URI.parse('memory:///ws')).map(node => node.uri.fragment)).toEqual(['host']);
      expect((await files.readDirectory(URI.parse('custom:/lib'))).map(node => node.uri.fragment)).toEqual(['custom']);
   });

   it('writes through the provider of the scheme', async () => {
      const custom = new LabelledProvider('custom');
      const host = new LabelledProvider('host');
      const files = registry({ custom }, host);
      await files.writeFile(registered, 'one');
      await files.writeFile(unclaimed, 'two');
      expect(custom.written).toEqual([`${registered.toString()}=one`]);
      expect(host.written).toEqual([`${unclaimed.toString()}=two`]);
   });

   it('sends a scheme that names a prototype key to the host', () => {
      // The DI container resolves any key found on the prototype chain, so a
      // plain lookup would hand back a function for these.
      const files = registry({}, new LabelledProvider('host'));
      for (const scheme of ['constructor', 'toString', 'hasOwnProperty', '__proto__']) {
         expect(files.readFileSync(URI.parse(`${scheme}:/a.a`))).toBe('host');
      }
   });

   it('passes a URI through realpath, and reports no mtime, for a provider without them', async () => {
      const files = registry({}, new LabelledProvider('host'));
      expect(files.realpath(unclaimed)).toBe(unclaimed);
      expect(await files.mtimeMs(unclaimed)).toBeUndefined();
   });

   it("answers realpath and mtimeMs from the scheme's provider when it has them", async () => {
      const resolved = URI.parse('file:///real/a.a');
      const disk = Object.assign(new LabelledProvider('disk'), {
         realpath: (): URI | undefined => resolved,
         mtimeMs: async (): Promise<number | undefined> => 42
      });
      const files = registry({}, disk);
      expect(files.realpath(URI.parse('file:///link/a.a'))).toBe(resolved);
      expect(await files.mtimeMs(URI.parse('file:///link/a.a'))).toBe(42);
   });

   it("keeps the scheme's provider's absent answer from realpath", () => {
      const absent = Object.assign(new LabelledProvider('disk'), { realpath: (): URI | undefined => undefined });
      expect(registry({}, absent).realpath(URI.parse('file:///gone.a'))).toBeUndefined();
   });

   it('rejects rather than throws when a provider throws synchronously from an async read', async () => {
      const throwing = Object.assign(new LabelledProvider('throwing'), {
         readFile: (): Promise<string> => {
            throw new Error('synchronous');
         }
      });
      await expect(registry({ custom: throwing }).readFile(registered)).rejects.toThrow('synchronous');
   });
});
