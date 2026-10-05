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
import { type WritableFileSystemProvider } from './file-system-provider.js';
import { type LogNameOptions } from '../diagnostics/logger.js';
import { type ServerSharedServicesMinimal } from '../shared-services.js';
import { NO_SUCH_FILE, NO_SUCH_PATH, UNSUPPORTED_WRITE } from './in-memory-file-system-provider.js';
import { notFound } from './file-not-found.js';

/**
 * URI scheme for virtual documents — LangiumDocuments that have no backing
 * file on disk (a language's stdlib, library types, built-in definitions,
 * mirrors, generated views). Chosen so it cannot collide with on-disk `file:`
 * URIs, and so the framework can serve them on re-read through its own
 * provider for the scheme (see {@link VirtualFileSystemProvider}).
 */
export const VIRTUAL_SCHEME = 'virtual';

/**
 * Build a URI for a virtual document — one whose content is provided in code
 * rather than read from disk, either as a parsed string
 * (`LangiumDocumentFactory.fromString`) or a code-built AST
 * (`LangiumDocumentFactory.fromModel`).
 *
 * The URI uses the {@link VIRTUAL_SCHEME} scheme. The first segment carries
 * contributor identity for diagnostics, telemetry, and "go to source" UI;
 * additional segments scope sub-documents within one contributor.
 *
 * Pair with a `LangiumDocumentFactory` to construct a document whose content
 * lives in memory. The resulting document is suitable as the `document`
 * argument to the tier factories on `HydraniumAstNodeDescriptionProvider`
 * (`createLocal` / `createProject` / `createPublic` / `createUniversal`).
 *
 * # End the URI with a registered file extension
 *
 * Called with a contributor and no further segments this yields
 * `virtual:<contributor>`, which has no extension and so matches no registered
 * language — a trap. Every per-language service is resolved per URI, and a
 * virtual document is never open in `TextDocuments`, so the declared-languageId
 * lookup rung cannot serve it either: the document is indexed but inert,
 * contributing nothing to the scopes it was written to populate, with no error
 * anywhere. Pass the extension as the last segment,
 * `virtualUri(contributor, 'name.<ext>')`. `HydraniumWorkspaceManager` warns
 * when a seeded additional document fails to route, which is where this
 * usually surfaces.
 *
 * # Relationship to the `$synthetic` node marker
 *
 * The URI scheme tags the *document* as not-from-disk; the `$synthetic` node
 * marker (see `markSynthetic` / `isSyntheticNode`) tags an individual *node* as
 * not user-authored. A virtual document may contain non-synthetic nodes and
 * vice versa.
 *
 * Both axes are read by `HydraniumDocumentValidator`, at different
 * granularities: the scheme skips the WHOLE document
 * (`validateVirtualDocuments`, default `false`, so the walk is avoided
 * entirely), the marker skips a node and its children
 * (`validateSyntheticNodes`, default `false`).
 */
export function virtualUri(contributor: string, ...segments: string[]): URI {
   const tail = segments.length > 0 ? '/' + segments.join('/') : '';
   return URI.parse(`${VIRTUAL_SCHEME}:${contributor}${tail}`);
}

/** True iff `uri` uses the {@link VIRTUAL_SCHEME} scheme produced by {@link virtualUri}. */
export function isVirtualUri(uri: URI | string): boolean {
   const scheme = typeof uri === 'string' ? URI.parse(uri).scheme : uri.scheme;
   return scheme === VIRTUAL_SCHEME;
}

/**
 * The file system provider for the {@link VIRTUAL_SCHEME} scheme, registered by
 * the framework in the shared `fileSystemProviders` group so every host serves
 * `virtual:` whatever provider it binds for its own files.
 *
 * A virtual document has no backing outside the index, and a re-read still has
 * to find it: `DocumentBuilder.update` and `LangiumDocumentFactory.update`
 * re-read a changed URI from the provider, and the last close rebuilds a
 * released document the provider says `exists`. So the text comes from the
 * document `LangiumDocuments` holds — the original source for a `fromString`
 * document, or the serialized form the framework's `fromModel` retains. An
 * edited one answers with its edited text.
 *
 * **Every read method agrees.** Serving only the text methods would leave one
 * provider answering "here is the content" and "nothing is there" about one
 * URI, so a caller could not probe before reading. A registered document is
 * always a FILE with no children: a workspace walk handed a directory would try
 * to enumerate children it has none of.
 *
 * Read-only: a write is refused, since nothing backs the scheme.
 */
export class VirtualFileSystemProvider implements WritableFileSystemProvider {
   protected readonly tracer: Tracer;

   constructor(
      protected readonly services: ServerSharedServicesMinimal,
      options: LogNameOptions = {}
   ) {
      this.tracer = services.Tracer.for(options.logName ?? this.constructor.name).trace('instantiated');
   }

   async writeFile(uri: URI, _content: string): Promise<void> {
      throw new Error(UNSUPPORTED_WRITE.format({ uri: uri.toString() }));
   }

   async readFile(uri: URI): Promise<string> {
      return this.readFileSync(uri);
   }

   readFileSync(uri: URI): string {
      const text = this.text(uri);
      if (text === undefined) {
         throw notFound(NO_SUCH_FILE.format({ uri: uri.toString() }), uri);
      }
      return text;
   }

   async readBinary(uri: URI): Promise<Uint8Array> {
      return this.readBinarySync(uri);
   }

   readBinarySync(uri: URI): Uint8Array {
      return new TextEncoder().encode(this.readFileSync(uri));
   }

   async stat(uri: URI): Promise<FileSystemNode> {
      return this.statSync(uri);
   }

   statSync(uri: URI): FileSystemNode {
      if (this.text(uri) === undefined) {
         throw notFound(NO_SUCH_PATH.format({ uri: uri.toString() }), uri);
      }
      return { isFile: true, isDirectory: false, uri };
   }

   async exists(uri: URI): Promise<boolean> {
      return this.existsSync(uri);
   }

   existsSync(uri: URI): boolean {
      return this.text(uri) !== undefined;
   }

   async readDirectory(_uri: URI): Promise<FileSystemNode[]> {
      return [];
   }

   readDirectorySync(_uri: URI): FileSystemNode[] {
      return [];
   }

   /**
    * Text of the document registered at `uri`, if there is one.
    *
    * `LangiumDocuments` is resolved per call, not in the constructor: it reaches
    * this provider back through the document factory, so resolving it eagerly
    * is a construction cycle.
    */
   protected text(uri: URI): string | undefined {
      return this.services.workspace.LangiumDocuments.getDocument(uri)?.textDocument.getText();
   }
}
