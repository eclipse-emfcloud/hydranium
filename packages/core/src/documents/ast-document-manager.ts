/********************************************************************************
 * Copyright (c) 2023-2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import {
   type CloseModelArgs,
   type Tracer,
   type TransferSavedEvent,
   type TransferUpdatedEvent,
   type OpenModelArgs
} from '@hydranium/protocol';
import {
   type AstNode,
   type DocumentBuilder,
   DocumentState,
   type FileSystemProvider,
   type LangiumDocument,
   type LangiumDocuments,
   UriUtils
} from '@hydranium/langium';
import { type LogNameOptions } from '../langium/diagnostics/logger.js';

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
    *   omits this method; `RealpathDocumentUriPolicy` then degrades to the
    *   syntactic `DefaultDocumentUriPolicy` behaviour automatically.
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
import { URI } from '@hydranium/langium';
import { type ServerSharedServices } from '../langium/module.js';
import { labelPhaseListener } from '../langium/document-builder/index.js';
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
 * Carries an AST-typed root (`TAst extends AstNode`) — distinct from
 * `TransferDocument<TTransfer extends TransferElement, …>` in
 * `@hydranium/protocol`, which carries the wire-transfer shape (no
 * `$container` cycles, references as strings). The two are structural
 * twins; the type-system distinction is the generic constraint, and the
 * conversion seam between them is the framework `TransferEncoder`.
 */
export interface AstDocument<TAst extends AstNode, TDiagnostic> {
   root: TAst;
   diagnostics: TDiagnostic[];
   uri: string;
   /**
    * Text-document version this snapshot was taken at — read from
    * `LangiumDocument.textDocument.version`. Symmetric with
    * `TransferDocument.version` on the wire side: in-process callers
    * that hold an `AstDocument` and mutate it pass this value back as
    * `TransferUpdateArgs.baseVersion` / `TransferSaveArgs.baseVersion` to opt
    * into the conflict gate.
    */
   version: number;
}

export namespace AstDocument {
   /**
    * Construct an {@link AstDocument} envelope. `diagnostics` defaults
    * to `[]` so test fixtures and the in-process pre-validated paths
    * don't need to repeat the empty array at every call site. Mirrors
    * `TransferDocument.create` on the wire side.
    */
   export function create<TAst extends AstNode, TDiagnostic = unknown>(
      uri: string,
      version: number,
      root: TAst,
      diagnostics: TDiagnostic[] = []
   ): AstDocument<TAst, TDiagnostic> {
      return { uri, version, root, diagnostics };
   }

   /**
    * Project a {@link LangiumDocument} into its {@link AstDocument}
    * envelope — the single place that reads `root` / `diagnostics` /
    * `version` / `uri` off a built document. Both the event path
    * ({@link AstDocumentManager.onUpdate} / `onSave`) and the read path
    * (`ModelService`'s snapshot accessors) go through here so the
    * field mapping lives once.
    *
    * The emitted `uri` is always the document's own `textDocument.uri` — the
    * canonical document-identity form (see {@link DocumentUriPolicy}). Events
    * carry that identity, not the subscriber's (possibly non-canonical) URI:
    * a subscriber already knows the URI it subscribed with, so the useful
    * thing to surface is the canonical one every other layer keys by.
    */
   export function from<TAst extends AstNode, TDiagnostic = unknown>(document: LangiumDocument): AstDocument<TAst, TDiagnostic> {
      return create<TAst, TDiagnostic>(
         document.textDocument.uri,
         document.textDocument.version,
         document.parseResult.value as TAst,
         (document.diagnostics ?? []) as unknown as TDiagnostic[]
      );
   }
}

/** Update event delivered by {@link AstDocumentManager.onUpdate} — typed alias over the generic event wrapper. */
export type AstDocumentUpdatedEvent<TAst extends AstNode, TDiagnostic> = TransferUpdatedEvent<AstDocument<TAst, TDiagnostic>>;

/** Save event delivered by {@link AstDocumentManager.onSave} — typed alias over the generic event wrapper. */
export type AstDocumentSavedEvent<TAst extends AstNode, TDiagnostic> = TransferSavedEvent<AstDocument<TAst, TDiagnostic>>;

/** Construction options for {@link AstDocumentManager}. */
export type AstDocumentManagerOptions = LogNameOptions;

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
export class AstDocumentManager<TAst extends AstNode = AstNode, TDiagnostic = unknown> {
   protected lastUpdate?: UpdateInfo;

   protected readonly textDocuments: HydraniumTextDocuments<TextDocument>;
   protected readonly fileSystemProvider: WritableFileSystemProvider;
   protected readonly langiumDocs: LangiumDocuments;
   protected readonly documentBuilder: DocumentBuilder;
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
      this.textDocuments.onDidOpen(event =>
         this.open({ clientId: event.clientId, uri: event.document.uri, languageId: event.document.languageId })
      );
      this.textDocuments.onDidClose(event => this.close({ clientId: event.clientId, uri: event.document.uri }));
      this.documentBuilder.onUpdate((changed, deleted) => {
         this.lastUpdate = { changed, deleted };
      });
      // Content transitions for CLOSED documents bypass the text store: the
      // last-close revert and watched-file changes rebuild from disk into a
      // factory-fresh text document carrying the factory's own version. At the
      // Parsed transition (the earliest phase with text, and one only re-read
      // documents pass through — cascade relinks re-enter later), reconcile the
      // store's persisted version sequence with the rebuilt content and
      // re-stamp the document so every downstream envelope (revert broadcast,
      // snapshot reads) carries the continued sequence. An empty-changes
      // update only re-stamps the version. Previously-untracked URIs exit on a
      // map lookup, so workspace-wide builds don't hash untouched documents.
      this.documentBuilder.onDocumentPhase(
         DocumentState.Parsed,
         labelPhaseListener(document => {
            const sequenceVersion = this.textDocuments.reconcileExternalContent(document.textDocument.uri, document.textDocument.getText());
            if (sequenceVersion !== undefined && document.textDocument.version !== sequenceVersion) {
               this.textDocuments.update(document.textDocument, [], sequenceVersion);
            }
         }, 'AstDocumentManager.reconcileExternalContent')
      );
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
         // Presentation boundary: the event field is a concrete `string`, so an
         // unauthored (framework-rebuilt) document surfaces the readable default
         // rather than `undefined` to subscribers and logs.
         const sourceClientId = this.getAuthor(document) ?? UNKNOWN_CLIENT_ID;
         const event: TransferUpdatedEvent<AstDocument<TAst, TDiagnostic>> = {
            document: this.toAstDocument(document),
            sourceClientId,
            reason: this.lastUpdate?.changed.find(changed => UriUtils.equals(changed, document.uri))
               ? 'changed'
               : this.lastUpdate?.deleted.find(deleted => UriUtils.equals(deleted, document.uri))
                 ? 'deleted'
                 : 'rebuilt'
         };
         this.tracer.with(uri).trace(`emitUpdate start: source=${sourceClientId}, reason=${event.reason}`);
         listener(event);
         this.tracer.with(uri).trace('emitUpdate listener returned');
      };
      return this.documentBuilder.onDocumentPhase(DocumentState.Validated, labelPhaseListener(emitUpdate, 'AstDocumentManager.onUpdate'));
   }

   /**
    * The client that authored `document`'s current version, or `undefined` when
    * no client wrote it — a framework-internal rebuild (workspace startup, a
    * cascade relink, a `didClose`-reload) or a genuine author gap. Honest about
    * absence so routing consumers (`ModelService.isNonLanguageClientEdit`)
    * test `undefined` directly rather than against a sentinel; the presentation
    * default ({@link UNKNOWN_CLIENT_ID}) is applied at the boundary that needs a
    * concrete value (the `onUpdate` event's `sourceClientId`, the data-server's
    * `resolveSourceClientId`).
    */
   getAuthor(document: LangiumDocument<AstNode>): string | undefined {
      return this.textDocuments.getAuthor(document.textDocument.uri, document.textDocument.version);
   }

   async open(args: OpenModelArgs): Promise<Disposable> {
      // `open()` is the RPC-level "ensure this document is loaded" call. It is issued
      // by a view attaching, but also internally by `update()` / `save()` and by every
      // additional client attaching to the same URI, including the several sub-editors
      // a composite view opens. When the document is already loaded there is nothing to
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
      // every first open. So an already-open `open()` is a no-op.
      if (!this.isOpen(args.uri)) {
         const textDocument = await this.createDocumentFromTextOrFileSystem(args.uri, args.languageId, args.version, args.text);
         this.textDocuments.notifyDidOpenTextDocument({ textDocument }, args.clientId);
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
   async update(uri: string, text: string, clientId: string): Promise<number> {
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
    * Throws if no document is open for `uri`.
    */
   async save(uri: string, clientId: string): Promise<void> {
      const document = this.textDocuments.get(uri);
      if (!document) {
         throw new Error(`Document ${uri} hasn't been opened for saving yet`);
      }
      const text = document.getText();
      await this.tracer.with(uri).time(
         `Write file (${text.length} bytes, from ${clientId})`,
         // Async write so a slow disk does not block the event loop for the duration of the fs call.
         () => this.fileSystemProvider.writeFile(UriUtils.toUri(uri), text),
         'debug'
      );
      this.textDocuments.notifyDidSaveTextDocument({ textDocument: TextDocumentIdentifier.create(uri), text }, clientId);
   }

   isOpen(uri: string): boolean {
      return !!this.textDocuments.get(uri);
   }

   /** True if the URI was in the directly-changed set of the most recent build (not just affected). */
   isDirectChange(uri: string): boolean {
      const canonical = this.uriPolicy.canonicalUri(uri);
      return this.lastUpdate?.changed.some(changed => this.uriPolicy.canonicalUri(changed) === canonical) ?? false;
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
      return { uri, languageId, version, text: text ?? (await this.readFile(uri)) };
   }

   async readFile(uri: string): Promise<string> {
      return this.fileSystemProvider.readFile(UriUtils.toUri(uri));
   }

   /**
    * Hook for subclasses that want to re-shape the emitted document (e.g. inject
    * a custom-typed `diagnostics` field). The default delegates to
    * {@link AstDocument.from}, the shared LangiumDocument→envelope projection.
    */
   protected toAstDocument(document: LangiumDocument): AstDocument<TAst, TDiagnostic> {
      return AstDocument.from<TAst, TDiagnostic>(document);
   }
}
