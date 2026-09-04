/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { URI } from '@hydranium/langium';
import { type ServerSharedServicesMinimal } from '../shared-services.js';

/**
 * URI scheme for virtual documents — LangiumDocuments that have no backing
 * file on disk (a language's stdlib, library types, built-in definitions,
 * mirrors, generated views). Chosen so it cannot collide with on-disk `file:`
 * URIs, and so the framework's FileSystemProvider can recognise and serve them
 * on re-read (see {@link serveVirtualDocument}).
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
 * Serve the text of a registered virtual document, or `undefined` when `uri`
 * is not virtual or no document is registered for it (so a FileSystemProvider
 * delegates to its real backing).
 *
 * The framework's FileSystemProvider defaults call this at the top of
 * `readFile` / `readFileSync` so a virtual document survives a re-read:
 * `DocumentBuilder.update` / `LangiumDocumentFactory.update` re-read a changed
 * URI from the FileSystemProvider, and nothing on disk backs a virtual URI. The
 * text comes from the registered document — the original source for a
 * `fromString` document, or the serialized form retained by the framework's
 * `fromModel` (which fills in the text Langium leaves empty). No serializer is
 * consulted here; the text is already on the document.
 */
export function serveVirtualDocument(services: ServerSharedServicesMinimal, uri: URI): string | undefined {
   if (!isVirtualUri(uri)) {
      return undefined;
   }
   const document = services.workspace.LangiumDocuments.getDocument(uri);
   return document ? document.textDocument.getText() : undefined;
}
