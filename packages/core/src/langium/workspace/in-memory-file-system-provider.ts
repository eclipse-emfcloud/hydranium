/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { type FileSystemNode, URI } from '@hydranium/langium';
import { type Tracer } from '@hydranium/protocol';
import { type WritableFileSystemProvider } from '../../documents/ast-document-manager.js';
import { type LogNameOptions } from '../diagnostics/logger.js';
import { serverSharedFactory, type ServerSharedServicesMinimal } from '../shared-services.js';
import { serveVirtualDocument } from './virtual-document.js';

/**
 * File content keyed by path, for seeding an {@link InMemoryFileSystemProvider}.
 *
 * Keys are absolute URI strings unless {@link InMemoryFileSystemOptions.rootUri}
 * is given, in which case they are relative to it. The relative form is what
 * lets a build step emit the record without knowing where the host will mount
 * the workspace.
 */
export type FileSystemSeed = Readonly<Record<string, string>>;

/** Options for {@link InMemoryFileSystemProvider} and {@link inMemoryFileSystem}. */
export interface InMemoryFileSystemOptions extends LogNameOptions {
   /** Initial content. Absent leaves the filesystem empty but writable. */
   seed?: FileSystemSeed;
   /**
    * Prefix for relative {@link seed} keys, without a trailing separator. When
    * omitted the keys are taken as absolute URIs.
    */
   rootUri?: string;
}

/**
 * A writable filesystem held in a `Map`, for a host with no disk — a browser
 * worker, or a test that needs the workspace walk to find real content.
 *
 * # Why neither shipped provider stands in
 *
 * `DefaultEmptyFileSystemProvider` is genuinely empty (reads throw, writes
 * are dropped) and the disk-backed one in `@hydranium/core/node` pulls
 * `node:fs`, which a browser bundle refuses to resolve. A host that means to
 * open a workspace without a disk needs a third thing: real contents, no
 * syscalls.
 *
 * # It must be typed writable, not merely `FileSystemProvider`
 *
 * The `fileSystemProvider` context slot accepts what it is handed only if that
 * carries `writeFile`; anything narrower is silently replaced by the empty
 * default, which presents as "the workspace is empty" rather than as a wiring
 * error. A read-only in-memory provider is therefore not a smaller version of
 * this one — it is one that does not bind.
 *
 * # Directories are implied, never stored
 *
 * Only files are held. A directory exists exactly when some file key sits under
 * it, which is what keeps a write a single `Map.set` with no parent-creation
 * step to forget. The cost is that an empty directory cannot be represented; the
 * workspace walk does not need one, and a stored directory set would be a second
 * source of truth to keep in step with the first.
 *
 * # A trailing separator is stripped on every lookup
 *
 * Langium spells the workspace root both with and without one depending on which
 * walk asks, so normalising only where a directory prefix is computed leaves
 * `stat` and `exists` disagreeing with `readDirectory` about the same folder.
 *
 * # What it deliberately does not answer
 *
 * No watch notifications, no case-insensitivity, no eviction policy for a
 * workspace larger than memory. `mtimeMs` and `realpath` are omitted rather than
 * stubbed, which the framework degrades on by design: the self-save filter lets
 * the change through and the URI policy keeps the URI it was given.
 *
 * Nor does the map outlive the host: every write is lost when the process or the
 * page goes. `PersistentFileSystemProvider` is the subclass that mirrors
 * the same writes into an asynchronous backing store, and it is a subclass
 * rather than an option because the map has to stay the read path either way.
 */
export class InMemoryFileSystemProvider implements WritableFileSystemProvider {
   protected readonly files = new Map<string, string>();
   protected readonly tracer: Tracer;

   constructor(
      protected readonly services: ServerSharedServicesMinimal,
      options: InMemoryFileSystemOptions = {}
   ) {
      const { seed = {}, rootUri } = options;
      for (const [path, content] of Object.entries(seed)) {
         this.files.set(normalize(rootUri === undefined ? path : `${rootUri}/${path}`), content);
      }
      this.tracer = services.Tracer.for(options.logName ?? this.constructor.name).trace('instantiated', {
         files: this.files.size
      });
   }

   /**
    * Replace the content at `uri`, creating it if absent. The synchronous twin
    * of `writeFile`, for a test that mutates the filesystem between builds
    * rather than through the server.
    */
   setFile(uri: URI, content: string): void {
      this.files.set(normalize(uri), content);
   }

   /** Remove the file at `uri`. A no-op when nothing is there. */
   deleteFile(uri: URI): void {
      this.files.delete(normalize(uri));
   }

   async writeFile(uri: URI, content: string): Promise<void> {
      this.setFile(uri, content);
   }

   readFile(uri: URI): Promise<string> {
      return Promise.resolve(this.readFileSync(uri));
   }

   readFileSync(uri: URI): string {
      const served = serveVirtualDocument(this.services, uri);
      if (served !== undefined) {
         return served;
      }
      const content = this.files.get(normalize(uri));
      if (content === undefined) {
         throw new Error(`No such file: ${uri.toString()}`);
      }
      return content;
   }

   readBinary(uri: URI): Promise<Uint8Array> {
      return Promise.resolve(this.readBinarySync(uri));
   }

   readBinarySync(uri: URI): Uint8Array {
      return new TextEncoder().encode(this.readFileSync(uri));
   }

   stat(uri: URI): Promise<FileSystemNode> {
      return Promise.resolve(this.statSync(uri));
   }

   statSync(uri: URI): FileSystemNode {
      const path = normalize(uri);
      if (this.files.has(path)) {
         return { isFile: true, isDirectory: false, uri };
      }
      if (this.hasChildren(path)) {
         return { isFile: false, isDirectory: true, uri };
      }
      throw new Error(`No such file or directory: ${uri.toString()}`);
   }

   exists(uri: URI): Promise<boolean> {
      return Promise.resolve(this.existsSync(uri));
   }

   existsSync(uri: URI): boolean {
      const path = normalize(uri);
      return this.files.has(path) || this.hasChildren(path);
   }

   readDirectory(uri: URI): Promise<FileSystemNode[]> {
      return Promise.resolve(this.readDirectorySync(uri));
   }

   readDirectorySync(uri: URI): FileSystemNode[] {
      const prefix = `${normalize(uri)}/`;
      const children = new Map<string, boolean>();
      for (const path of this.files.keys()) {
         if (!path.startsWith(prefix)) {
            continue;
         }
         const remainder = path.slice(prefix.length);
         const separator = remainder.indexOf('/');
         const name = separator < 0 ? remainder : remainder.slice(0, separator);
         if (!children.has(name)) {
            children.set(name, separator < 0);
         }
      }
      return [...children].map(([name, isFile]) => ({
         isFile,
         isDirectory: !isFile,
         uri: URI.parse(`${prefix}${name}`)
      }));
   }

   /**
    * The map key for `uri`.
    *
    * Exposed for a subclass that mirrors the map into a second store and has to
    * key it the same way. Deriving a key from `uri.toString()` instead agrees
    * with this one for every ordinary path and disagrees for exactly the ones
    * normalisation exists for — a percent-encodable character, a trailing
    * separator — so the stored entry becomes unfindable in the case nobody
    * tests.
    */
   protected fileKey(uri: URI | string): string {
      return normalize(uri);
   }

   protected hasChildren(path: string): boolean {
      const prefix = `${path}/`;
      for (const candidate of this.files.keys()) {
         if (candidate.startsWith(prefix)) {
            return true;
         }
      }
      return false;
   }
}

/**
 * Key a URI into the file map: parsed so a seeded string and a URI the framework
 * hands back agree on percent-encoding, then stripped of a trailing separator so
 * a folder spelled both ways is one entry.
 */
function normalize(uri: URI | string): string {
   const text = typeof uri === 'string' ? URI.parse(uri).toString() : uri.toString();
   return text.endsWith('/') ? text.slice(0, -1) : text;
}

/**
 * Module fragment binding an {@link InMemoryFileSystemProvider}, spread into the
 * services context exactly where a Node host spreads `NodeFileSystem`.
 *
 * A host that needs to reach the provider afterwards — to seed or mutate it
 * mid-test — reads it back off `shared.workspace.FileSystemProvider`, since the
 * slot owns construction.
 */
export function inMemoryFileSystem(options: InMemoryFileSystemOptions = {}): {
   fileSystemProvider: (services: unknown) => WritableFileSystemProvider;
} {
   return {
      fileSystemProvider: serverSharedFactory(services => new InMemoryFileSystemProvider(services, options))
   };
}
