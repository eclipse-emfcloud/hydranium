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
import type { URI } from '@hydranium/langium';
import { type WritableFileSystemProvider } from '../../documents/ast-document-manager.js';
import { type LogNameOptions } from '../diagnostics/logger.js';
import { type ServerSharedServicesMinimal } from '../shared-services.js';
import { serveVirtualDocument } from './virtual-document.js';

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
   // read); delegate everything else to the empty base (which throws). The
   // base declares these param-less, so the param is optional here.
   override readFile(uri?: URI): Promise<string> {
      const served = uri !== undefined ? serveVirtualDocument(this.services, uri) : undefined;
      return served !== undefined ? Promise.resolve(served) : super.readFile();
   }

   override readFileSync(uri?: URI): string {
      const served = uri !== undefined ? serveVirtualDocument(this.services, uri) : undefined;
      return served !== undefined ? served : super.readFileSync();
   }
}
