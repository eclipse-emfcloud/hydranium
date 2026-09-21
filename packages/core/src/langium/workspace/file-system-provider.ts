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
import { serveVirtualDocument, serveVirtualNode } from './virtual-document.js';

/**
 * Empty-filesystem default {@link WritableFileSystemProvider}. For
 * in-memory / browser / test / CLI hosts that don't have a real filesystem.
 * All writes are no-ops. This is the portable `.`-entry default; the
 * Node-backed `DefaultFileSystemProvider`
 * lives in `@hydranium/core/node` (it pulls `node:fs`).
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

   // Serve virtual documents from the registered document (there is no disk to
   // read); delegate everything else to the empty base (which throws, or
   // answers "absent"). The base declares these param-less, so the param is
   // optional here.
   override readFile(uri?: URI): Promise<string> {
      const served = this.served(uri);
      return served !== undefined ? Promise.resolve(served) : super.readFile();
   }

   override readFileSync(uri?: URI): string {
      const served = this.served(uri);
      return served !== undefined ? served : super.readFileSync();
   }

   override readBinary(uri?: URI): Promise<Uint8Array> {
      const served = this.served(uri);
      return served !== undefined ? Promise.resolve(new TextEncoder().encode(served)) : super.readBinary();
   }

   override readBinarySync(uri?: URI): Uint8Array {
      const served = this.served(uri);
      return served !== undefined ? new TextEncoder().encode(served) : super.readBinarySync();
   }

   // The base declares these two WITH a URI parameter, so they stay required.
   override stat(uri: URI): Promise<FileSystemNode> {
      const served = serveVirtualNode(this.services, uri);
      return served !== undefined ? Promise.resolve(served) : super.stat(uri);
   }

   override statSync(uri: URI): FileSystemNode {
      return serveVirtualNode(this.services, uri) ?? super.statSync(uri);
   }

   override async exists(uri?: URI): Promise<boolean> {
      return this.existsSync(uri);
   }

   override existsSync(uri?: URI): boolean {
      return this.served(uri) !== undefined;
   }

   /** Text of the virtual document registered at `uri`, if there is one. */
   protected served(uri: URI | undefined): string | undefined {
      return uri !== undefined ? serveVirtualDocument(this.services, uri) : undefined;
   }
}
