/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { type Tracer } from '@hydranium/protocol';
import { EmptyFileSystemProvider } from '@hydranium/langium';
import type { FileSystemNode, URI } from '@hydranium/langium';
import { type WritableFileSystemProvider } from '../../documents/ast-document-manager.js';
import { type LogNameOptions } from '../diagnostics/logger.js';
import { type ServerSharedServicesMinimal } from '../shared-services.js';

/**
 * Empty-filesystem {@link WritableFileSystemProvider}. For browser / test / CLI
 * hosts that don't have a real filesystem. All writes are no-ops. On the
 * portable `.` entry it is the {@link FileSystemProviderRegistry.host} when
 * `context.fileSystemProvider` gives no writable provider; the Node-backed
 * `DefaultFileSystemProvider` lives in `@hydranium/core/node` (it pulls
 * `node:fs`).
 */
export class DefaultEmptyFileSystemProvider extends EmptyFileSystemProvider implements WritableFileSystemProvider {
   protected readonly tracer: Tracer;

   constructor(
      protected readonly services: ServerSharedServicesMinimal,
      options: LogNameOptions = {}
   ) {
      super();
      this.tracer = services.Tracer.for(options.logName ?? this.constructor.name).trace('instantiated');
   }

   async writeFile(_uri: URI, _content: string): Promise<void> {
      // no-op
   }

   // `async` so the base's refusal becomes a rejection: it throws
   // SYNCHRONOUSLY from a method declared to return a promise, and a
   // synchronous throw escapes the promise chain — `.catch()` never attaches
   // and `Promise.all` dies while its argument array is still being built, so
   // a caller reading several URIs cannot handle the miss it asked about. The
   // base declares `readFile` and `readBinary` param-less, so the param is
   // optional there.
   override async readFile(_uri?: URI): Promise<string> {
      return super.readFile();
   }

   override async readBinary(_uri?: URI): Promise<Uint8Array> {
      return super.readBinary();
   }

   override async stat(uri: URI): Promise<FileSystemNode> {
      return super.stat(uri);
   }
}

/**
 * The provider bound on `workspace.FileSystemProvider`: it dispatches each call
 * by the URI's scheme to the provider registered for it in the shared
 * `fileSystemProviders` group, and to the {@link host} for any scheme without
 * one.
 *
 * So one provider answers for each scheme, and a host's provider needs to know
 * only its own: the framework registers `virtual:` there, and an adopter adds a
 * scheme by contributing to the group. The host takes every unclaimed scheme
 * rather than `file:` alone, which keeps an in-memory workspace under `memory:`
 * or any other scheme on the host's provider.
 *
 * `THost` types the host, so an adopter whose own provider has more members
 * than the base declares the slot as `FileSystemProviderRegistry<MyProvider>`,
 * binds a {@link DefaultFileSystemProviderRegistry} with that host, and reads
 * those members through `services.workspace.FileSystemProvider.host`.
 */
export interface FileSystemProviderRegistry<
   THost extends WritableFileSystemProvider = WritableFileSystemProvider
> extends WritableFileSystemProvider {
   /** The provider for every scheme no entry of `fileSystemProviders` claims. */
   readonly host: THost;
   /** The provider that answers for `uri`. */
   providerFor(uri: URI): WritableFileSystemProvider;
}

/** Options for {@link DefaultFileSystemProviderRegistry}. */
export interface FileSystemProviderRegistryOptions<
   THost extends WritableFileSystemProvider = WritableFileSystemProvider
> extends LogNameOptions {
   /**
    * The provider for every scheme no entry of `fileSystemProviders` claims.
    * The framework passes the provider `context.fileSystemProvider` returns,
    * or a {@link DefaultEmptyFileSystemProvider} when that is not writable.
    */
   host: THost;
}

/**
 * The framework's {@link FileSystemProviderRegistry}.
 *
 * A directory is listed by the provider of its own scheme, so a workspace
 * root's tree comes from that provider alone.
 *
 * `realpath` and `mtimeMs` are always present and forward to the scheme's
 * provider. Where that provider lacks one, `realpath` returns the URI unchanged
 * and `mtimeMs` returns `undefined`: the answers `RealpathDocumentUriPolicy`
 * and the self-save filter already give a provider without them.
 */
export class DefaultFileSystemProviderRegistry<
   THost extends WritableFileSystemProvider = WritableFileSystemProvider
> implements FileSystemProviderRegistry<THost> {
   readonly host: THost;
   protected readonly tracer: Tracer;

   constructor(
      protected readonly services: ServerSharedServicesMinimal & { fileSystemProviders: Record<string, WritableFileSystemProvider> },
      options: FileSystemProviderRegistryOptions<THost>
   ) {
      this.host = options.host;
      this.tracer = services.Tracer.for(options.logName ?? this.constructor.name).trace('instantiated');
   }

   /**
    * The group is read per call, not in the constructor, so a registered
    * provider is built on first use and may read slots that reach back to this
    * one. Only an OWN key of the group counts: the DI container resolves any
    * key found on the prototype chain, so a scheme such as `constructor` would
    * otherwise dispatch to a function.
    */
   providerFor(uri: URI): WritableFileSystemProvider {
      const providers = this.services.fileSystemProviders;
      return Object.hasOwn(providers, uri.scheme) ? providers[uri.scheme] : this.host;
   }

   // The async methods are `async` so a provider that throws synchronously from
   // one still rejects, for the reason `DefaultEmptyFileSystemProvider` gives.
   async writeFile(uri: URI, content: string): Promise<void> {
      return this.providerFor(uri).writeFile(uri, content);
   }

   async mtimeMs(uri: URI): Promise<number | undefined> {
      return this.providerFor(uri).mtimeMs?.(uri);
   }

   realpath(uri: URI): URI | undefined {
      const provider = this.providerFor(uri);
      return provider.realpath ? provider.realpath(uri) : uri;
   }

   async stat(uri: URI): Promise<FileSystemNode> {
      return this.providerFor(uri).stat(uri);
   }

   statSync(uri: URI): FileSystemNode {
      return this.providerFor(uri).statSync(uri);
   }

   async exists(uri: URI): Promise<boolean> {
      return this.providerFor(uri).exists(uri);
   }

   existsSync(uri: URI): boolean {
      return this.providerFor(uri).existsSync(uri);
   }

   async readBinary(uri: URI): Promise<Uint8Array> {
      return this.providerFor(uri).readBinary(uri);
   }

   readBinarySync(uri: URI): Uint8Array {
      return this.providerFor(uri).readBinarySync(uri);
   }

   async readFile(uri: URI): Promise<string> {
      return this.providerFor(uri).readFile(uri);
   }

   readFileSync(uri: URI): string {
      return this.providerFor(uri).readFileSync(uri);
   }

   async readDirectory(uri: URI): Promise<FileSystemNode[]> {
      return this.providerFor(uri).readDirectory(uri);
   }

   readDirectorySync(uri: URI): FileSystemNode[] {
      return this.providerFor(uri).readDirectorySync(uri);
   }
}
