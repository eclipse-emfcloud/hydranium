/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { type CanonicalUri, asCanonicalUri } from '@hydranium/protocol';
import { type URI, UriUtils } from '@hydranium/langium';
import { type ServerSharedServicesMinimal } from '../shared-services.js';

/**
 * The slice of the filesystem provider {@link RealpathDocumentUriPolicy}
 * consults — just the optional `realpath` primitive. Declared locally so the
 * workspace-layer policy stays decoupled from the documents-layer
 * `WritableFileSystemProvider`; the production binding (the Node
 * `DefaultFileSystemProvider`) supplies the method, an in-memory / browser
 * provider omits it (and the policy then degrades to the syntactic default).
 */
export interface RealpathCapableFileSystem {
   realpath?(uri: URI): URI | undefined;
}

/**
 * Report whether `uri`'s real on-disk path differs from its syntactic
 * normalisation — the condition under which a language client's URI (`S`)
 * diverges from the canonical document identity (`R`) the build keys by.
 * Returns the resolved real URI when they differ, else
 * `undefined` (non-divergent, absent, or a provider with no `realpath`).
 *
 * A diagnostic primitive, not part of the keying path: the
 * `HydraniumWorkspaceManager` runs it once over the workspace roots at
 * startup to surface "this workspace path resolves through a symlink/`..`/case
 * variant, so client URIs will diverge from canonical identity" — the empirical
 * answer to whether the divergence machinery is exercised in a given deployment
 * (a plain on-disk workspace yields nothing).
 */
export function findRealpathDivergence(uri: URI | string, fs: RealpathCapableFileSystem): URI | undefined {
   const parsed = UriUtils.toUri(uri);
   const real = parsed && fs.realpath?.(parsed);
   return real && UriUtils.normalize(real) !== UriUtils.normalize(uri) ? real : undefined;
}

/**
 * The workspace's URI-interpretation strategy — how the framework turns an
 * arbitrary incoming URI into the two identities every layer must agree on.
 * Two related-but-distinct operations:
 *
 * - {@link canonicalUri} — TOTAL: maps any URI to the single canonical *string*
 *   the framework keys a document by, regardless of whether the file exists.
 *   This is the form that MUST match the adopter's `LangiumDocuments` keying so
 *   the text store, AST-document event filters
 *   (`AstDocumentManager.onUpdate` / `onSave` / `onClientClosed`), and
 *   `LangiumDocuments` lookups all agree on one identity for the same file. Use
 *   for keying, comparison, and the text-store ↔ document-store bridges.
 *
 * - {@link loadUri} — EXISTENCE-AWARE: maps a URI to the *load* URI, or
 *   `undefined` when there is no loadable on-disk content for it. Use where the
 *   next step actually touches the filesystem (loading a document, walking a
 *   directory): `undefined` means "skip / treat as empty" rather than attempt a
 *   doomed read. The default treats every URI as loadable (returns it
 *   unchanged); a real-path policy returns the resolved file URI, or `undefined`
 *   for a not-yet-written path.
 *
 * The framework default ({@link DefaultDocumentUriPolicy}) is Langium's
 * syntactic `UriUtils.normalize`, which matches Langium's
 * `DefaultLangiumDocuments` keying. Adopters that strengthen document identity
 * — e.g. resolving symlinks / linked files to their real path — bind
 * {@link RealpathDocumentUriPolicy}, or their own equivalent, so every layer
 * keys by the same stronger form. Otherwise the layers disagree: a subscriber
 * that opened a *symlinked* file would receive save events but silently no
 * update events because the text-store URI and the `LangiumDocument` URI for
 * the same file diverge.
 *
 * Contract: `canonicalUri` MUST be idempotent —
 * `canonicalUri(canonicalUri(u)) === canonicalUri(u)` — because callers feed
 * it URIs that may already be canonical (e.g. a `LangiumDocument.uri` straight
 * off the build pipeline).
 */
export interface DocumentUriPolicy {
   canonicalUri(uri: URI | string): CanonicalUri;
   /**
    * Existence-aware resolution to the load URI, or `undefined` when there is
    * no loadable content for `uri` (missing / synthetic). Callers that read the
    * filesystem next use `undefined` to skip rather than attempt a doomed read.
    */
   loadUri(uri: URI | string): URI | undefined;
}

/**
 * Framework default: Langium's syntactic normalisation. Pure and
 * filesystem-free, so it is browser-safe and matches `DefaultLangiumDocuments`
 * keying. Adopters resolving symlinks bind {@link RealpathDocumentUriPolicy}
 * (or their own equivalent) instead.
 */
export class DefaultDocumentUriPolicy implements DocumentUriPolicy {
   canonicalUri(uri: URI | string): CanonicalUri {
      // Mint point: the sole place a CanonicalUri is created under the default
      // (syntactic) policy. `asCanonicalUri` is the brand mint — see CanonicalUri.
      return asCanonicalUri(UriUtils.normalize(uri));
   }

   /**
    * No filesystem access, so existence cannot be checked — every URI is
    * treated as loadable and returned unchanged. A later load that misses
    * therefore reaches the filesystem and throws, which reports the miss with
    * the reason the read failed. Under a policy that CAN check, the miss is
    * caught earlier and reported without one.
    */
   loadUri(uri: URI | string): URI | undefined {
      return UriUtils.toUri(uri);
   }
}

/**
 * {@link DocumentUriPolicy} for adopters whose document identity is the real
 * on-disk path: resolves `file:` URIs through the `FileSystemProvider`'s
 * `realpath` primitive so a symlinked file and its target collapse to one
 * canonical key. Bind this and the single seam drives `LangiumDocuments`
 * keying, the AST-document event filters, and the document builder's directory
 * flattening all at once.
 *
 * ## What this adds over the {@link DefaultDocumentUriPolicy} (`UriUtils.normalize`)
 *
 * `normalize` is purely *syntactic*: it parses and re-serialises the URI string
 * (lower-cases the scheme, regularises percent-encoding and separators). It is
 * pure, filesystem-free, and browser-safe — but it knows nothing about the disk,
 * so two strings that denote the *same file* through different paths stay
 * distinct keys. This policy is the filesystem-backed strengthening; for `file:`
 * URIs it additionally:
 *
 * - **Collapses symlinks** to their target — the headline reason to bind it. A
 *   symlinked file (or a file reached through a symlinked directory) and its
 *   real path become one document instead of two divergent identities.
 * - **Resolves `..` / `.` segments** — `realpath` walks the real path, so
 *   `/ws/sub/../a.txt` folds to `/ws/a.txt`; `normalize` leaves dot segments as-is.
 * - **Case-folds on case-insensitive filesystems** (macOS / Windows): `realpath`
 *   returns the actual on-disk casing, so `/Foo/x.txt` and `/foo/x.txt` collapse to
 *   one key. `normalize` keeps them distinct — which on those platforms would
 *   register one physical file as two documents.
 *
 * ## Delegation, not a syscall
 *
 * The raw `realpath` syscall lives on the `FileSystemProvider`
 * (`@hydranium/core/node`'s `DefaultFileSystemProvider`), not here — this policy
 * is pure routing over that seam, so it carries no `node:fs` import and is
 * browser-neutral. Both methods follow the *same* policy: `canonicalUri` falls
 * back to the syntactic form when the path can't be resolved (optimistic — a
 * file that appears later canonicalises to the same key once present), while
 * `loadUri` returns `undefined` for an absent path (honest about existence, so a
 * caller about to read the filesystem skips it).
 *
 * If the bound provider has no `realpath` (in-memory / browser / empty),
 * both methods degrade to {@link DefaultDocumentUriPolicy} automatically — the
 * `loadUri` ternary tests the *method's presence*, not its return, so the
 * existence signal is preserved: `loadUri` returns `undefined` only when
 * `realpath` is present and reports the path absent.
 */
export class RealpathDocumentUriPolicy extends DefaultDocumentUriPolicy {
   protected readonly fs: RealpathCapableFileSystem;

   constructor(services: ServerSharedServicesMinimal) {
      super();
      this.fs = services.workspace.FileSystemProvider;
   }

   override canonicalUri(uri: URI | string): CanonicalUri {
      const parsed = UriUtils.toUri(uri);
      const real = parsed && this.fs.realpath?.(parsed);
      // Mint via `asCanonicalUri` once normalised; absent / unresolvable paths
      // (and a provider without `realpath`) fall back to the syntactic form.
      return real ? asCanonicalUri(UriUtils.normalize(real)) : super.canonicalUri(uri);
   }

   override loadUri(uri: URI | string): URI | undefined {
      if (!this.fs.realpath) {
         return super.loadUri(uri);
      }
      const parsed = UriUtils.toUri(uri);
      // `realpath` present: a real path resolves, an absent one returns
      // `undefined` (the skip signal). A non-parseable URI has no load target.
      return parsed ? this.fs.realpath(parsed) : parsed;
   }
}
