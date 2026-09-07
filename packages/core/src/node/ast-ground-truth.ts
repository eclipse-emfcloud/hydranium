/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { AstUtils } from '@hydranium/langium';
import { type ServerSharedServicesMinimal } from '../langium/shared-services.js';
import { buildWorkspaceProgrammatically } from '../langium/workspace/initialize-workspace.js';

/** Options for {@link collectAstGroundTruth}. */
export interface AstGroundTruthOptions {
   /**
    * Create the language's shared services in-process. This is the only
    * language-specific input — a head passes its own `create<Lang>Services(fileSystem)`.
    */
   createServices: () => { shared: ServerSharedServicesMinimal };
   /** Workspace root (filesystem path or file URI) to build. */
   workspace: string;
}

/**
 * Live-model `$type` tally — the ground truth an offline heap snapshot is
 * validated against (the analyzer's `--validate <gt.json>` input). The shape is
 * deliberately the JSON contract the analyzer reads: a per-`$type` count plus the
 * document and node totals used to assert the snapshot was captured on the same
 * workspace.
 */
export interface AstGroundTruth {
   /** Number of `LangiumDocument`s in the built workspace. */
   documents: number;
   /** Total AST nodes across all documents (root included). */
   totalAstNodes: number;
   /** Count of AST nodes per `$type`. */
   byType: Record<string, number>;
}

/**
 * Headless live-model `$type` census — the browser-/socket-free counterpart to
 * walking the AST in the running server. Boots a head's Langium services
 * in-process via {@link AstGroundTruthOptions.createServices}, builds the
 * workspace, then streams every AST node and tallies it by `$type`.
 *
 * The result is the ground truth the offline heap analyzer validates a snapshot's
 * `$type` classification against (`hydranium-cli analyze-heap --validate`): the
 * snapshot is captured on a workspace, this census is run on the *same* workspace,
 * and matching counts confirm the classifier read the heap correctly. Pure
 * framework code: the only language-specific input is the service factory.
 */
export async function collectAstGroundTruth(options: AstGroundTruthOptions): Promise<AstGroundTruth> {
   const { shared } = options.createServices();
   await buildWorkspaceProgrammatically(shared, options.workspace);
   return tallyAstGroundTruth(shared);
}

/**
 * Tally the `$type` census over an ALREADY-built services tree — the pure core of
 * {@link collectAstGroundTruth}, split out so a harness that has already built the
 * workspace (e.g. `measureModelMemory`) can fold the ground truth into its bundle
 * without a second build.
 */
export function tallyAstGroundTruth(shared: ServerSharedServicesMinimal): AstGroundTruth {
   const documents = shared.workspace.LangiumDocuments.all.toArray();
   const byType: Record<string, number> = {};
   let totalAstNodes = 0;
   for (const document of documents) {
      for (const node of AstUtils.streamAst(document.parseResult.value)) {
         byType[node.$type] = (byType[node.$type] ?? 0) + 1;
         totalAstNodes += 1;
      }
   }
   return { documents: documents.length, totalAstNodes, byType };
}
