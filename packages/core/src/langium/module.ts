/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { type Clock, type Logger, type Project, type Tracer, NoopLogger, SystemClock } from '@hydranium/protocol';
import { DefaultServerLocale, type ServerLocale } from '../locale/server-locale.js';
import { DefaultMessageRenderer, type MessageRenderer } from '../messages/renderer.js';
import { ServerTracer } from './diagnostics/server-tracer.js';
import { HydraniumLangiumProfiler } from './diagnostics/hydranium-langium-profiler.js';
import { type AstNode, type Module } from '@hydranium/langium';
import { type DefaultSharedModuleContext, type LangiumSharedServices, type PartialLangiumSharedServices } from '@hydranium/langium/lsp';
import { type TextDocument } from 'vscode-languageserver-textdocument';
import { DefaultModelService, type ModelService } from './model-service/model-service.js';
import { type ProjectManager } from './project/project-manager.js';
import { SingleProjectManager } from './project/single-project-manager.js';
import { DefaultTransferEncoder, type TransferEncoder } from './transfer/transfer-encoder.js';
import { HydraniumDocumentBuilder } from './document-builder/document-builder.js';
import { DefaultBuildPipelineIntegration, type BuildPipelineIntegration } from './document-builder/build-pipeline-integration.js';
import { type BuildPhasePassContribution } from './build-phase-pass/build-phase-pass.js';
import { type BuildPhasePassService, DefaultBuildPhasePassService } from './build-phase-pass/build-phase-pass-service.js';
import { DefaultCstResidencyService, type CstResidencyService } from './residency/index.js';
import { HydraniumIndexManager } from './workspace/index-manager.js';
import { HydraniumWorkspaceManager } from './workspace/hydranium-workspace-manager.js';
import { HydraniumWorkspaceLock } from './workspace/hydranium-workspace-lock.js';
import { HydraniumLangiumDocumentFactory } from './workspace/hydranium-langium-document-factory.js';
import { type HydraniumDocumentRegistry, HydraniumLangiumDocuments } from './workspace/langium-documents.js';
import { type AdditionalDocumentContribution } from './workspace/additional-document-contribution.js';
import { DefaultDocumentUriPolicy, type DocumentUriPolicy } from './workspace/document-uri-policy.js';
import { HydraniumTextDocuments } from '../documents/hydranium-text-documents.js';
import { DefaultAstDocumentManager, type AstDocumentManager, type WritableFileSystemProvider } from '../documents/ast-document-manager.js';
import { DefaultSelfSaveRegistry, type SelfSaveRegistry } from '../documents/self-save-registry.js';
import { DefaultEmptyFileSystemProvider } from './workspace/file-system-provider.js';
import { type ServerLanguageServices } from './language-module.js';
import { ExtendedServiceRegistry } from './service-registry.js';

/**
 * Shared services that `@hydranium/core`'s default shared module
 * always provides.
 *
 * All protocol heads (lsp-server, data-server, glsp-server) read from
 * these shared services; per-head shared bindings, if any, are
 * contributed by additional modules layered after this one.
 */
export interface ServerAddedSharedServices<TProject extends Project = Project> {
   /**
    * Injectable time source. Framework default is {@link SystemClock} (real
    * `Date.now` / `performance.now` / `setTimeout`); tests bind a fake to
    * make time-gated logic (debounce, slow-warn, timeouts, the self-save
    * TTL) deterministic. A dedicated top-level slot — not under `client` —
    * because it is general infrastructure, not a client-facing concern like
    * {@link Logger}.
    */
   Clock: Clock;
   /**
    * Typed override of Langium's `ServiceRegistry` slot returning
    * {@link ServerLanguageServices} (incl. the typed
    * `serializer.Serializer` slot) so per-URI per-language lookups are
    * type-safe. Bound to {@link ExtendedServiceRegistry} by default, which
    * layers typed-metadata, string-id, file-extension, per-target and
    * producible-type lookups over the URI-keyed API it inherits from Langium.
    * Adopters extending with their own accessors subclass
    * {@link ExtendedServiceRegistry} with a narrower TServices that extends
    * `ServerLanguageServices`; method-bivariance preserves
    * assignability under `--strictFunctionTypes`.
    *
    * Typed as `ExtendedServiceRegistry` rather than the
    * `HydraniumServiceRegistry` base because framework heads route by
    * producible type, which only the extended class answers. The base stays
    * exported for adopters composing a registry outside this slot.
    */
   /* override */ ServiceRegistry: ExtendedServiceRegistry<ServerLanguageServices>;
   /**
    * Emission-only cross-head logger. A dedicated top-level slot —
    * pervasive injectable infrastructure, like {@link Clock}, consumed
    * everywhere with no client relationship. Framework default is
    * {@link NoopLogger}; each protocol head binds its platform sink
    * (`LspLogger`, `ChannelLogger`, `GlspClientLogger`).
    */
   Logger: Logger;
   /**
    * Measure-and-emit observability: timing ({@link Tracer.time}/`startTimer`),
    * memory readout, and aggregate {@link Tracer.profile} sessions. A dedicated
    * top-level slot beside {@link Clock} and {@link Logger} — the same category
    * of pervasive injectable infrastructure. Composes the {@link Logger} (emit
    * sink) and {@link Clock} (time source); it is NOT a Logger, so services that
    * both log and time hold both slots. Framework default is the server
    * {@link ServerTracer} (rich `process.memoryUsage` rendering + memory-delta
    * timing suffix + cancellation-aware categorisation); other heads bind a
    * plain `DefaultTracer` with their own `MemoryReader`.
    */
   Tracer: Tracer;
   /**
    * Renders each user-facing message once, before the server sends it — so
    * every message is rendered by the side that knows the reading user's
    * language. All three heads inherit one diagnostics pass, which is what
    * makes this the single slot an adopter with i18n rebinds; the same binding
    * serves framework codes and their own `defineMessage` codes alike.
    *
    * The framework ships English only and selects no locale, so the default
    * returns every sentence unchanged. Adopters subclass and override
    * `translationsFor`.
    */
   MessageRenderer: MessageRenderer;
   /**
    * The locale an init handed the server, for whoever renders in it. Held
    * apart from the renderer so replacing the renderer cannot drop locale
    * handling.
    */
   ServerLocale: ServerLocale;
   /**
    * LSP-bound slots layered on top of Langium's `LangiumSharedLSPServices`.
    * The framework contributes a single string slot here —
    * `lsp.configurationRoot`, the section name used by
    * `Settings.value` and the LspLogger logLevel option
    * when the call site does not pass an explicit `root`. Langium's
    * own `lsp` slots (`Connection`, `LanguageServer`, …) flow through
    * unchanged via the intersection in {@link ServerSharedServices}.
    *
    * Defaults to the first registered language's id, falling back to
    * `'plaintext'` when no language is registered. Single-grammar
    * adopters never need to rebind. Multi-grammar adopters rebind with a function
    * that dispatches by some adopter-defined predicate — or instead
    * pass an explicit `root` argument to every `Settings.value` call,
    * leaving the slot at its default.
    */
   lsp: {
      configurationRoot: string;
   };
   workspace: {
      /* override */ TextDocuments: HydraniumTextDocuments<TextDocument>;
      /* override */ WorkspaceManager: HydraniumWorkspaceManager;
      /**
       * Narrow Langium's registry slot to the framework surface, which adds
       * `createEmptyDocument` — reachable only through this narrowing, and
       * wanted by a scope provider querying a URI before the file exists.
       */
      /* override */ LangiumDocuments: HydraniumDocumentRegistry;
      /**
       * Narrow Langium's `IndexManager` slot to the framework subclass, which
       * layers an `elementsByName` map over Langium's index and exposes
       * `getElementByName` / `resolveElement` / `resolveElementByName` — an O(1)
       * name lookup instead of streaming `allElements()`. Bound by default so
       * neither adopters nor framework code has to fall back to that scan.
       */
      /* override */ IndexManager: HydraniumIndexManager;
      /**
       * Narrow Langium's `DocumentBuilder` slot to the framework
       * subclass — adopters inherit URI flattening + cascade deletes,
       * the `awaitDocumentState` bug-fix, framework-wired phase logs,
       * and the `markNextReason` observability primitive without
       * binding the slot explicitly. The
       * `HydraniumDocumentUpdateHandler`'s `dispatch` calls this
       * slot's `markNextReason` to stage the LSP event that triggered
       * the build, for a subclass's build logging to tag its line with,
       * so narrowing here is a load-bearing type contract — adopters who
       * explicitly downgrade to Langium's default lose that call site's
       * compile-time target.
       */
      /* override */ DocumentBuilder: HydraniumDocumentBuilder;
      /**
       * Narrow Langium's `WorkspaceLock` slot to the framework subclass, which
       * marks its write action as a write-lock scope. That is what lets
       * `ModelService` detect the one shape the lock cannot survive — a facade
       * write reached from inside a build, which cancels its own enclosing
       * build — instead of stalling. Behaviourally identical to
       * `DefaultWorkspaceLock` in every other respect, and the detection is
       * inert unless a host installs a scope tracker.
       */
      /* override */ WorkspaceLock: HydraniumWorkspaceLock;
      /**
       * Tighten Langium's read-only `FileSystemProvider` slot to
       * {@link WritableFileSystemProvider}. The framework's save path
       * ({@link AstDocumentManager.save}, integrity corrections,
       * `ModelService.save`) requires write semantics — a read-only slot
       * type forces an `as WritableFileSystemProvider` cast at the binding
       * line and defers the failure of a read-only implementation to the
       * first save. The `.`-entry default is
       * {@link DefaultEmptyFileSystemProvider}, which is what keeps the core
       * barrel free of `node:fs` and therefore browser-bundleable; a Node host
       * binds `@hydranium/core/node`'s Node-backed provider (wired to
       * {@link SelfSaveRegistry}) instead, and adopters override with their own
       * writable implementation when neither fits.
       */
      /* override */ FileSystemProvider: WritableFileSystemProvider;
      ProjectManager: ProjectManager<TProject>;
      SelfSaveRegistry: SelfSaveRegistry;
      /**
       * The workspace's URI-interpretation strategy — how an external URI maps
       * to the canonical document-identity key and to the load URI. The
       * framework keys documents across three layers — the multi-client text
       * store, the {@link AstDocumentManager} event filters, and
       * `LangiumDocuments` lookups — and they must agree on one identity per
       * file. This slot is the single seam those bridges resolve URIs through.
       *
       * Default binding {@link DefaultDocumentUriPolicy} (syntactic
       * `UriUtils.normalize`, matching Langium's `DefaultLangiumDocuments`).
       * Adopters whose `LangiumDocuments` resolves symlinks / linked files to
       * a real path bind `RealpathDocumentUriPolicy` (or their own
       * equivalent) so every layer keys by the same stronger form — otherwise
       * a subscriber on a symlinked file gets save events but no update events.
       */
      DocumentUriPolicy: DocumentUriPolicy;
      /**
       * AST-document lifecycle facade over {@link HydraniumTextDocuments}.
       * Reads `services.workspace.FileSystemProvider`, and resolves each
       * document's language id per URI through the `ServiceRegistry` —
       * answering the sole registered language for an unregistered URI when
       * there is only one, and `'plaintext'` when there are several, rather
       * than naming a language the document demonstrably is not. Consumers
       * that need to narrow the diagnostic type or override lifecycle
       * behaviour rebind this slot with a subclass.
       */
      AstDocumentManager: AstDocumentManager<AstNode, unknown>;
      /**
       * Wires the framework's build-time features (integrity, AST
       * enrichment) into Langium's build pipeline: owns the build-phase
       * listeners and routes each document to the relevant feature
       * service. Eagerly constructed via `DEFAULT_EAGER_SERVICES`
       * so the listeners attach before the first build. Adopters subclass
       * to wire an additional phase or change how a feature is invoked.
       */
      BuildPipelineIntegration: BuildPipelineIntegration;
      /**
       * Priority-ordered registry of batch-level build-phase passes — the
       * `onBuildPhase` sibling of the per-node `AstExtensionService`
       * (`onDocumentPhase`) and `IntegrityService`. {@link BuildPipelineIntegration}
       * drives it from its phase listeners; the framework self-registers its
       * integrity passes and the Langium profiler flush into it, and adopters
       * contribute via the shared {@link ServerAddedSharedServices.buildPhasePasses}
       * group. A single priority space orders framework and adopter passes
       * against one another deterministically.
       */
      BuildPhasePassService: BuildPhasePassService;
      /**
       * CST residency policy: sheds the concrete syntax tree of closed
       * documents (keeping the AST resident) to reclaim memory, re-parsing
       * on demand when a shed document re-enters a build. Self-registers a
       * `Validated` {@link BuildPhasePassService} pass in its constructor, so
       * it is eagerly constructed via `DEFAULT_EAGER_SERVICES`. Framework
       * default is `{ kind: 'always-keep' }` (a no-op — the pass runs but sheds
       * nothing); adopters rebind the slot with a subclass or a different
       * strategy (`shed-closed-when-idle`) to enable shedding.
       */
      CstResidencyService: CstResidencyService;
   };
   /**
    * In-process workspace facade ({@link ModelService}) + AST→transfer
    * encoder ({@link TransferEncoder}). DI-bound so adopters rebind with
    * subclasses (typed-overlay encoders, normalisation hooks). Protocol
    * heads read both slots from shared services rather than constructor
    * arguments.
    *
    * `TransferEncoder` is the INTERFACE, not `DefaultTransferEncoder` — an
    * adopter can therefore REPLACE this declaration (see
    * {@link WithServiceOverrides}) rather than intersect with it, which is what
    * keeps slot resolution independent of the order a services type is written
    * in. `ModelService` is still a class and does not yet have that property.
    *
    * A class in a slot costs two things, both measured. Its `protected` members
    * join every assignability check and are compared NOMINALLY, so a subclass
    * declared against a second physical copy of this package cannot satisfy it.
    * And where the class is generic over a map reached through `keyof`, that
    * parameter is measured INVARIANT — instantiations then relate only when
    * their arguments are mutually assignable, which no adopter map is with the
    * framework's. Neither survives on an interface.
    */
   model: {
      TransferEncoder: TransferEncoder;
      ModelService: ModelService<AstNode, unknown>;
   };
   /**
    * Shared contribution group for batch-level build-phase passes (see
    * `ServerAddedSharedServices.workspace.BuildPhasePassService`). Adopters
    * deep-merge their own `BuildPhasePassContribution`s here, ordered against the
    * framework's own passes by priority. The framework binds an empty default so
    * the slot always resolves; adopters that contribute none never touch it.
    */
   buildPhasePasses: Record<string, BuildPhasePassContribution>;
   /**
    * Shared contribution group for additional startup documents — the
    * declarative form of overriding `DefaultWorkspaceManager.loadAdditionalDocuments`.
    * {@link HydraniumWorkspaceManager} reads this group during startup and lets
    * each {@link AdditionalDocumentContribution} build in-memory documents (via
    * the bound `LangiumDocumentFactory`, typically under a `virtualUri`)
    * and seed them into the workspace. A registered document is indexed like any
    * file, so its exported symbols reach the global scope with no manual scope
    * extension — the standard way to contribute a stdlib / built-in set. The
    * framework binds an empty default so the slot always resolves; adopters that
    * contribute none never touch it.
    */
   additionalDocuments: Record<string, AdditionalDocumentContribution>;
}

/**
 * Shared services exposed by `@hydranium/core` to all protocol heads.
 *
 * Built as `LangiumSharedServices ∩ ServerAddedSharedServices` with
 * `workspace.TextDocuments` and `ServiceRegistry` pre-omitted from the
 * Langium side. Both are overridden with narrower types; a naive
 * intersection where both sides declare the same slot resolves method
 * return types to the wider parent and loses the framework narrowing
 * at the call site. Pre-omitting lets the framework bindings survive
 * the intersection — `TextDocuments` keeps the
 * `ClientTextDocumentChangeEvent` payload (with `clientId`);
 * `ServiceRegistry.getServices(uri)` keeps the
 * {@link ServerLanguageServices} return shape.
 */
export type ServerSharedServices<TProject extends Project = Project> = Omit<LangiumSharedServices, 'workspace' | 'ServiceRegistry'> & {
   workspace: Omit<LangiumSharedServices['workspace'], 'TextDocuments' | 'DocumentBuilder'>;
} & ServerAddedSharedServices<TProject>;

/**
 * The service-tree namespaces — the keys whose value groups further slots
 * rather than being a slot itself.
 *
 * Consumed by {@link WithServiceOverrides} to know where to merge one level
 * deeper. **Add a namespace to {@link ServerAddedSharedServices} and you must
 * add it here**, and the failure of forgetting is silent in the direction that
 * matters: an unlisted namespace is treated as a leaf, so an adopter overriding
 * one slot inside it replaces the WHOLE namespace and loses the sibling slots
 * with no diagnostic. The reverse mistake — listing a leaf — fails loudly.
 */
type ServiceNamespace = 'lsp' | 'workspace' | 'model';

/**
 * Compose an adopter's service tree so its declarations REPLACE the framework's
 * rather than intersecting with them.
 *
 * Langium composes services by intersection, which accumulates: two
 * declarations of one slot survive as an overload set, and which one a call
 * resolves to depends on the order the intersection was written in — silently,
 * with no diagnostic at the point a reorder changes it. There is no override
 * operator for intersections, so the framework's declaration has to be removed
 * before the adopter's is added. This does that, one level deep for each
 * {@link ServiceNamespace}, so a narrowed slot replaces its framework twin
 * while its siblings survive.
 *
 * Only slots typed as INTERFACES can be replaced this way. A class-typed slot
 * drags its `protected` members into the assignability check — compared
 * nominally — so an adopter subclass does not satisfy it and the framework's
 * declaration cannot be dropped.
 */
export type WithServiceOverrides<TBase, TOverrides> = Omit<TBase, keyof TOverrides> & {
   [K in keyof TOverrides]: K extends ServiceNamespace
      ? K extends keyof TBase
         ? Omit<TBase[K], keyof TOverrides[K]> & TOverrides[K]
         : TOverrides[K]
      : TOverrides[K];
};

/**
 * Construction context for {@link createServerSharedModule}.
 *
 * Pass-through extension of Langium's `DefaultSharedModuleContext` —
 * kept as a named type so future framework-level configuration can be
 * added without breaking the factory's call signature. The same
 * context is consumed by each protocol head's module factory
 * (`createLspServerLanguageModule`, etc.), so callers wire it up once
 * and pass it to every factory in their `inject(...)` composition.
 *
 * Adopters defining a custom `fileSystemProvider` factory whose body
 * reads framework slots (`services.workspace.SelfSaveRegistry`,
 * `services.Logger`, …) wrap it in `serverSharedFactory`.
 * The slot's static type stays at Langium's `LangiumSharedCoreServices`,
 * while the runtime tree is always the framework-extended one (the
 * composition wires every framework slot before any factory runs). That
 * gap is Langium's to close, not ours; `serverSharedFactory` is where the
 * framework absorbs it, so no adopter writes the cast itself.
 */
export type ServerModuleContext = DefaultSharedModuleContext;

/**
 * `@hydranium/core`'s default shared module. Provides the language-independent
 * bindings declared by {@link ServerAddedSharedServices}; consumers compose it
 * with Langium's default shared module, their grammar-generated shared module
 * and their own customizations.
 *
 * The order matters — `createServerSharedModule` provides framework
 * defaults, and the consumer's module merges *after* to override
 * (later-wins). Putting consumer-side overrides before the framework
 * module silently squashes them.
 *
 * Returned as a function (not a constant) so future framework defaults
 * can read from the construction context.
 */
export function createServerSharedModule(
   context: ServerModuleContext
): Module<ServerSharedServices, PartialLangiumSharedServices & ServerAddedSharedServices> {
   return {
      Clock: () => new SystemClock(),
      // `services` is what revives Langium's declared-languageId lookup rung.
      // The registry holds it without dereferencing, so this does NOT make the
      // registry construction-time dependent on `workspace.TextDocuments`,
      // which would close a DI cycle back to here through
      // Logger → Settings → lsp.configurationRoot.
      ServiceRegistry: services => new ExtendedServiceRegistry<ServerLanguageServices>(services),
      Logger: () => new NoopLogger(),
      Tracer: services => new ServerTracer(services.Logger, services.Clock),
      ServerLocale: services => new DefaultServerLocale(services),
      MessageRenderer: services => new DefaultMessageRenderer(services),
      // Bind Langium's per-grammar-rule / per-`$type` parse/link/validate
      // profiler (the data the framework's own `Tracer`/`ProfileSession` passes
      // cannot produce), routed through our `Logger` and debug-gated. At the
      // default `info` level `HydraniumLangiumProfiler.isActive` short-circuits
      // every Langium guard to `false`, so no task is created — zero production
      // cost; flipping to `debug` at runtime turns it on without a restart. Lives
      // in the Langium-native `profilers` slot (NOT the top-level `Tracer`: a
      // Tracer is the observability handle, a profiler is a separate concern).
      profilers: {
         LangiumProfiler: services => new HydraniumLangiumProfiler(services)
      },
      lsp: {
         // The `'plaintext'` fallback exists so the framework boots in
         // degenerate test harnesses; in a real adopter it signals a missing
         // module compose (the grammar-generated shared module never ran),
         // hence the warning.
         configurationRoot: services => {
            const languages = services.ServiceRegistry.all;
            const [first] = languages;
            if (first) {
               if (languages.length > 1) {
                  // Arbitrary: registration order decides which language's id
                  // becomes the configuration section every `Settings.value`
                  // read resolves against. Warn rather than throw — the pick is
                  // harmless for an adopter whose settings live under one
                  // section anyway, and throwing would break booting a second
                  // grammar without touching settings.
                  //
                  // Deferred to a microtask because `Logger` resolves THIS slot
                  // (for its own log threshold), so warning inline is a DI
                  // cycle: Logger → Settings.value → configurationRoot →
                  // Logger. By the time the microtask runs this factory has
                  // returned and `Logger` resolves normally. Reaching the
                  // Logger lazily is the only option here — the whole point of
                  // the warning is that this factory ran at all.
                  queueMicrotask(() =>
                     services.Logger.warn(
                        `[hydranium] lsp.configurationRoot: ${languages.length} languages are registered ` +
                           `(${languages.map(language => language.LanguageMetaData.languageId).join(', ')}) and this slot is ` +
                           `not bound, so it defaulted to the FIRST registered id ('${first.LanguageMetaData.languageId}') — ` +
                           'registration order, not a decision. Bind `lsp.configurationRoot` explicitly to the section your ' +
                           'settings live under (that also silences this warning), or pass an explicit `root` to each ' +
                           '`Settings.value` call.'
                     )
                  );
               }
               return first.LanguageMetaData.languageId;
            }
            services.Logger.warn(
               '[hydranium] lsp.configurationRoot: no languages registered on ServiceRegistry — ' +
                  "falling back to 'plaintext'. This usually means the grammar-generated shared " +
                  'module was not composed before `createServerSharedModule`, or no language was ' +
                  'registered via `ServiceRegistry.register`. Bind the slot explicitly to silence.'
            );
            return 'plaintext';
         }
      },
      workspace: {
         TextDocuments: services => new HydraniumTextDocuments(services),
         WorkspaceManager: services => new HydraniumWorkspaceManager(services),
         IndexManager: services => new HydraniumIndexManager(services),
         // Override Langium's factory so a `fromModel` (code-built) virtual
         // document retains serialized text via the per-language Serializer,
         // making it re-read-safe through the virtual-aware FileSystemProvider.
         LangiumDocumentFactory: services => new HydraniumLangiumDocumentFactory(services),
         // Langium's default routes through no identity seam and treats every
         // failed load alike, so leaving this unbound opts a server out of both
         // with nothing to signal it.
         LangiumDocuments: services => new HydraniumLangiumDocuments(services),
         DocumentBuilder: services => new HydraniumDocumentBuilder(services),
         // The write-lock scope this marks is inert unless a host installs a
         // scope tracker — `@hydranium/core/node` does.
         WorkspaceLock: () => new HydraniumWorkspaceLock(),
         ProjectManager: services => new SingleProjectManager(services),
         SelfSaveRegistry: services => new DefaultSelfSaveRegistry(services),
         DocumentUriPolicy: () => new DefaultDocumentUriPolicy(),
         // Writable filesystem with two paths:
         // - Adopter passed `context.fileSystemProvider` and it returned a
         //   writable implementation (has `writeFile`) — use it. Honours the
         //   Langium-conventional context channel for passing a custom backing
         //   (in-memory, browser, test stub like `DefaultEmptyFileSystemProvider`).
         // - Otherwise — the portable default `DefaultEmptyFileSystemProvider`
         //   (no-op writes, no disk access). Node hosts opt into real disk I/O
         //   by binding `@hydranium/core/node`'s `DefaultFileSystemProvider`
         //   (Node-backed, wired to `SelfSaveRegistry` so framework `writeFile`
         //   calls register their mtime and adopters can suppress the
         //   `didChangeWatchedFiles` echo) — typically via this same
         //   `context.fileSystemProvider` channel or by rebinding
         //   the slot. Keeping the `.`-entry default empty is what lets the
         //   core barrel stay free of `node:fs` (browser-bundleable); see the
         //   `@hydranium/core/node` carve.
         FileSystemProvider: services => {
            const fromContext = context.fileSystemProvider?.(services);
            if (fromContext && typeof (fromContext as Partial<WritableFileSystemProvider>).writeFile === 'function') {
               return fromContext as WritableFileSystemProvider;
            }
            return new DefaultEmptyFileSystemProvider(services);
         },
         AstDocumentManager: services => new DefaultAstDocumentManager(services),
         // Eagerly constructed, so its build-phase listeners attach before the
         // first build.
         BuildPipelineIntegration: services => new DefaultBuildPipelineIntegration(services),
         BuildPhasePassService: services => new DefaultBuildPhasePassService(services),
         // Eagerly constructed, so its `Validated` pass registers before the
         // first build.
         CstResidencyService: services => new DefaultCstResidencyService(services)
      },
      model: {
         // Generic walker — adopters with a typed `$type → wire shape` overlay
         // rebind this slot with a subclass.
         TransferEncoder: services => new DefaultTransferEncoder(services),
         ModelService: services => new DefaultModelService(services)
      },
      // Empty default so `services.buildPhasePasses` always resolves (Langium
      // throws on access to an unbound slot). The framework's own integrity /
      // profiler passes self-register imperatively, not here.
      buildPhasePasses: {},
      // Empty default so `services.additionalDocuments` always resolves.
      additionalDocuments: {}
   };
}
