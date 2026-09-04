/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { type Marker } from '@eclipse-glsp/protocol';
import { type GModelElement, ModelState, type ModelValidator } from '@eclipse-glsp/server';
import { inject, injectable } from 'inversify';
import { type AstNode } from '@hydranium/langium';
import { URI } from '@hydranium/langium';
import { type ServerSharedServices, type TransferLspDiagnostic } from '@hydranium/core';
import { type AbstractHydraniumGlspState } from '../state/abstract-hydranium-glsp-state.js';
import { HydraniumTypes } from '../state/hydranium-shared-core-services.js';
import { type DiagnosticMarkerLookups, diagnosticsToMarkers } from './diagnostic-markers.js';

/**
 * Framework {@link ModelValidator} that surfaces the model server's LSP
 * diagnostics as GLSP diagram markers. Bound per diagram via
 * `DiagramModule.bindModelValidator()`; the framework submission handler also
 * pushes its output as a `SetMarkersAction` after every model submit so
 * markers refresh live (the GLSP client otherwise only re-requests markers on
 * the tool-palette validate command).
 *
 * The translation itself ({@link diagnosticsToMarkers}) is pure; this class
 * supplies its model-shaped lookups from the live services: the per-language
 * `AstNodeLocator` resolves a diagnostic's `element` path back to its AST node,
 * and the GModel index assigns the node's diagram id and reports whether that
 * id is currently drawn.
 *
 * **Cross-document.** A diagram routinely renders elements defined in *other*
 * documents, and their validation errors are published on those documents, not
 * on the diagram's own. The validator therefore scans the diagnostics of every
 * document the index reports as contributing a rendered element (the index's
 * `renderedDocumentUris`: the diagram's own document plus those reached via
 * reference projections) and lets the index's rendered-check keep only those
 * that map to an element drawn on this diagram; the rest fall away. The
 * `elements` argument of {@link validate} is ignored — the diagnostic set is
 * the source of truth, and the default `RequestMarkersAction` requests the
 * whole diagram anyway.
 */
@injectable()
export class HydraniumGlspModelValidator<TRoot extends AstNode = AstNode> implements ModelValidator {
   @inject(HydraniumTypes.SharedCoreServices) protected readonly sharedServices!: ServerSharedServices;
   @inject(ModelState) protected readonly modelState!: AbstractHydraniumGlspState<TRoot>;

   validate(_elements: GModelElement[], _reason?: string): Marker[] {
      return this.markers();
   }

   /**
    * Markers for everything drawn on this diagram, gathered from the
    * diagnostics of every document the index reports as contributing a
    * rendered element. Empty before the source model is loaded, and for any
    * diagnostic whose element is not rendered here.
    */
   markers(): Marker[] {
      // `sourceUri` is a definite-assignment field — undefined until the
      // storage load flow calls `setSourceRoot`. Guard so a marker request that
      // races initial load returns empty rather than scanning an empty index.
      if (!this.modelState.sourceUri) {
         return [];
      }
      const index = this.modelState.index;
      const markers: Marker[] = [];
      // Scan only the documents that contribute rendered elements, not every
      // loaded document. The rendered-check below still keeps only what is
      // drawn here.
      for (const uri of index.renderedDocumentUris()) {
         const document = this.sharedServices.workspace.LangiumDocuments.getDocument(URI.parse(uri));
         if (!document) {
            continue;
         }
         // Diagnostics are produced by the framework's `HydraniumDocumentValidator`,
         // which emits `TransferLspDiagnostic` (LSP `Diagnostic` + `element` path).
         // Parser/lexer diagnostics carry no `element`; the lookup drops them.
         const diagnostics = document.diagnostics as TransferLspDiagnostic[] | undefined;
         if (!diagnostics || diagnostics.length === 0) {
            continue;
         }
         const root = document.parseResult.value;
         const locator = this.sharedServices.ServiceRegistry.getServices(document.uri).workspace.AstNodeLocator;
         const lookups: DiagnosticMarkerLookups = {
            resolveElement: path => (path ? locator.getAstNode(root, path) : undefined),
            renderedIdsFor: astNode => {
               // A node renders as: every GModel element explicitly registered as
               // representing it (reference projections, possibly several), plus its
               // own stable id, for an element keyed directly by it. Keep only the
               // ids actually drawn on this diagram.
               const candidates = new Set(index.findElementIds(astNode));
               const stableId = index.findId(astNode);
               if (stableId !== undefined) {
                  candidates.add(stableId);
               }
               return [...candidates].filter(id => index.find(id) !== undefined);
            }
         };
         markers.push(...diagnosticsToMarkers(diagnostics, lookups));
      }
      return markers;
   }
}
