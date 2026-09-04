/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { type Marker, MarkerKind } from '@eclipse-glsp/protocol';
import { type AstNode } from '@hydranium/langium';
import { Diagnostic, DiagnosticSeverity } from 'vscode-languageserver-types';
import { type TransferLspDiagnostic } from '@hydranium/core';

/**
 * The model-shaped lookups the diagnostic→marker translation needs, injected so
 * the pure mapping can be unit-tested without GLSP/Langium DI. The validator
 * wires them to the live services.
 */
export interface DiagnosticMarkerLookups {
   /**
    * Resolve a diagnostic's `element` AST-path (as produced by
    * `AstNodeLocator.getAstNodePath`) to its node in the current source root,
    * or `undefined` if it no longer resolves.
    */
   resolveElement(elementPath: string): AstNode | undefined;
   /**
    * The GModel ids that currently render `node` on this diagram. Usually one,
    * but a single AST element can be drawn as several nodes, and then every
    * representing node is marked. Empty when `node` is not drawn here.
    */
   renderedIdsFor(node: AstNode): readonly string[];
}

/**
 * Translate the current document's LSP diagnostics into GLSP {@link Marker}s
 * for the diagram.
 *
 * Each diagnostic's `element` path is resolved to an AST node; if that node is
 * not drawn on this diagram, the mapping walks up the `$container` chain to the
 * nearest ancestor that is, and marks every GModel node representing it — so a
 * deeply nested error still surfaces, on the innermost drawn container, at each
 * of its occurrences. A diagnostic whose element — and every ancestor — is
 * absent from this diagram is dropped: the model may span several diagrams, and
 * the text editor / Problems view still report it.
 *
 * The full set is recomputed on every call; callers dispatch it under a single
 * `MarkersReason` so a fresh `SetMarkersAction` replaces the previous markers
 * (an empty result clears them when all errors are fixed).
 */
export function diagnosticsToMarkers(diagnostics: readonly TransferLspDiagnostic[], lookups: DiagnosticMarkerLookups): Marker[] {
   const markers: Marker[] = [];
   for (const diagnostic of diagnostics) {
      const kind = markerKind(diagnostic.severity);
      // LSP 3.18 allows a `MarkupContent` message; GLSP markers are plain text.
      const message = Diagnostic.getMessageString(diagnostic);
      for (const elementId of renderedElementIds(diagnostic.element, lookups)) {
         markers.push({ elementId, kind, label: message, description: message });
      }
   }
   return markers;
}

/**
 * The ids of the elements drawn on this diagram for the diagnostic's target,
 * starting at the node it points at and walking up its containers; empty when
 * the path does not resolve or nothing on the chain is rendered.
 */
function renderedElementIds(elementPath: string, lookups: DiagnosticMarkerLookups): readonly string[] {
   let node: AstNode | undefined = lookups.resolveElement(elementPath);
   while (node !== undefined) {
      const ids = lookups.renderedIdsFor(node);
      if (ids.length > 0) {
         return ids;
      }
      node = node.$container;
   }
   return [];
}

/** Map an LSP {@link DiagnosticSeverity} to a GLSP {@link MarkerKind}; unset severity is treated as an error. */
function markerKind(severity: DiagnosticSeverity | undefined): string {
   switch (severity) {
      case DiagnosticSeverity.Warning:
         return MarkerKind.WARNING;
      case DiagnosticSeverity.Information:
      case DiagnosticSeverity.Hint:
         return MarkerKind.INFO;
      case DiagnosticSeverity.Error:
      default:
         return MarkerKind.ERROR;
   }
}
