/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { UriUtils, URI } from '@hydranium/langium';
// Bare `'path'` (not `node:path`) so a browser bundle can alias it to a POSIX
// shim — this is the only filesystem-path use left on the portable `.` entry,
// and it's the headless/CLI string-input convenience of `toWorkspaceFolders`.
import * as path from 'path';
import type { InitializeParams, InitializedParams, WorkspaceFolder } from 'vscode-languageserver';
import type { ServerSharedServicesMinimal } from '../shared-services.js';

/** A workspace folder root accepted by the headless init seams: a filesystem path or a {@link URI}. */
export type WorkspaceFolderInput = string | URI;

/**
 * Normalize the seam's flexible folder argument to LSP {@link WorkspaceFolder}s.
 * A `string` is resolved to an absolute filesystem path and wrapped as a
 * `file:` URI; a {@link URI} is taken as-is. `name` is the URI's basename.
 */
function toWorkspaceFolders(folders: WorkspaceFolderInput | ReadonlyArray<WorkspaceFolderInput>): WorkspaceFolder[] {
   const list = Array.isArray(folders) ? folders : [folders as WorkspaceFolderInput];
   return list.map(entry => {
      const uri = typeof entry === 'string' ? URI.file(path.resolve(entry)) : entry;
      return { uri: uri.toString(), name: UriUtils.basename(uri) };
   });
}

/**
 * Initialize a hydranium workspace **without an LSP `initialize` request** —
 * the headless counterpart to the editor entry. Drives the workspace manager's
 * own lifecycle methods: sets the workspace folders, then runs the
 * lock-protected discovery + standard init build.
 *
 * Leaves the workspace exactly as an LSP `initialize`/`initialized` pair would:
 * `ProjectManager.discoverProjects` has run, the project registry is populated,
 * and the init build has covered every document in the workspace folders —
 * including the project descriptors, which `HydraniumWorkspaceManager.performStartup`
 * back-fills because Langium's traversal drops URIs discovery already created a
 * document for. Documents outside the folders (a contributed library document
 * seeded elsewhere, a URI a client opens later) still build on demand; use
 * {@link buildWorkspaceProgrammatically} to force every registered document
 * built regardless of where it came from. The eager build pipeline (integrity,
 * AST extensions) is wired at bootstrap (`DEFAULT_EAGER_SERVICES`), not here, so
 * it is already active.
 *
 * Client-only LSP-init steps (configuration fetch, server-capability
 * negotiation, `onInitialize`/`onInitialized` events) are intentionally not
 * reproduced — a headless server has no client and they degrade gracefully.
 *
 * Invoke once during headless startup; this is not a re-initialization API.
 * Errors from discovery/build propagate to the caller.
 *
 * @param services the shared services tree the workspace manager lives on
 * @param folders one or more workspace roots (filesystem paths or URIs)
 */
export async function initializeWorkspaceProgrammatically(
   services: ServerSharedServicesMinimal,
   folders: WorkspaceFolderInput | ReadonlyArray<WorkspaceFolderInput>
): Promise<void> {
   const workspaceFolders = toWorkspaceFolders(folders);
   const manager = services.workspace.WorkspaceManager;
   // `initialize` records the folders (DefaultWorkspaceManager reads only this
   // field); `initialized` runs `mutex.write(initializeWorkspace)` and resolves
   // once discovery + the init build settle, so awaiting it is the ready gate.
   manager.initialize({ workspaceFolders } as InitializeParams);
   await manager.initialized({} as InitializedParams);
}

/**
 * {@link initializeWorkspaceProgrammatically} **and then build every registered
 * document to `Validated`** — the "fully-built workspace" convenience for
 * headless consumers (test harnesses, eager batch tools) that want every
 * registered document linked + validated, not only the ones inside a workspace
 * folder.
 *
 * The trailing `DocumentBuilder.build(..., { validation: true })` over
 * `LangiumDocuments.all` picks up anything the init build did not reach —
 * documents registered from outside the folders. For a workspace whose content
 * the init build already covered it is effectively idempotent, since the builder
 * skips documents already at the target state.
 *
 * Use {@link initializeWorkspaceProgrammatically} instead when you only need the
 * project registry populated (e.g. listing projects) and want documents to build
 * on demand, as an editor session does.
 *
 * @param services the shared services tree the workspace manager lives on
 * @param folders one or more workspace roots (filesystem paths or URIs)
 */
export async function buildWorkspaceProgrammatically(
   services: ServerSharedServicesMinimal,
   folders: WorkspaceFolderInput | ReadonlyArray<WorkspaceFolderInput>
): Promise<void> {
   await initializeWorkspaceProgrammatically(services, folders);
   const documents = services.workspace.LangiumDocuments.all.toArray();
   await services.workspace.DocumentBuilder.build(documents, { validation: true });
}
