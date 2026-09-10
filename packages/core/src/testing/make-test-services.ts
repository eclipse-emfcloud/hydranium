/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import {
   type Clock,
   DefaultTracer,
   type Logger,
   NoopLogger,
   type Project,
   SystemClock,
   type Tracer,
   type TransferDiagnostic,
   type TransferElement
} from '@hydranium/protocol';
import { ServerLocale } from '../locale/server-locale.js';
import { ServerMessageRenderer } from '../messages/renderer.js';
import type { Harness } from '@hydranium/protocol/testing';
import { type AstNode, type AstNodeDescription, type WorkspaceLock } from '@hydranium/langium';
import type { ModelService, ModelServiceOptions } from '../langium/model-service/model-service.js';
import type { ServerSharedServices } from '../langium/module.js';
import { TransferEncoder } from '../langium/transfer/transfer-encoder.js';
import { DefaultDocumentUriPolicy, type DocumentUriPolicy } from '../langium/workspace/document-uri-policy.js';
import { HydraniumWorkspaceLock } from '../langium/workspace/hydranium-workspace-lock.js';
import type { FakeDocumentOptions } from './fake-document.js';
import { makeStubDocumentBuilder, type StubDocumentBuilder } from './stub-document-builder.js';
import { makeStubIndexManager, type StubIndexManager } from './stub-index-manager.js';
import { makeStubLangiumDocuments, type StubLangiumDocuments } from './stub-langium-documents.js';
import { makeStubModelService } from './stub-model-service.js';
import { makeStubAstDocumentManager, type StubAstDocumentManager } from './stub-ast-document-manager.js';
import { makeStubProjectManager, type StubProjectManager } from './stub-project-manager.js';
import { makeStubSelfSaveRegistry, type StubSelfSaveRegistry } from './stub-self-save-registry.js';
import { makeStubHydraniumTextDocuments, type StubHydraniumTextDocuments } from './stub-hydranium-text-documents.js';
import { makeStubServiceRegistry, type StubLanguageDescriptor, type StubServiceRegistry } from './stub-service-registry.js';
import { makeStubWritableFileSystem, type StubWritableFileSystem } from './stub-writable-file-system.js';

/**
 * Honest shape of the `services` tree assembled by {@link makeTestServices}.
 * Captures exactly the slots the bundle binds — narrower than the full
 * {@link ServerSharedServices} that production code consumes, with no
 * placeholder for slots that don't appear in the literal (`AstNodeLocator`,
 * `WorkspaceManager`, etc.). The boundary cast from this type
 * to `ServerSharedServices` in {@link makeTestServices} is therefore the
 * single named place where the "stub stands in for the full service tree"
 * assertion happens.
 */
export interface TestSharedServices<
   TAst extends AstNode = AstNode,
   TDiagnostic extends TransferDiagnostic = TransferDiagnostic,
   TTransfer extends TransferElement = TransferElement,
   TProject extends Project = Project
> {
   readonly Clock: Clock;
   readonly Logger: Logger;
   readonly Tracer: Tracer;
   /**
    * Present only when {@link MakeTestServicesOptions.languages} was passed.
    * Omitted otherwise so a bundle without declared languages keeps failing
    * loudly on the slot rather than answering from an empty registry — see
    * the option's doc for why that default is deliberate.
    */
   readonly ServiceRegistry?: StubServiceRegistry;
   readonly workspace: {
      LangiumDocuments: StubLangiumDocuments<TAst, TDiagnostic>;
      DocumentBuilder: StubDocumentBuilder;
      TextDocuments: StubHydraniumTextDocuments;
      AstDocumentManager: StubAstDocumentManager<TAst, TDiagnostic>;
      FileSystemProvider: StubWritableFileSystem;
      SelfSaveRegistry: StubSelfSaveRegistry;
      ProjectManager: StubProjectManager<TProject>;
      DocumentUriPolicy: DocumentUriPolicy;
      /**
       * Present only when {@link MakeTestServicesOptions.seedIndex} was passed.
       * Omitted otherwise for the same reason as `ServiceRegistry` — see that
       * option's doc.
       */
      IndexManager?: StubIndexManager;
      /**
       * The REAL `HydraniumWorkspaceLock`, not a stub — it is a few lines of
       * promise queueing with no I/O, and `ModelService`'s build path serialises
       * through it, so a no-op stub would hide exactly the interleaving the lock
       * exists to prevent. The framework subclass rather than Langium's default
       * because it also marks the write scope that `ModelService`'s reentrancy
       * guard reads; binding the default here would make the guard untestable
       * through this tree and let a reentrant write pass unnoticed.
       */
      WorkspaceLock: WorkspaceLock;
   };
   readonly model: {
      TransferEncoder: TransferEncoder<unknown, TDiagnostic>;
      ModelService: ModelService<TAst, TDiagnostic, TTransfer>;
   };
   /**
    * The REAL services, not stubs — the framework renderer's no-catalogue
    * behaviour is a pass-through, so the stub tree agrees with a production one
    * unless a test installs a catalogue. Bound rather than omitted because
    * `HydraniumDocumentBuilder` renders through the renderer on every
    * `Validated` phase, where an omitted slot is a `TypeError`.
    */
   readonly ServerLocale: ServerLocale;
   readonly MessageRenderer: ServerMessageRenderer;
}

/** Optional configuration for {@link makeTestServices}. */
export interface MakeTestServicesOptions<
   TAst extends AstNode = AstNode,
   TDiagnostic extends TransferDiagnostic = TransferDiagnostic,
   TTransfer extends TransferElement = TransferElement,
   TProject extends Project = Project
> {
   /**
    * Serialiser used by the bundled `StubModelService`. The stub tree
    * routes no per-language `Serializer` (the stub languages bind no-op slots),
    * so the framework's own serialize path is unavailable here — supply this
    * whenever a test asserts on the produced text.
    *
    * Default: `JSON.stringify(root)` — deterministic and grammar-free, suitable
    * for tests that don't assert on the produced text.
    */
   serialize?: (uri: string, root: TTransfer) => string;
   /**
    * Renderer bound on `MessageRenderer`. Default: the framework's own, which
    * passes every sentence through unchanged. Supply one to install a catalogue
    * or to drive the throwing path.
    */
   messageRenderer?: (services: ServerSharedServices<TProject>) => ServerMessageRenderer;
   /** Locale handed to the bundle's {@link ServerLocale}. Default: none, i.e. the framework's English. */
   locale?: string;
   /**
    * Languages to register on a {@link StubServiceRegistry} bound on the
    * `ServiceRegistry` slot. This is how a test gets multi-language routing:
    * production code under test then resolves per-URI through Langium's real
    * lookup ladder instead of a per-file hand-rolled registry object.
    *
    * **Default: no `ServiceRegistry` slot at all.** Binding an empty registry
    * by default would silently change behaviour for the tests that rely on the
    * slot being absent — `ModelService.updateRewriteService` optional-chains it
    * precisely for those bundles — so a registry appears only when a test asks
    * for one.
    */
   languages?: readonly StubLanguageDescriptor[];
   /**
    * Documents to declare open with a client-supplied `languageId`, as
    * `{ [uri]: languageId }`. Forwarded to {@link makeStubServiceRegistry};
    * only meaningful alongside {@link languages}.
    */
   openLanguageIds?: Readonly<Record<string, string>>;
   /**
    * Clock bound on the `Clock` shared slot. Pass `makeFakeClock()` to drive
    * time-gated logic deterministically; defaults to a real {@link SystemClock}.
    */
   clock?: Clock;
   /**
    * Logger bound on the `Logger` slot AND wrapped by the `Tracer` slot, so a
    * capturing logger sees both plain log lines and tracer-emitted timing/warn
    * lines. Defaults to a {@link NoopLogger}.
    */
   logger?: Logger;
   /** Initial documents to seed the {@link StubLangiumDocuments} with. */
   seedDocuments?: ReadonlyArray<{
      uri: string;
      root: TAst;
      options?: FakeDocumentOptions<TAst, TDiagnostic>;
   }>;
   /** Initial projects to seed the {@link StubProjectManager} with. */
   seedProjects?: readonly TProject[];
   /**
    * Global-index entries to seed a {@link StubIndexManager} with, bound on the
    * `IndexManager` slot. This is how a test reaches the global scope —
    * `DefaultScopeProvider` reads that slot — so a scope assertion can
    * distinguish "closed" from "falls through to the index".
    *
    * **Default: no `IndexManager` slot at all**, matching {@link languages}.
    * Binding an empty stub by default would answer every global-index read with
    * an empty result instead of failing on the unbound slot, which is the
    * silent-`undefined` failure the boundary cast below is annotated for; a
    * suite that never asks for an index would then pass for a new reason.
    */
   seedIndex?: readonly AstNodeDescription[];
   /**
    * Policy bound on the `DocumentUriPolicy` slot. Defaults to
    * {@link DefaultDocumentUriPolicy} (syntactic normalize). Pass a stub that
    * resolves chosen URIs to a shared canonical form to exercise the
    * symlink-divergence bridges without touching the filesystem.
    */
   documentUriPolicy?: DocumentUriPolicy;
   /**
    * Override the {@link ModelService} factory. Use for tests that want a
    * custom subclass with `normalize` / lifecycle hooks; the default builds
    * a `StubModelService` from `options.serialize`.
    */
   modelService?: (services: ServerSharedServices<TProject>) => ModelService<TAst, TDiagnostic, TTransfer>;
   /**
    * Framework {@link ModelServiceOptions} for the DEFAULT stub service, so a
    * test can reach an option-gated path (`serializeBuilds`, the slow-warn
    * threshold) without supplying a whole {@link modelService} factory. Ignored
    * when `modelService` is given — that factory owns its own construction.
    */
   modelServiceOptions?: ModelServiceOptions;
   /**
    * Override the {@link TransferEncoder} factory. Default: framework
    * {@link TransferEncoder} with no overrides.
    */
   transferEncoder?: (services: ServerSharedServices<TProject>) => TransferEncoder<unknown, TDiagnostic>;
}

/**
 * Bundle returned by {@link makeTestServices}. Exposes the assembled
 * {@link ServerSharedServices} tree plus every stub the bundle composed,
 * so tests can introspect or mutate the underlying state without re-wiring
 * the tree. Each stub member is named after the slot it is bound on.
 *
 * This is the core harness and satisfies the uniform {@link Harness}
 * contract — `services` is the **subject** (the assembled service tree the
 * production code under test runs against), the individual `*` stubs are the
 * **seam** (the doubles tests introspect / mutate), and `dispose()` is the
 * uniform teardown hook (a no-op: the stubs hold only in-memory state,
 * released with the bundle when it goes out of scope).
 */
export interface TestServicesBundle<
   TAst extends AstNode = AstNode,
   TDiagnostic extends TransferDiagnostic = TransferDiagnostic,
   TTransfer extends TransferElement = TransferElement,
   TProject extends Project = Project
> extends Harness {
   readonly services: ServerSharedServices<TProject>;
   readonly documents: StubLangiumDocuments<TAst, TDiagnostic>;
   readonly textDocuments: StubHydraniumTextDocuments;
   readonly astDocumentManager: StubAstDocumentManager<TAst, TDiagnostic>;
   readonly documentBuilder: StubDocumentBuilder;
   readonly fileSystem: StubWritableFileSystem;
   readonly selfSaveRegistry: StubSelfSaveRegistry;
   readonly projectManager: StubProjectManager<TProject>;
   readonly documentUriPolicy: DocumentUriPolicy;
   /**
    * The registry bound on the `ServiceRegistry` slot, or `undefined` when no
    * {@link MakeTestServicesOptions.languages} were declared.
    */
   readonly serviceRegistry: StubServiceRegistry | undefined;
   /**
    * The stub bound on the `IndexManager` slot, or `undefined` when no
    * {@link MakeTestServicesOptions.seedIndex} was passed.
    */
   readonly indexManager: StubIndexManager | undefined;
   readonly modelService: ModelService<TAst, TDiagnostic, TTransfer>;
   readonly transferEncoder: TransferEncoder<unknown, TDiagnostic>;
   readonly logger: Logger;
   /** The clock bound on the `Clock` slot — a `makeFakeClock()` if one was passed. */
   readonly clock: Clock;
   /**
    * The service bound on `ServerLocale`, so a test can hand over a locale
    * mid-run — which is also how it verifies the renderer reads the locale per
    * render rather than caching it at construction.
    */
   readonly serverLocale: ServerLocale;
   /** The renderer bound on `MessageRenderer` — the framework's own unless one was supplied. */
   readonly messageRenderer: ServerMessageRenderer;
}

/**
 * Build a {@link ServerSharedServices} tree backed by the framework's
 * testing stubs. The returned bundle exposes both the tree and the
 * individual stubs so tests can introspect.
 *
 * **Scope.** Langium-layer stubs only — no GLSP-shaped fixtures. Tests for
 * code that runs against real Langium services (grammar parsing, scope
 * computation, etc.) should keep using `bootstrapLangium(...)` rather than
 * this bundle.
 */
export function makeTestServices<
   TAst extends AstNode = AstNode,
   TDiagnostic extends TransferDiagnostic = TransferDiagnostic,
   TTransfer extends TransferElement = TransferElement,
   TProject extends Project = Project
>(
   options: MakeTestServicesOptions<TAst, TDiagnostic, TTransfer, TProject> = {}
): TestServicesBundle<TAst, TDiagnostic, TTransfer, TProject> {
   const documents = makeStubLangiumDocuments<TAst, TDiagnostic>(options.seedDocuments);
   const textDocuments = makeStubHydraniumTextDocuments();
   const documentBuilder = makeStubDocumentBuilder();
   const selfSaveRegistry = makeStubSelfSaveRegistry();
   const fileSystem = makeStubWritableFileSystem(selfSaveRegistry);
   const projectManager = makeStubProjectManager<TProject>(options.seedProjects);
   const astDocumentManager = makeStubAstDocumentManager<TAst, TDiagnostic>(textDocuments, fileSystem, documents);
   const logger = options.logger ?? new NoopLogger();
   const clock = options.clock ?? new SystemClock();
   const tracer = new DefaultTracer(logger, clock);
   const documentUriPolicy = options.documentUriPolicy ?? new DefaultDocumentUriPolicy();
   const serviceRegistry = options.languages
      ? makeStubServiceRegistry(options.languages, { openLanguageIds: options.openLanguageIds })
      : undefined;
   const indexManager = options.seedIndex ? makeStubIndexManager(options.seedIndex) : undefined;

   // Build the literal at its honest narrow type (TestSharedServices) so
   // signature drift on any of these slots produces a compile error here, then
   // cast at the boundary to ServerSharedServices so production consumers that
   // expect the full service tree can accept it. The cast is `as unknown as`
   // because TestSharedServices is structurally narrower (no AstNodeLocator,
   // IndexManager, WorkspaceManager, …); production code that reads one of
   // those slots off the bundle fails at runtime.
   //
   // **So adding a new service READ to a production path means adding the slot
   // here too.** Nothing enforces it: the cast below erases the difference, so
   // the omission surfaces as a runtime `undefined` inside whichever package
   // happens to drive that path — typically several layers from the change, and
   // in a package that did not touch the edit. Prefer the REAL service when it
   // is dependency-free (as `HydraniumWorkspaceLock` is) — a no-op stub of a
   // synchronisation primitive hides the very interleaving it exists to prevent.
   //
   // `model.TransferEncoder` / `model.ModelService` are populated below
   // (after the factories run); the literal uses unsafe casts to
   // partially-built objects to satisfy TestSharedServices, then patches
   // them in.
   const services: TestSharedServices<TAst, TDiagnostic, TTransfer, TProject> = {
      Clock: clock,
      Logger: logger,
      Tracer: tracer,
      // Spread rather than assigned so the slot is genuinely ABSENT (not
      // present-and-undefined) when no languages were declared — `'ServiceRegistry'
      // in services` is what an optional-chaining production path effectively asks.
      ...(serviceRegistry ? { ServiceRegistry: serviceRegistry } : {}),
      workspace: {
         LangiumDocuments: documents,
         DocumentBuilder: documentBuilder,
         TextDocuments: textDocuments,
         AstDocumentManager: astDocumentManager,
         FileSystemProvider: fileSystem,
         SelfSaveRegistry: selfSaveRegistry,
         ProjectManager: projectManager,
         DocumentUriPolicy: documentUriPolicy,
         // Spread for the same reason as `ServiceRegistry` above — the slot must
         // be genuinely ABSENT, not present-and-undefined, when no index was seeded.
         ...(indexManager ? { IndexManager: indexManager } : {}),
         WorkspaceLock: new HydraniumWorkspaceLock()
      },
      model: {} as TestSharedServices<TAst, TDiagnostic, TTransfer, TProject>['model'],
      ServerLocale: {} as ServerLocale,
      MessageRenderer: {} as ServerMessageRenderer
   };
   const sharedServices = services as unknown as ServerSharedServices<TProject>;

   // Patched in after the literal, like `model` below: both read the tree they
   // belong to, and the renderer reads the locale service.
   const mutableMessages = services as { ServerLocale: ServerLocale; MessageRenderer: ServerMessageRenderer };
   const serverLocale = new ServerLocale(sharedServices);
   if (options.locale) {
      serverLocale.accept(options.locale);
   }
   mutableMessages.ServerLocale = serverLocale;
   const messageRenderer = options.messageRenderer?.(sharedServices) ?? new ServerMessageRenderer(sharedServices);
   mutableMessages.MessageRenderer = messageRenderer;

   const serialize = options.serialize ?? ((_uri: string, root: TTransfer) => JSON.stringify(root));
   const transferEncoder = options.transferEncoder
      ? options.transferEncoder(sharedServices)
      : new TransferEncoder<unknown, TDiagnostic>(sharedServices);
   const modelService = options.modelService
      ? options.modelService(sharedServices)
      : makeStubModelService<TAst, TDiagnostic, TTransfer>(sharedServices, serialize, options.modelServiceOptions);

   const mutableModel = services.model as {
      TransferEncoder: TransferEncoder<unknown, TDiagnostic>;
      ModelService: ModelService<TAst, TDiagnostic, TTransfer>;
   };
   mutableModel.TransferEncoder = transferEncoder;
   mutableModel.ModelService = modelService;

   return {
      services: sharedServices,
      documents,
      textDocuments,
      astDocumentManager,
      documentBuilder,
      fileSystem,
      selfSaveRegistry,
      projectManager,
      documentUriPolicy,
      serviceRegistry,
      indexManager,
      modelService,
      transferEncoder,
      logger,
      clock,
      serverLocale,
      messageRenderer,
      dispose: () => {
         // No-op: the bundled stubs hold only in-memory state (maps, arrays),
         // released with the bundle when it goes out of scope. The hook exists
         // to satisfy the uniform Harness contract so teardown is always
         // `harness.dispose()` regardless of which harness.
      }
   };
}
