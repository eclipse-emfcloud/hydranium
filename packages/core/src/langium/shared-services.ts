/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import type { Clock, Logger, Project, Tracer } from '@hydranium/protocol';
import type { LangiumSharedCoreServices } from '@hydranium/langium';
import type { SelfSaveRegistry } from '../documents/self-save-registry.js';
import type { WritableFileSystemProvider } from '../documents/ast-document-manager.js';
import type { HydraniumDocumentRegistry } from './workspace/langium-documents.js';
import type { BuildPhasePassService } from './build-phase-pass/build-phase-pass-service.js';
import type { CstResidencyService } from './residency/cst-residency-service.js';
import type { BuildPipelineIntegration } from './document-builder/build-pipeline-integration.js';
import type { ProjectManager } from './project/project-manager.js';
import type { ExtendedServiceRegistry } from './service-registry.js';
import type { DocumentUriPolicy } from './workspace/document-uri-policy.js';
import type { HydraniumWorkspaceManager } from './workspace/hydranium-workspace-manager.js';
import type { AdditionalDocumentContribution } from './workspace/additional-document-contribution.js';

/**
 * Minimum shared-services shape every framework component reads from.
 *
 * Equivalent to Langium's `LangiumSharedCoreServices` enriched with the
 * framework additions that other framework services consume: the dedicated
 * {@link Clock}, {@link Logger} and {@link Tracer} top-level slots (injectable
 * time source, emission-only logger, and the measure-and-emit tracer composed
 * from the other two), the {@link AdditionalDocumentContribution} group, an
 * {@link ExtendedServiceRegistry}, and on `workspace` a writable file-system
 * provider plus {@link HydraniumWorkspaceManager}, {@link ProjectManager},
 * {@link SelfSaveRegistry}, {@link BuildPipelineIntegration},
 * {@link BuildPhasePassService}, {@link CstResidencyService} and
 * {@link DocumentUriPolicy}.
 *
 * Declared structurally (interface extends + intersection on nested slots)
 * so the full `ServerSharedServices` and any consumer-extended variant
 * satisfy it without import cycles. Framework components
 * that take `services` (workspace manager, index manager, document
 * builder, ...) all take this single shape rather than a one-off type each.
 *
 * The fuller `ServerSharedServices` extends this for the LSP-bound surface
 * (additional Langium services beyond core + the framework's full
 * `ServerAddedSharedServices` declaration). Consumers writing their own
 * framework component should prefer this minimal shape when they only need
 * core services + framework defaults.
 */
export interface ServerSharedServicesMinimal<TProject extends Project = Project> extends LangiumSharedCoreServices {
   Clock: Clock;
   Logger: Logger;
   Tracer: Tracer;
   /**
    * Contribution group of {@link AdditionalDocumentContribution}s the
    * {@link HydraniumWorkspaceManager} drives from `loadAdditionalDocuments` at
    * startup. The framework binds an empty default so the slot always resolves;
    * adopters deep-merge contributions that seed built-in / stdlib documents.
    */
   additionalDocuments: Record<string, AdditionalDocumentContribution>;
   /**
    * Narrows Langium's base `ServiceRegistry` slot to the framework impl the
    * framework always binds, so the abstaining lookups — `getServicesFor`
    * above all — are reachable from the minimal surface without a cast. The
    * generic stays at its `LangiumCoreServices` default: this shape is what a
    * component reads when it needs core services only, and the LSP-bound
    * surface re-narrows the same slot to
    * `ExtendedServiceRegistry<ServerLanguageServices>`.
    */
   ServiceRegistry: ExtendedServiceRegistry;
   workspace: LangiumSharedCoreServices['workspace'] & {
      // Writable (`realpath`/`mtimeMs`/`writeFile`) — the framework always binds
      // a writable provider; `RealpathDocumentUriPolicy` reads `realpath` here.
      FileSystemProvider: WritableFileSystemProvider;
      // Narrows Langium's base `WorkspaceManager` slot to the framework impl the
      // framework always binds, so `wsRelativePath` and the folder-walk are
      // reachable from the minimal surface without a cast.
      WorkspaceManager: HydraniumWorkspaceManager;
      // Same, for the registry: the framework always binds
      // `HydraniumLangiumDocuments`, and `createEmptyDocument` is reachable
      // only through this narrowing — a scope provider querying a URI before
      // the file exists is the caller that needs it.
      /* override */ LangiumDocuments: HydraniumDocumentRegistry;
      ProjectManager: ProjectManager<TProject>;
      SelfSaveRegistry: SelfSaveRegistry;
      BuildPipelineIntegration: BuildPipelineIntegration;
      BuildPhasePassService: BuildPhasePassService;
      CstResidencyService: CstResidencyService;
      DocumentUriPolicy: DocumentUriPolicy;
   };
}

/**
 * Adapt a factory that reads framework shared slots to a Langium
 * module-context slot, whose parameter is statically typed at Langium's
 * narrower `LangiumSharedCoreServices`.
 *
 * **Why a narrowing is needed at all.** `DefaultSharedModuleContext`'s factory
 * slots are Langium's, so they promise only Langium's core services. The tree
 * actually passed at runtime is always the framework-extended one — composition
 * wires every framework slot before any factory runs — but nothing in
 * Langium's types can say so. The gap is generic erasure at a seam the
 * framework does not own, not a modelling mistake, so it cannot be typed away;
 * it can only be performed in ONE place instead of at every call site.
 *
 * This is that place: adopters write a plain typed lambda rather than
 * repeating `services as ServerSharedServicesMinimal` per factory. The
 * callback's parameter is {@link ServerSharedServicesMinimal}, which the
 * fuller `ServerSharedServices` also satisfies.
 */
export function serverSharedFactory<TResult>(create: (services: ServerSharedServicesMinimal) => TResult): (services: unknown) => TResult {
   return services => create(services as ServerSharedServicesMinimal);
}
