/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { Deferred, type Logger, type Tracer } from '@hydranium/protocol';
import { DefaultWorkspaceManager, DocumentState, type LangiumDocument, UriUtils, type URI } from '@hydranium/langium';
import { type CancellationToken, type InitializeParams } from 'vscode-languageserver';
import type { WorkspaceFolder } from 'vscode-languageserver-types';
import { type LogNameOptions, resolveLogFilePlaceholder, toLogFileWorkspaceToken } from '../diagnostics/logger.js';
import type { ServerLocale } from '../../locale/server-locale.js';
import type { ProjectChangeEvent } from '../project/project-change-event.js';
import type { ProjectManager } from '../project/project-manager.js';
import type { ServerSharedServicesMinimal } from '../shared-services.js';
import type { WritableFileSystemProvider } from '../../documents/ast-document-manager.js';
import { type DocumentUriPolicy, findRealpathDivergence } from './document-uri-policy.js';
import { type AdditionalDocumentContribution, collectAdditionalDocuments } from './additional-document-contribution.js';
import { onProcessEvent } from '../../util/environment.js';

/**
 * Module-level guard so repeated workspace-manager construction (e.g.
 * test environments creating multiple instances across files) doesn't
 * pile up listeners on the `process` singleton.
 */
let operationCancelledSuppressionInstalled = false;

/**
 * The logger the installed listener routes through, re-pointed by every
 * install rather than captured by the first. A process hosts more than one
 * services tree — a test worker builds many, and a CLI subcommand spawns one
 * beside a running head — and a handler holding the first tree's logger sends
 * every later tree's genuine rejections to a logger nobody is reading.
 */
let operationCancelledSuppressionLogger: Logger | undefined;

/**
 * Decide what to do with a process-level unhandled promise rejection.
 *
 * Langium's internal `Symbol(OperationCancelled)` marker — emitted when a
 * `documentBuilder.build` is preempted by a concurrent write lock or
 * cancellation token — is benign and is swallowed silently (without it the
 * server logs spurious "Unhandled rejection" entries for cancellations that
 * are not errors).
 *
 * Every OTHER reason is re-surfaced through {@link Logger.error}. This matters
 * because Node disables its default crash/warn for ALL unhandled rejections as
 * soon as any `unhandledRejection` listener is registered — so a handler that
 * swallowed everything would make genuine unhandled rejections (real bugs)
 * vanish silently. Logging keeps them visible while preserving the server's
 * resilience (it does not re-crash the process).
 *
 * Pure and listener-free so it is unit-testable without touching the `process`
 * singleton; {@link installOperationCancelledSuppression} wires it up.
 */
export function handleProcessUnhandledRejection(reason: unknown, logger: Logger): void {
   if (typeof reason === 'symbol' && String(reason) === 'Symbol(OperationCancelled)') {
      return;
   }
   logger.error('Unhandled promise rejection: ' + (reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)));
}

/**
 * Install a process-level `unhandledRejection` listener that routes every
 * rejection through {@link handleProcessUnhandledRejection} — swallowing
 * Langium's `OperationCancelled` marker and logging everything else via the
 * supplied {@link Logger}.
 *
 * Idempotent — safe to call from every {@link HydraniumWorkspaceManager}
 * constructor. The `process` listener is installed at most once, because one
 * per tree would pile up on a singleton, but each call RE-POINTS the logger it
 * routes through: the listener reads it at rejection time rather than closing
 * over the first caller's, so the most recently built tree is the one that
 * hears about a genuine rejection.
 *
 * Applies to every Langium-based server that experiences concurrent builds.
 */
export function installOperationCancelledSuppression(logger: Logger): void {
   operationCancelledSuppressionLogger = logger;
   if (operationCancelledSuppressionInstalled) {
      return;
   }
   operationCancelledSuppressionInstalled = true;
   // Node-only: a browser worker has no `process` / `unhandledRejection` — the
   // accessor makes this a no-op there.
   onProcessEvent('unhandledRejection', reason => {
      if (operationCancelledSuppressionLogger) {
         handleProcessUnhandledRejection(reason, operationCancelledSuppressionLogger);
      }
   });
}

/**
 * Framework {@link DefaultWorkspaceManager} subclass that integrates the
 * project tier with Langium's workspace startup.
 *
 * ## Phase 0 — project discovery
 *
 * Overrides {@link performStartup} to await
 * {@link ProjectManager.discoverProjects} **before** Langium's standard
 * startup phases (additional documents → file traversal → workspace
 * documents). By the time `documentBuilder.build` runs, the project
 * registry is fully populated and every parsed document can resolve its
 * owning project via `projectManager.getProject(uri)`.
 *
 * Single-project consumers using `SingleProjectManager` pay no cost —
 * the override is a no-op resolve.
 *
 * Discovery has a side effect the startup sequence has to compensate for:
 * it reads each descriptor through `LangiumDocuments.getOrCreateDocument`,
 * so those documents already exist when Langium's traversal runs — and
 * Langium's traversal deliberately drops URIs that already have a document
 * ("ensure that the documents don't already exist"), so it never returns
 * them. {@link performStartup} adds them back; see the method comment for
 * what breaks without it.
 *
 * ## Cascade rebuild
 *
 * Subscribes to {@link ProjectManager.onProjectsChanged} in the
 * constructor. When a project's identity, version, or dependencies
 * change post-startup, the project manager emits the affected document
 * URIs (its own members plus any transitive dependents per the
 * `getAffectedProjects` hook). This manager re-runs
 * `DocumentBuilder.resetToState(doc, DocumentState.Changed)` on each
 * affected document so the next build cycle re-links them with the new
 * visibility scope.
 *
 * Descriptor URIs that triggered the cycle are intentionally excluded
 * from the affected set by `AbstractProjectManager.onBuildUpdate` —
 * re-adding them would loop.
 */
export class HydraniumWorkspaceManager extends DefaultWorkspaceManager {
   protected readonly projectManager: ProjectManager;
   protected readonly tracer: Tracer;

   /**
    * Deferred backing {@link workspaceInitialized}. The framework default
    * resolves it from {@link initializeWorkspace} once Langium's standard
    * workspace setup completes. Adopters that need to gate first-`didOpen`
    * on additional async work (project-scope discovery, schema fetch, etc.)
    * override {@link initializeWorkspace} and resolve / reject this Deferred
    * after their work completes.
    */
   protected readonly workspaceInitializedDeferred = new Deferred<unknown>();

   /**
    * Resolves when the workspace is ready to handle the first `didOpen`
    * event. `HydraniumTextDocuments.listen` awaits this promise inside its
    * `didOpen` handler so the gate is hit at first use, not at DI. The
    * framework resolves it from {@link initializeWorkspace}; adopters with
    * extra async init override `initializeWorkspace` to thread their work
    * before the resolve.
    */
   readonly workspaceInitialized: Promise<unknown> = this.workspaceInitializedDeferred.promise;

   protected readonly uriPolicy: DocumentUriPolicy;
   /** Handed the client's locale at init; read by whoever renders in it. */
   protected readonly serverLocale: ServerLocale;
   protected readonly writableFileSystemProvider: WritableFileSystemProvider;
   protected readonly additionalDocuments: Record<string, AdditionalDocumentContribution>;
   /** Registry consulted by {@link warnIfUnroutable} to check a seeded document routes. */
   protected readonly languageRegistry: ServerSharedServicesMinimal['ServiceRegistry'];

   constructor(services: ServerSharedServicesMinimal, options: LogNameOptions = {}) {
      super(services);
      this.projectManager = services.workspace.ProjectManager;
      this.projectManager.onProjectsChanged(event => this.onProjectsChanged(event));
      this.uriPolicy = services.workspace.DocumentUriPolicy;
      this.serverLocale = services.ServerLocale;
      this.writableFileSystemProvider = services.workspace.FileSystemProvider;
      this.additionalDocuments = services.additionalDocuments;
      this.languageRegistry = services.ServiceRegistry;
      this.tracer = services.Tracer.for(options.logName ?? 'WorkspaceManager').trace('instantiated');
      installOperationCancelledSuppression(this.tracer);
   }

   /**
    * Contribution form of Langium's `loadAdditionalDocuments`. Runs the base
    * behaviour first (a no-op unless a further subclass adds documents), then
    * lets every {@link AdditionalDocumentContribution} in the shared
    * `additionalDocuments` group build in-memory documents via the bound
    * `LangiumDocumentFactory` and seed them through Langium's `collector`
    * — so each is added to the workspace and indexed like a file-backed
    * document. Adopters contribute a stdlib / built-in set here instead of
    * overriding this method.
    */
   protected override async loadAdditionalDocuments(
      folders: WorkspaceFolder[],
      collector: (document: LangiumDocument) => void
   ): Promise<void> {
      await super.loadAdditionalDocuments(folders, collector);
      const contributions = Object.keys(this.additionalDocuments);
      if (contributions.length === 0) {
         return;
      }
      // Observable like the discovery / build-phase spans: one timed line
      // reporting how many contributions ran and how many documents they
      // seeded. `tags` is read at the done-emit, so the document count pushed
      // inside the callback appears in the log line.
      const tags: string[] = [`${contributions.length} contributions`];
      let documentCount = 0;
      await this.tracer.time(
         'Load additional documents',
         async () => {
            await collectAdditionalDocuments(this.additionalDocuments, folders, document => {
               documentCount++;
               this.warnIfUnroutable(document);
               collector(document);
            });
            tags.push(`${documentCount} documents`);
         },
         'info',
         { logAfterMs: 0, tags }
      );
   }

   /**
    * Warn when a seeded additional document's URI matches no registered
    * language.
    *
    * Such a document is added to the workspace and indexed, but every
    * per-language service is resolved per URI — so scope computation, naming,
    * validation and serialisation all fail to route to it, and it contributes
    * nothing to the scopes it was written to populate. Nothing else reports
    * this: the document exists, so no lookup errors, it is simply inert.
    *
    * The usual cause is a `virtualUri` with no file extension:
    * `virtualUri(contributor)` yields `virtual:<contributor>`, and routing has
    * nothing to match on — there is no extension, and a virtual document is
    * never open in `TextDocuments`, so the declared-languageId rung cannot
    * serve it either. The convention is to end the URI with a registered
    * extension by passing it as the last segment,
    * `virtualUri(contributor, 'name.<ext>')`.
    */
   protected warnIfUnroutable(document: LangiumDocument): void {
      if (this.languageRegistry.hasServices(document.uri)) {
         return;
      }
      const extensions = this.languageRegistry.all.flatMap(language => language.LanguageMetaData.fileExtensions);
      this.tracer.warn(
         `Additional document '${document.uri.toString()}' matches no registered language, so every per-language ` +
            'service (scope computation, naming, validation, serialization) will fail to route to it and it will ' +
            `contribute nothing to scopes. End its URI with a registered file extension (${extensions.join(', ')}); ` +
            'for a virtual document that means passing it as the last segment, `virtualUri(contributor, "name.<ext>")`.'
      );
   }

   protected override async performStartup(folders: WorkspaceFolder[]): Promise<LangiumDocument[]> {
      // Resolve the `{workspace}` file-tee placeholder (if configured) as early
      // as possible — before any build logging — so per-workspace log capture
      // names its file correctly and the buffered startup lines flush.
      this.resolveWorkspaceLogTarget(folders);
      // Snapshot the document set around discovery so the descriptor documents
      // it creates can be identified afterwards. Plain iteration rather than
      // stream operators, so the two passes work against any conforming
      // `LangiumDocuments`; both run once per workspace initialization, next to
      // a discovery walk of the whole tree.
      const beforeDiscovery = new Set<string>();
      for (const document of this.langiumDocuments.all) {
         beforeDiscovery.add(document.uri.toString());
      }
      // Phase 0: project discovery. By the time Langium's standard startup
      // runs below, `getProject(uri)` returns a definitive answer for every URI
      // that belongs to a discovered project.
      await this.projectManager.discoverProjects(folders);
      const discovered: LangiumDocument[] = [];
      for (const document of this.langiumDocuments.all) {
         if (!beforeDiscovery.has(document.uri.toString())) {
            discovered.push(document);
         }
      }
      const documents = await super.performStartup(folders);
      this.probePathDivergence(folders);
      return this.withDiscoveredDescriptors(documents, discovered);
   }

   /**
    * Add back the documents project discovery created that Langium's file
    * traversal then filtered out.
    *
    * `AbstractProjectManager.discoverProjects` has to parse each descriptor to
    * read it, which it does through `LangiumDocuments.getOrCreateDocument`.
    * Langium's `performStartup` traversal skips any URI that already has a
    * document, so every descriptor is missing from the list it returns — and
    * `initializeWorkspace` builds exactly that list.
    *
    * The consequence is not a slow first build but a WRONG one. Descriptor
    * documents stay at `Parsed` with nothing in the global index, while the
    * documents that did make the list run all the way through `Linked` against
    * that empty index. Every cross-document reference into a descriptor fails,
    * and the failure sticks: a later build skips documents already at
    * `Validated`, so nothing re-links them until the user edits the file.
    *
    * Invisible to an adopter whose descriptors ARE its model files (every file
    * is a descriptor, the returned list is empty, `build([])` is a no-op).
    * Fatal for one whose descriptors are a subset — a folder-scoped project
    * model, or a second grammar whose files are never descriptors.
    *
    * Only documents created by discovery are re-added: pre-existing ones are
    * either additional/library documents (already collected by
    * `loadAdditionalDocuments`) or leftovers from an earlier initialization,
    * and neither belongs in this build list.
    */
   protected withDiscoveredDescriptors(documents: LangiumDocument[], discovered: readonly LangiumDocument[]): LangiumDocument[] {
      if (discovered.length === 0) {
         return documents;
      }
      const collected = new Set(documents.map(document => document.uri.toString()));
      const missing = discovered.filter(document => !collected.has(document.uri.toString()));
      if (missing.length === 0) {
         return documents;
      }
      this.tracer.debug(`Re-adding ${missing.length} project-descriptor document(s) to the initial build.`);
      return [...missing, ...documents];
   }

   /**
    * One-shot startup diagnostic. Warns when a workspace root resolves through a
    * symlink / `..` / case variant, so the URI a client opens (`S`) diverges
    * from the canonical document identity (`R`) the build keys by — the
    * condition the {@link DocumentUriPolicy} seam exists to reconcile.
    * Probing the roots is sufficient and cheap: a divergent ancestor means every
    * file beneath it diverges, and the loaded documents' URIs are already
    * canonical (their original spelling is gone). Emits NOTHING for a plain
    * on-disk workspace, or a filesystem without `realpath` — so a non-empty line
    * is the empirical signal that a deployment actually exercises the divergence
    * machinery.
    */
   protected probePathDivergence(folders: WorkspaceFolder[]): void {
      if (!this.uriPolicy) {
         return;
      }
      for (const folder of folders) {
         const real = findRealpathDivergence(folder.uri, this.writableFileSystemProvider);
         if (!real) {
            continue;
         }
         const policyName = this.uriPolicy.constructor.name;
         const collapsed = this.uriPolicy.canonicalUri(folder.uri) === this.uriPolicy.canonicalUri(real);
         this.tracer.warn(
            `Workspace root '${folder.uri}' resolves through a symlink/'..'/case variant to '${real.toString()}', ` +
               `so client URIs under it diverge from canonical document identity. ` +
               (collapsed
                  ? `The bound ${policyName} collapses both spellings to one identity, so subscriptions stay consistent.`
                  : `The bound ${policyName} does NOT collapse them — the link and its target would become distinct documents.`)
         );
      }
   }

   /**
    * Resolve the `{workspace}` file-tee placeholder from the first workspace
    * folder. No-op when no folder is known or no `{workspace}`-templated log
    * target is configured. See {@link toLogFileWorkspaceToken} for the token
    * derivation — a log-capturing test harness uses the same function so the
    * server's file name and the harness's correlation key agree.
    */
   protected resolveWorkspaceLogTarget(folders: WorkspaceFolder[]): void {
      const first = folders[0];
      if (first) {
         resolveLogFilePlaceholder('workspace', toLogFileWorkspaceToken(first.uri));
      }
   }

   /**
    * Forward the locale the client declared, then Langium's own read of the
    * params. `DefaultWorkspaceManager.initialize` reads `workspaceFolders`
    * alone, so `params.locale` would otherwise be discarded — and this is the
    * only place it arrives, which the headless init seams route through too.
    *
    * **The ABSENT case is reported from here rather than from `ServerLocale`,
    * because this is the only end that can see it.** `accept` is not called
    * when no locale was declared — nor should it be, since `''` is a claim
    * about a language rather than the absence of one — so a log written there
    * covers one of the two outcomes and leaves the other looking like a server
    * that never reached init. Both lines are at `info` for the reason `accept`
    * gives: the framework ships no catalogue, so an undeclared locale and an
    * untranslated code produce the same English and the log is what separates
    * them.
    */
   override initialize(params: InitializeParams): void {
      if (params.locale) {
         this.serverLocale.accept(params.locale);
      } else {
         this.tracer.info("no locale declared at init — rendering messages in the framework's English");
      }
      super.initialize(params);
   }

   /**
    * Override of Langium's workspace setup to resolve / reject
    * {@link workspaceInitializedDeferred} once setup completes. Adopters with
    * extra async work override this method, do their work in a sub-helper,
    * and either delegate to `super.initializeWorkspace(...)` (preserving the
    * default resolve) or call `this.workspaceInitializedDeferred.resolve(...)`
    * themselves after the additional work finishes.
    */
   override async initializeWorkspace(folders: WorkspaceFolder[], cancelToken?: CancellationToken): Promise<void> {
      try {
         await super.initializeWorkspace(folders, cancelToken);
         this.workspaceInitializedDeferred.resolve(undefined);
      } catch (error) {
         this.workspaceInitializedDeferred.reject(error);
         throw error;
      }
   }

   /**
    * Default cascade-rebuild handler. Iterates {@link ProjectChangeEvent.affectedDocuments}
    * and resets each to {@link DocumentState.Changed} so the next build cycle
    * re-runs the pipeline (parse → link → validate) under the new project
    * visibility scope.
    *
    * Subclasses can override for additional behaviour (e.g. logging,
    * telemetry, custom rebuild policies); call `super` to preserve the
    * default cascade.
    */
   protected onProjectsChanged(event: ProjectChangeEvent): void {
      for (const uri of event.affectedDocuments) {
         const document = this.langiumDocuments.getDocument(uri);
         if (document) {
            this.documentBuilder.resetToState(document, DocumentState.Changed);
         }
      }
   }

   /**
    * Format a URI as a workspace-relative path suitable for log messages.
    * Returns the path relative to `workspace` when provided (defaults to the
    * first workspace folder's URI); falls back to the URI string when no
    * workspace folder is known. Adopters with a multi-workspace model or a
    * different display convention override on their workspace-manager
    * subclass.
    */
   wsRelativePath(uri: URI | string, workspace?: string): string;
   wsRelativePath(uri: URI | string, workspace = this.workspaceFolders?.[0]?.uri): string {
      return workspace ? UriUtils.relative(workspace, uri) : typeof uri === 'string' ? uri : uri.path.toString();
   }
}
