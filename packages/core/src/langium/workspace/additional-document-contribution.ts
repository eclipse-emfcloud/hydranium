/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { type MaybePromise } from '@hydranium/protocol';
import { type AstNode, type LangiumDocument } from '@hydranium/langium';
import { type WorkspaceFolder } from 'vscode-languageserver-types';

/**
 * Registry handed to an {@link AdditionalDocumentContribution} — a pure sink,
 * like the AST-extension / integrity / scope registries: the workspace
 * {@link folders} being initialized plus a {@link register} sink that seeds each
 * built document into the workspace.
 *
 * Transient, unlike those lifetime-held registries: their registrations are
 * *consulted repeatedly* (per build, per scope query), so the owning service
 * holds them; additional documents are seeded *once* at startup — nothing
 * consults them later — so the workspace manager materialises this registry
 * during `loadAdditionalDocuments` (the only point Langium's document collector
 * is in scope) and discards it.
 *
 * The registry does NOT hand over a `LangiumDocumentFactory`: a contribution is
 * DI-instantiated with `services` (the standard contribution pattern) and reads
 * `services.workspace.LangiumDocumentFactory` itself to build its documents.
 */
export interface AdditionalDocumentRegistry {
   /**
    * The workspace folders being initialized (empty for a folderless init) —
    * the same input Langium hands `loadAdditionalDocuments`. Lets a contribution
    * key its documents off the workspace (per-folder libraries,
    * workspace-relative resolution).
    */
   readonly folders: readonly WorkspaceFolder[];
   /** Seed a built document into the workspace (indexed like any startup document). */
   register(document: LangiumDocument<AstNode>): void;
}

/**
 * Declarative registration of additional startup documents — the contribution
 * form of overriding `DefaultWorkspaceManager.loadAdditionalDocuments`. Bound
 * under the shared `additionalDocuments` group; the framework workspace manager
 * reads its own group during startup and calls this method, handing in a
 * transient {@link AdditionalDocumentRegistry}.
 *
 * A registered document is added to the workspace and indexed like any file, so
 * its exported symbols reach the global scope with no manual scope extension.
 * For a virtual (`virtualUri`) document with no owning project, that indexing
 * classifies it universal-tier (visible everywhere) — the standard way to
 * contribute a stdlib / library / built-in set.
 *
 * The domain-qualified method name lets a single cross-cutting class implement
 * several contribution interfaces without method collision.
 */
export interface AdditionalDocumentContribution {
   registerAdditionalDocuments(registry: AdditionalDocumentRegistry): MaybePromise<void>;
}

/**
 * Iterate an {@link AdditionalDocumentContribution} group, handing each a
 * transient registry (workspace `folders` + a `register` sink) and seeding the
 * registered documents through `collect`. Awaits each contribution so async
 * document construction is supported. Pure over its inputs (no services / DI)
 * so it is unit-testable; the framework workspace manager calls it from
 * `loadAdditionalDocuments`.
 */
export async function collectAdditionalDocuments(
   contributions: Record<string, AdditionalDocumentContribution>,
   folders: readonly WorkspaceFolder[],
   collect: (document: LangiumDocument<AstNode>) => void
): Promise<void> {
   const registry: AdditionalDocumentRegistry = { folders, register: collect };
   for (const contribution of Object.values(contributions)) {
      await contribution.registerAdditionalDocuments(registry);
   }
}
