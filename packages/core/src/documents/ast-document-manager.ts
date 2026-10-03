/********************************************************************************
 * Copyright (c) 2023-2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import {
   type CanonicalUri,
   type CloseModelArgs,
   type Tracer,
   type TransferSavedEvent,
   type TransferUpdatedEvent,
   type OpenModelArgs,
   asModelVersion,
   type ModelVersion,
   type TextVersion,
   UNRECORDED_VERSION
} from '@hydranium/protocol';
import {
   type AstNode,
   DocumentState,
   type FileSystemProvider,
   type LangiumDocument,
   type LangiumDocuments,
   URI,
   UriUtils
} from '@hydranium/langium';
import { type LogNameOptions } from '../langium/diagnostics/logger.js';
import { type AstDiagnostic } from '../langium/validation/document-validator.js';

/**
 * File-system provider extension that supports writes. Langium's standard
 * {@link FileSystemProvider} is read-only; the manager needs to persist saves,
 * so consumers wire in a provider that implements this superset.
 *
 * Implementations may optionally hold a reference to a
 * {@link SelfSaveRegistry} so they can record their own write mtimes and
 * help downstream file-watchers suppress echo events for those writes.
 * The framework's `DefaultFileSystemProvider` takes the registry as
 * a constructor parameter; alternative implementations can either follow
 * the same pattern or leave the field unset.
 */
export interface WritableFileSystemProvider extends FileSystemProvider {
   writeFile(uri: URI, content: string): Promise<void>;
   /**
    * Last-modified time (ms) of the file at `uri`, or `undefined` if it can't
    * be determined (missing file, or a provider with no disk — in-memory /
    * browser). Optional: the only consumer is self-save echo suppression
    * (`didChangeWatchedFiles`), which simply lets a change through when the
    * mtime is unavailable. Distinct from Langium's `stat` (whose
    * `FileSystemNode` carries no mtime). Keeping disk access on the provider
    * seam is what lets the LSP update handler avoid a direct `node:fs` import.
    */
   mtimeMs?(uri: URI): Promise<number | undefined>;
   /**
    * Resolve `uri` to its real on-disk identity (symlinks collapsed, `..`/`.`
    * walked, case-folded on case-insensitive filesystems), or `undefined` *iff
    * the filesystem knows the path is absent*. The single source of the
    * "nothing loadable here" signal `RealpathDocumentUriPolicy` turns into
    * the synthetic-placeholder branch of `getOrCreateDocument`.
    *
    * Contract for implementers:
    * - A `file:`-backed provider returns the resolved URI when the file exists,
    *   and `undefined` when it cannot resolve the path (missing / unreadable).
    * - A non-`file:` URI (or any URI the provider cannot stat) passes through
    *   **unchanged** — it is treated as present, never reported absent.
    * - A provider with no disk to check (in-memory / browser / empty) simply
    *   omits this method; the framework's `FileSystemProviderRegistry` then
    *   returns the URI unchanged, and `RealpathDocumentUriPolicy` answers as
    *   the syntactic `DefaultDocumentUriPolicy` does.
    *
    * Synchronous (a `realpath` is a kernel-cached syscall) and optional — the
    * only consumers are the document-identity policy's `canonicalUri`/`loadUri`.
    * Keeping the syscall on the provider seam is what lets the policy stay
    * browser-neutral (no `node:fs` import).
    */
   realpath?(uri: URI): URI | undefined;
   /** Registry the provider records its own writes against. Optional — providers without watcher integration may omit. */
   readonly selfSaveRegistry?: SelfSaveRegistry;
}
import { Disposable } from 'vscode-languageserver';
import { TextDocumentIdentifier, type TextDocumentItem } from 'vscode-languageserver-protocol';
import { type TextDocument } from 'vscode-languageserver-textdocument';
import { type ServerSharedServices } from '../langium/module.js';
import { type HydraniumDocumentBuilder, labelPhaseListener } from '../langium/document-builder/index.js';
import { UNKNOWN_CLIENT_ID } from './client-ids.js';
import { type HydraniumTextDocuments } from './hydranium-text-documents.js';
import { type SelfSaveRegistry } from './self-save-registry.js';
import { type DocumentUriPolicy } from '../langium/workspace/document-uri-policy.js';

export interface UpdateInfo {
   changed: URI[];
   deleted: URI[];
}

/**
 * Server-internal document envelope at the AST layer. Emitted by
 * {@link AstDocumentManager.onUpdate} / {@link AstDocumentManager.onSave}
 * for in-process subscribers (`ModelService`, integrity service, etc.).
 *
 * `root` is the live AST the build holds, not an encoded copy like
 * `TransferDocument.model`, so mutating it changes the model every reader sees.
 */
export interface AstDocument<TAst extends AstNode, TDiagnostic extends AstDiagnostic = AstDiagnostic> {
   root: TAst;
   /** Absent until the document is validated, and on any `ModelService` read below `Validated`; `[]` means validated and clean. */
   diagnostics?: TDiagnostic[];
   uri: string;
   /**
    * The version of the text `root` was parsed from (`ModelLedger.versionOf`).
    * A caller that mutates the document sends it back as the `baseVersion` of
    * its session's write, and the conflict gate arms on it.
    */
   version: ModelVersion;
}

/**
 * What a session's save or persist resolves to: the document, and in
 * `persisted` the version of the text it wrote to the file. That can differ
 * from `version` either way, since writes land between the build and the
 * take.
 */
export type SavedAstDocument<TAst extends AstNode, TDiagnostic extends AstDiagnostic = AstDiagnostic> = AstDocument<TAst, TDiagnostic> & {
   persisted: { version: TextVersion };
};

export namespace AstDocument {
   /**
    * Construct an {@link AstDocument} envelope, its version marked as coming
    * from a read. `diagnostics` absent means not validated.
    */
   export function create<TAst extends AstNode, TDiagnostic extends AstDiagnostic = AstDiagnostic>(
      uri: string,
      version: number,
      root: TAst,
      diagnostics?: TDiagnostic[]
   ): AstDocument<TAst, TDiagnostic> {
      return { uri, version: asModelVersion(version), root, ...(diagnostics === undefined ? {} : { diagnostics }) };
   }
}

/** Update event delivered by {@link AstDocumentManager.onUpdate} — typed alias over the generic event wrapper. */
export type AstDocumentUpdatedEvent<TAst extends AstNode, TDiagnostic extends AstDiagnostic = AstDiagnostic> = TransferUpdatedEvent<
   AstDocument<TAst, TDiagnostic>
>;

/** Save event delivered by {@link AstDocumentManager.onSave} — typed alias over the generic event wrapper. */
export type AstDocumentSavedEvent<TAst extends AstNode, TDiagnostic extends AstDiagnostic = AstDiagnostic> = TransferSavedEvent<
   AstDocument<TAst, TDiagnostic>
>;

/**
 * Why an update event fired and whose write it echoes, as
 * {@link AstDocumentManager.attributeUpdate} answers for a document. The
 * fields mean what they mean on `TransferUpdatedEvent`.
 */
export interface UpdateAttribution {
   reason: 'changed' | 'rebuilt';
   sourceClientId: string;
   causedBy: string;
}

/** Construction options for {@link AstDocumentManager}. */
export interface AstDocumentManagerOptions extends LogNameOptions {
   /**
    * Skip a queued save of a URI when a newer save of it is queued behind. The
    * newer save took its text later, so disk ends the same with fewer writes.
    * A skipped save announces nothing and takes the newer save's outcome: it
    * resolves when that one lands and rejects with its error when it fails,
    * since disk then holds neither text. Defaults to `false`: every save
    * writes. The framework binds the manager without options, so turning this
    * on means rebinding `AstDocumentManager` with them.
    */
   readonly coalesceSaves?: boolean;
}

/**
 * The document slot the model server and the integrity service talk to:
 * open/close/update/save plus the AST-typed event streams, with the LSP
 * plumbing hidden.
 *
 * Generic over `<TAst extends AstNode, TDiagnostic>` so each consumer projects
 * its own AST root type and diagnostic shape into the emitted
 * {@link AstDocument} envelopes.
 *
 * **URI contract.** Every URI-accepting member takes a URI in *any* spelling
 * (canonical, symlinked, `..`/case-divergent) and canonicalizes internally
 * through the {@link DocumentUriPolicy}, so a caller never has to canonicalize
 * first and an implementation may not require it.
 */
export interface AstDocumentManager<TAst extends AstNode, TDiagnostic extends AstDiagnostic = AstDiagnostic> {
   open(args: OpenModelArgs): Promise<Disposable>;
   close(args: CloseModelArgs): Promise<void>;
   isOpen(uri: string): boolean;

   /** Apply `text` as `clientId`'s edit. Resolves to the resulting text-document version. */
   update(uri: string, text: string, clientId: string): Promise<TextVersion>;
   /**
    * Write the document's current text to disk through `FileSystemTaskQueue`.
    * The text is taken when this is called, so saves of one file land in the
    * order they were called.
    *
    * Resolves to the version of the text on disk once it lands: the version
    * taken, or under `coalesceSaves` the version of the newer save that wrote
    * in its place. A caller reporting what it persisted takes it from here,
    * since a version read beside the call names text a coalesced save never
    * wrote.
    */
   save(uri: string, clientId: string): Promise<TextVersion>;

   onUpdate(uri: string, listener: (event: AstDocumentUpdatedEvent<TAst, TDiagnostic>) => void): Disposable;
   onSave(uri: string, listener: (event: AstDocumentSavedEvent<TAst, TDiagnostic>) => void | Promise<void>): Disposable;
   onClientClosed(uri: string, clientId: string, listener: () => void): Disposable;

   getDocument(uri: string): LangiumDocument | undefined;

   /**
    * `document` as the envelope every event and snapshot read hands out, its
    * `version` the one `ModelLedger` recorded for its root.
    *
    * The `uri` is the document's own canonical one, not a subscriber's
    * spelling, so it matches the key every other layer uses. The diagnostics
    * are asserted to be `TDiagnostic` unchecked: a lexer error or another
    * validator's diagnostic satisfies the declared type and not a narrower one.
    */
   toAstDocument(document: LangiumDocument): AstDocument<TAst, TDiagnostic>;

   /** Client id that authored the document's current version, or `undefined` for a framework-internal build. */
   getAuthor(document: LangiumDocument): string | undefined;

   /**
    * The reason, source and cause of an update event for `document` emitted
    * now, from a phase listener of the build that carries it. Every head takes
    * its update events' attribution from here, so they name the same client
    * for one build. For a document a client opened, while rebuilds validate,
    * the answer changes once its `Validated` listeners have all run: a later
    * event at that version is `'rebuilt'`. `TransferDocumentUpdateReason`
    * names the cases that fall back to the last update.
    */
   attributeUpdate(document: LangiumDocument): UpdateAttribution;
}

/**
 * Higher-level facade over {@link HydraniumTextDocuments} that speaks the
 * model-server protocol (open/close/update/save with the transfer-model event
 * shapes). Hides the LSP plumbing from the model server and the integrity
 * service.
 *
 * Generic over `<TAst extends AstNode, TDiagnostic>` so each consumer
 * projects its own AST root type and diagnostic shape into the emitted
 * `AstDocument` envelopes. `TDiagnostic` defaults to `unknown`; consumers
 * that care about the diagnostic shape name a concrete one.
 *
 * **URI contract.** Every URI-accepting method takes a URI in *any* spelling
 * (canonical, symlinked, `..`/case-divergent) and canonicalizes internally
 * through the {@link DocumentUriPolicy} before keying any store — callers never
 * have to canonicalize first. The facade re-exposes only the {@link isOpen}
 * open-state predicate; the finer multi-client predicates
 * (`isOpenInLanguageClient` / `isOpenInAnyClient`) and the language-client address
 * resolution (the egress `applyEditToLanguageClient`) stay on
 * {@link HydraniumTextDocuments}, their owner.
 */
export class DefaultAstDocumentManager<
   TAst extends AstNode,
   TDiagnostic extends AstDiagnostic = AstDiagnostic
> implements AstDocumentManager<TAst, TDiagnostic> {
   /** The last `DocumentBuilder.update`'s URIs; the reason for a document the store does not track. */
   protected lastUpdate?: UpdateInfo;
   /**
    * Canonical URIs a client has opened since the file was last deleted,
    * whose versions the store keeps. One no client has opened keeps Langium's
    * version `0` through every change of its content, so its version says
    * nothing. Kept past the last close, since the store continues the version
    * sequence on the next open; a delivery can land after that close.
    */
   protected readonly trackedUris = new Set<CanonicalUri>();
   /**
    * Per tracked URI, the version whose `Validated` listeners last all ran,
    * which is the version an update event was delivered for. Dropped on
    * deletion, so a file created again with the same text is changed again.
    */
   protected readonly deliveredVersions = new Map<CanonicalUri, number>();
   /**
    * Whose writes the build under way carries, set when it starts: the author
    * of every open document's undelivered version, and the unknown-client id
    * for a change no write explains, such as a deletion, a document no client
    * has open, or a write that changed nothing. An undelivered version is one
    * whose build has not validated it yet, so a write whose build was
    * cancelled stays a cause of the build that takes over.
    *
    * Errs toward more than one cause, and so toward the unknown client, which
    * a reader treats as foreign: an answer it repeats, never one it misses.
    * A change no write explains counts for its own build only, so a build
    * that takes over from a cancelled one loses it. One field for every build:
    * a build started outside the workspace lock, such as a re-queue of an
    * orphaned document, reads the causes of whichever build started last.
    * An open document no build delivers, one a `shouldValidate` override
    * skips, stays undelivered, so it is a cause of every build while open.
    */
   protected readonly buildCauses = new Set<string>();

   /** Per canonical URI, the newest save queued for it, which {@link coalesceSaves} lets older queued saves defer to. */
   protected readonly newestSaves = new Map<CanonicalUri, Promise<TextVersion>>();
   protected readonly coalesceSaves: boolean;

   protected readonly textDocuments: HydraniumTextDocuments<TextDocument>;
   protected readonly fileSystemProvider: WritableFileSystemProvider;
   protected readonly langiumDocs: LangiumDocuments;
   protected readonly documentBuilder: HydraniumDocumentBuilder;
   protected readonly uriPolicy: DocumentUriPolicy;
   protected readonly tracer: Tracer;

   constructor(
      protected readonly services: ServerSharedServices,
      options: AstDocumentManagerOptions = {}
   ) {
      this.textDocuments = services.workspace.TextDocuments;
      this.fileSystemProvider = services.workspace.FileSystemProvider;
      this.langiumDocs = services.workspace.LangiumDocuments;
      this.documentBuilder = services.workspace.DocumentBuilder;
      this.uriPolicy = services.workspace.DocumentUriPolicy;
      this.tracer = services.Tracer.for(options.logName ?? 'AstDocumentManager').trace('instantiated');
      this.coalesceSaves = options.coalesceSaves ?? false;
      this.textDocuments.onDidOpen(event => {
         this.trackedUris.add(this.uriPolicy.canonicalUri(event.document.uri));
         return this.open({ clientId: event.clientId, uri: event.document.uri, languageId: event.document.languageId });
      });
      this.textDocuments.onDidClose(event => this.close({ clientId: event.clientId, uri: event.document.uri }));
      this.documentBuilder.onUpdate((changed, deleted) => {
         this.lastUpdate = { changed, deleted };
         this.buildCauses.clear();
         for (const textDocument of this.textDocuments.all()) {
            if (!this.isDelivered(textDocument.uri, textDocument.version)) {
               this.buildCauses.add(this.textDocuments.getAuthor(textDocument.uri, textDocument.version) ?? UNKNOWN_CLIENT_ID);
            }
         }
         const unexplained = changed.some(uri => {
            const textDocument = this.textDocuments.get(uri.toString());
            return textDocument === undefined || this.isDelivered(textDocument.uri, textDocument.version);
         });
         if (unexplained || deleted.length > 0) {
            this.buildCauses.add(UNKNOWN_CLIENT_ID);
         }
         // The only place a deletion is observable: `DocumentBuilder.update`
         // removes a deleted document before it builds anything, so no phase
         // listener ever sees it.
         for (const uri of deleted) {
            const key = this.uriPolicy.canonicalUri(uri.toString());
            this.trackedUris.delete(key);
            this.deliveredVersions.delete(key);
            this.textDocuments.notifyDocumentDeleted(uri.toString());
         }
      });
      // Once every listener ran, not in a listener of its own: listeners after
      // it could still be skipped by a cancel, and the next build would then
      // report as rebuilt a version they never delivered.
      this.documentBuilder.onDocumentPhaseDelivered(DocumentState.Validated, (document, version) => this.markDelivered(document, version));
   }

   /**
    * Resolve a `languageId` for a URI by delegating to the
    * `ServiceRegistry`. Multi-grammar workspaces route per-URI
    * correctly. Never throws.
    *
    * For a URI that matches no registered language the answer depends on how
    * many languages there are, because only one of the two cases has a
    * defensible guess:
    * - **one** registered language — its id. An extensionless or untitled URI
    *   in a single-language workspace is that language by construction.
    * - **more than one** — `'plaintext'`. Naming a real language here would
    *   mean picking by registration order and reporting a document as a
    *   language it demonstrably is not; `'plaintext'` says "unknown", which
    *   is the truth and is what a client can sensibly act on.
    *
    * Adopters needing dispatch on something other than file extension (URI
    * scheme, path prefix, embedded MIME) subclass `AstDocumentManager` and
    * override this method.
    */
   protected resolveLanguageId(uri: string): string {
      const parsed = URI.parse(uri);
      if (this.services.ServiceRegistry.hasServices(parsed)) {
         return this.services.ServiceRegistry.getServices(parsed).LanguageMetaData.languageId;
      }
      const languages = this.services.ServiceRegistry.all;
      return languages.length === 1 ? languages[0].LanguageMetaData.languageId : 'plaintext';
   }

   /**
    * Subscribe to the save event of the document at `uri`. The callback fires only when the
    * URI of the saved document matches `uri` (compared by canonical form).
    */
   onSave(uri: string, listener: (event: TransferSavedEvent<AstDocument<TAst, TDiagnostic>>) => void | Promise<void>): Disposable {
      const target = this.uriPolicy.canonicalUri(uri);
      return this.textDocuments.onDidSave(async event => {
         if (this.uriPolicy.canonicalUri(event.document.uri) !== target) {
            return undefined;
         }
         // Look the document up by its canonical URI: the adopter's
         // `LangiumDocuments` keys by the canonical form, while the saved
         // event carries the (possibly symlinked) client-facing URI.
         const documentURI = UriUtils.toUri(target);
         if (documentURI !== undefined && this.langiumDocs.hasDocument(documentURI)) {
            const document = await this.langiumDocs.getOrCreateDocument(documentURI);
            return listener({
               document: this.toAstDocument(document),
               sourceClientId: event.clientId
            });
         }
         return undefined;
      });
   }

   /** Fires when `clientId` detaches from the document at `uri` (matched by canonical form). */
   onClientClosed(uri: string, clientId: string, listener: () => void): Disposable {
      const target = this.uriPolicy.canonicalUri(uri);
      return this.textDocuments.onDidClose(event => {
         if (event.clientId === clientId && this.uriPolicy.canonicalUri(event.document.uri) === target) {
            listener();
         }
      });
   }

   /** Fires when the document at `uri` reaches `Validated` after each rebuild. */
   onUpdate(uri: string, listener: (event: TransferUpdatedEvent<AstDocument<TAst, TDiagnostic>>) => void): Disposable {
      const target = this.uriPolicy.canonicalUri(uri);
      const emitUpdate = (document: LangiumDocument): void => {
         if (this.uriPolicy.canonicalUri(document.uri) !== target) {
            return;
         }
         // No `'deleted'` reason: `DocumentBuilder.update` drops a deleted
         // document from `LangiumDocuments` before deriving the rebuild set
         // from it, so a deleted URI is never built and never reaches this
         // phase listener. A subscriber needing deletions has to be told on
         // a channel that does not require a built document.
         const event: TransferUpdatedEvent<AstDocument<TAst, TDiagnostic>> = {
            document: this.toAstDocument(document),
            ...this.attributeUpdate(document)
         };
         this.tracer.with(uri).trace(`emitUpdate start: source=${event.sourceClientId}, reason=${event.reason}, cause=${event.causedBy}`);
         listener(event);
         this.tracer.with(uri).trace('emitUpdate listener returned');
      };
      return this.documentBuilder.onDocumentPhase(DocumentState.Validated, labelPhaseListener(emitUpdate, 'AstDocumentManager.onUpdate'));
   }

   /**
    * The client that authored `document`'s current version, or `undefined` when
    * no client wrote it: a document no client has open. A rebuild that keeps
    * the version keeps its author, so this does not say who caused a build;
    * {@link attributeUpdate} does.
    * Honest about absence so a routing consumer tests `undefined` directly
    * rather than against a sentinel; the presentation default
    * ({@link UNKNOWN_CLIENT_ID}) is applied where an event needs a value.
    */
   getAuthor(document: LangiumDocument): string | undefined {
      return this.textDocuments.getAuthor(document.textDocument.uri, document.textDocument.version);
   }

   /**
    * `'changed'` for the first delivery of the document's version, crediting
    * its author; `'rebuilt'` for a later one, crediting nobody, since it echoes
    * no write, and naming the build's single cause if it has one.
    *
    * A document the rule does not apply to (see {@link isTracked}) falls back
    * to the last update: it is `'changed'` when its URI was passed to
    * `DocumentBuilder.update`. An open document that a validating build skips,
    * through a `shouldValidate` override, is never delivered, so each of its
    * events is its author's change.
    */
   attributeUpdate(document: LangiumDocument): UpdateAttribution {
      const key = this.uriPolicy.canonicalUri(document.uri.toString());
      const changed = this.isTracked(key)
         ? this.deliveredVersions.get(key) !== document.textDocument.version
         : this.lastUpdate?.changed.some(uri => UriUtils.equals(uri, document.uri)) === true;
      if (changed) {
         // Presentation boundary: the event field is a concrete `string`, so an
         // unauthored document surfaces the readable default rather than
         // `undefined` to subscribers and logs.
         const author = this.getAuthor(document) ?? UNKNOWN_CLIENT_ID;
         return { reason: 'changed', sourceClientId: author, causedBy: author };
      }
      const [cause] = this.buildCauses;
      return { reason: 'rebuilt', sourceClientId: UNKNOWN_CLIENT_ID, causedBy: this.buildCauses.size === 1 ? cause : UNKNOWN_CLIENT_ID };
   }

   /**
    * Whether the version rule applies to `uri`: the store keeps its version,
    * and rebuilds validate. With `updateBuildOptions.validation` off no version
    * is ever delivered, and the rule would report every event of an open
    * document as its author's change.
    */
   protected isTracked(uri: CanonicalUri): boolean {
      return this.keepsVersion(uri) && Boolean(this.documentBuilder.updateBuildOptions.validation);
   }

   /**
    * Whether the store keeps `uri`'s version: a client opened it since its
    * file was last deleted, or has it open still, as an editor keeps a
    * deleted file's buffer.
    */
   protected keepsVersion(uri: CanonicalUri): boolean {
      return this.trackedUris.has(uri) || this.textDocuments.isOpen(uri);
   }

   /**
    * Record that `version` of `document` was delivered, when the store tracks
    * it. The version the listeners saw, not the document's current one: a
    * write during them has moved that on, and marking it would report the
    * write's own build as rebuilt.
    */
   protected markDelivered(document: LangiumDocument, version: number): void {
      const key = this.uriPolicy.canonicalUri(document.uri.toString());
      if (this.keepsVersion(key)) {
         this.deliveredVersions.set(key, version);
      }
   }

   /** Whether `version` of `uri` was delivered. */
   protected isDelivered(uri: string, version: number): boolean {
      return this.deliveredVersions.get(this.uriPolicy.canonicalUri(uri)) === version;
   }

   async open(args: OpenModelArgs): Promise<Disposable> {
      // `open()` is the RPC-level "ensure this document is loaded" call. It is issued
      // by a session opening the document, including by every additional client
      // attaching to the same URI and the several sub-editors a composite view
      // opens. When the document is already loaded there is nothing to
      // do here but hand back the close-disposable — callers that want the current
      // state read it from this method's surrounding RPC response, not from a re-build.
      //
      // Re-rendering an already-built document to a newly-attached *textual* view is
      // driven by the real `textDocument/didOpen` notification, which
      // `HydraniumTextDocuments.notifyDidOpenTextDocument` handles through its
      // additional-client attach branch (firing `refreshContent` there). Firing
      // `refreshContent` here as well would turn every ensure-loaded call into a full
      // Langium rebuild + dependent relink cascade: redundant work that also
      // transiently breaks cross-document linking mid-rebuild (a dependent briefly
      // seeing an `extends`/`type` reference unresolved). And because the constructor
      // wires `onDidOpen -> this.open`, it would fire a second, identical rebuild on
      // every first open.
      //
      // So an already-open `open()` records the attaching client's open and nothing
      // else. The open is per `(uri, clientId)` and the last-close revert counts down
      // to it, so skipping it lets the first client's close tear down a document
      // another client is still reading. A document waiting out the revert grace
      // is still loaded: a client lost from it within its own grace attaches and
      // keeps its text, and for any other client the attach releases it, so the
      // open reads the file.
      if (this.isOpen(args.uri)) {
         this.textDocuments.attachClient(args.uri, args.clientId);
      }
      if (!this.isOpen(args.uri)) {
         const textDocument = await this.createDocumentFromTextOrFileSystem(args.uri, args.languageId, args.version, args.text);
         const creates = !this.isOpen(args.uri);
         this.textDocuments.notifyDidOpenTextDocument({ textDocument }, args.clientId);
         if (creates && args.text !== undefined) {
            // Text the caller supplies was not read from the file, so no file
            // is assumed: the document is dirty until its first save, whatever
            // the file holds.
            this.textDocuments.updateDiskBaseline(args.uri, undefined);
         }
         const built = this.getDocument(args.uri);
         if (creates && built) {
            // Without an LSP head nothing else builds the opened text.
            void this.services.workspace.VersionSyncService.syncTo(built.uri, this.textDocuments.version(args.uri));
         }
      }
      return Disposable.create(() => this.close(args));
   }

   async close(args: CloseModelArgs): Promise<void> {
      this.textDocuments.notifyDidCloseTextDocument({ textDocument: TextDocumentIdentifier.create(args.uri) }, args.clientId);
   }

   /**
    * Apply a textual update for `uri`. The shared version is assigned by the
    * text store itself ({@link HydraniumTextDocuments.applyContentChange}):
    * one step when `text` differs from the current synced content, unchanged
    * when it is identical — so callers never fabricate version numbers and
    * the shared sequence keeps its "advances iff content changes" invariant.
    *
    * Returns the resulting shared version so callers that want to log or
    * correlate the change against subsequent build events can. Throws if the
    * document isn't open.
    */
   async update(uri: string, text: string, clientId: string): Promise<TextVersion> {
      if (!this.isOpen(uri)) {
         throw new Error(`Document ${uri} hasn't been opened for updating yet`);
      }
      this.tracer.with(uri).trace(`Notify document change (${text.length} bytes, from ${clientId})`);
      return this.textDocuments.applyContentChange(uri, text, clientId);
   }

   /**
    * Persist the current text-document content for `uri` to disk and emit
    * the `didSaveTextDocument` notification. The text is read from the
    * multi-client text store (same source of truth `update` writes to), so
    * callers don't need to pass it — the manager owns content and version
    * sequencing.
    *
    * The text is taken synchronously, before the save waits in the file's task
    * queue; the compare and the write run in the queue. Taken later, a save
    * that waits behind another writes whatever the store holds when its turn
    * comes, edits made after the call included, and announces that text under
    * its own client id.
    *
    * **The write is skipped when the file already holds that text; the
    * notification is not.** A save announces that the content is on disk, which
    * is true either way — so a subscriber clearing a dirty marker or reacting to
    * a persist behaves the same, while an mtime is not moved for byte-identical
    * content that a downstream mtime-keyed build would then read as new work.
    *
    * Throws if no document is open for `uri`.
    */
   async save(uri: string, clientId: string): Promise<TextVersion> {
      // Canonical throughout: the write and the read that gates it must address
      // the same file the store was keyed by, or a divergent spelling compares
      // one file and writes another.
      const canonical = this.uriPolicy.canonicalUri(uri);
      const document = this.textDocuments.get(canonical);
      if (!document) {
         throw new Error(`Document ${uri} hasn't been opened for saving yet`);
      }
      const text = document.getText();
      const version = document.version;
      let supersededBy: Promise<TextVersion> | undefined;
      const saved: Promise<TextVersion> = this.services.workspace.FileSystemTaskQueue.enqueue(canonical, async () => {
         const newest = this.newestSaves.get(canonical);
         if (this.coalesceSaves && newest !== saved) {
            supersededBy = newest;
            return;
         }
         await this.writeSave(canonical, text, clientId);
      })
         .then(() => supersededBy ?? version)
         .finally(() => {
            if (this.newestSaves.get(canonical) === saved) {
               this.newestSaves.delete(canonical);
            }
         });
      this.newestSaves.set(canonical, saved);
      return saved;
   }

   /** Write `text` to `uri` unless the file already holds it, then announce the save. Runs inside the file's task queue. */
   protected async writeSave(uri: CanonicalUri, text: string, clientId: string): Promise<void> {
      if (!(await this.matchesDisk(uri, text))) {
         await this.tracer.with(uri).time(
            `Write file (${text.length} bytes, from ${clientId})`,
            // Async write so a slow disk does not block the event loop for the duration of the fs call.
            () => this.fileSystemProvider.writeFile(UriUtils.toUri(uri), text),
            'debug'
         );
      }
      this.textDocuments.notifyDidSaveTextDocument({ textDocument: TextDocumentIdentifier.create(uri), text }, clientId);
   }

   /**
    * Whether the file at `uri` already holds `text`.
    *
    * Compared by CONTENT rather than against a remembered version, so a write
    * from outside this server is still corrected: a version this manager already
    * saved says nothing about what is on disk now. `false` when the file cannot
    * be read at all, which is the answer that writes — a document whose file does
    * not exist yet is exactly the one a first save has to create.
    */
   protected async matchesDisk(uri: string, text: string): Promise<boolean> {
      return this.fileSystemProvider
         .readFile(UriUtils.toUri(uri))
         .then(onDisk => onDisk === text)
         .catch(() => false);
   }

   isOpen(uri: string): boolean {
      return !!this.textDocuments.get(uri);
   }

   /**
    * The `LangiumDocument` for an externally-supplied URI, looked up by its
    * canonical identity. Folds the `getDocument(toUri(canonicalUri(uri)))` idiom
    * into one place so a client-facing URI (e.g. a symlink) always resolves to
    * the document `LangiumDocuments` keys by its real path — a caller cannot
    * forget the `canonicalUri` step and silently miss the document.
    */
   getDocument(uri: string): LangiumDocument | undefined {
      return this.langiumDocs.getDocument(UriUtils.toUri(this.uriPolicy.canonicalUri(uri)));
   }

   protected async createDocumentFromTextOrFileSystem(
      uri: string,
      languageId: string = this.resolveLanguageId(uri),
      version = 0,
      text?: string
   ): Promise<TextDocumentItem> {
      // Read in the file's task queue: a read beside a queued save of the file
      // returns the text from before it, and the document then opens on that.
      return {
         uri,
         languageId,
         version,
         text:
            text ??
            (await this.services.workspace.FileSystemTaskQueue.enqueue(uri, () => this.fileSystemProvider.readFile(UriUtils.toUri(uri))))
      };
   }

   /**
    * Events and the model service's snapshot reads both come through here, so
    * an override that re-shapes the document re-shapes both.
    */
   toAstDocument(document: LangiumDocument): AstDocument<TAst, TDiagnostic> {
      const uri = document.textDocument.uri;
      const root = document.parseResult.value as TAst;
      const ledger = this.services.workspace.ModelLedger;
      const version = ledger.versionOf(root);
      if (version === UNRECORDED_VERSION && !ledger.isPlaceholder(root)) {
         this.tracer.with(uri).warn('No model version recorded for the root: it was built outside the document factory');
      }
      return AstDocument.create<TAst, TDiagnostic>(uri, version, root, document.diagnostics as TDiagnostic[] | undefined);
   }
}
