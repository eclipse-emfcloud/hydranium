/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { MarkerKind } from '@eclipse-glsp/protocol';
import { describe, expect, it } from 'vitest';
import type { AstNode } from '@hydranium/langium';
import { DiagnosticSeverity } from 'vscode-languageserver-types';
import type { TransferLspDiagnostic } from '@hydranium/core';
import { makeFakeAstNode } from '@hydranium/core/testing';
import { type DiagnosticMarkerLookups, diagnosticsToMarkers } from '../src/validation/diagnostic-markers.js';

/** Minimal AST-node fake with an optional container link for ancestor-walk tests. */
function node(type: string, container?: AstNode): AstNode {
   return makeFakeAstNode<AstNode>({ $type: type, $container: container });
}

function diagnostic(overrides: Partial<TransferLspDiagnostic> & Pick<TransferLspDiagnostic, 'element'>): TransferLspDiagnostic {
   return {
      message: 'boom',
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
      severity: DiagnosticSeverity.Error,
      ...overrides
   };
}

/**
 * Build the lookups from plain maps:
 * - `paths`: diagnostic element-path → AST node
 * - `renderedIds`: AST node → the GModel ids drawn for it (already rendered-filtered;
 *   a node may map to several ids since one element can be drawn as multiple nodes)
 */
function lookups(paths: Map<string, AstNode>, renderedIds: Map<AstNode, string[]>): DiagnosticMarkerLookups {
   return {
      resolveElement: path => paths.get(path),
      renderedIdsFor: astNode => renderedIds.get(astNode) ?? []
   };
}

describe('diagnosticsToMarkers', () => {
   it('maps a diagnostic onto the single element that renders it', () => {
      const element = node('Element');
      const markers = diagnosticsToMarkers(
         [diagnostic({ element: 'elements@0', message: 'duplicate name' })],
         lookups(new Map([['elements@0', element]]), new Map([[element, ['e1']]]))
      );
      expect(markers).toEqual([{ elementId: 'e1', kind: MarkerKind.ERROR, label: 'duplicate name', description: 'duplicate name' }]);
   });

   it('emits one marker per rendered node when an element is drawn several times', () => {
      // A single element projected as two nodes in the same diagram → both get marked.
      const element = node('Element');
      const markers = diagnosticsToMarkers(
         [diagnostic({ element: 'elements@0', message: 'dup', severity: DiagnosticSeverity.Warning })],
         lookups(new Map([['elements@0', element]]), new Map([[element, ['nodeA', 'nodeB']]]))
      );
      expect(markers).toEqual([
         { elementId: 'nodeA', kind: MarkerKind.WARNING, label: 'dup', description: 'dup' },
         { elementId: 'nodeB', kind: MarkerKind.WARNING, label: 'dup', description: 'dup' }
      ]);
   });

   it('returns an empty array for no diagnostics (clears markers when all errors are fixed)', () => {
      expect(diagnosticsToMarkers([], lookups(new Map(), new Map()))).toEqual([]);
   });

   it('maps each LSP severity to the matching GLSP marker kind', () => {
      const target = node('X');
      const base = lookups(new Map([['x', target]]), new Map([[target, ['x1']]]));
      const kindFor = (severity: DiagnosticSeverity | undefined): string =>
         diagnosticsToMarkers([diagnostic({ element: 'x', severity })], base)[0].kind;
      expect(kindFor(DiagnosticSeverity.Error)).toBe(MarkerKind.ERROR);
      expect(kindFor(DiagnosticSeverity.Warning)).toBe(MarkerKind.WARNING);
      expect(kindFor(DiagnosticSeverity.Information)).toBe(MarkerKind.INFO);
      expect(kindFor(DiagnosticSeverity.Hint)).toBe(MarkerKind.INFO);
      expect(kindFor(undefined)).toBe(MarkerKind.ERROR);
   });

   it('bubbles to the nearest ancestor that renders when the exact element is not drawn', () => {
      const element = node('Element');
      const child = node('Child', element);
      const leaf = node('Leaf', child);
      // only the outer element is drawn; the child and leaf are not
      const markers = diagnosticsToMarkers(
         [diagnostic({ element: 'elements@0/children@2/leaf', message: 'unresolved leaf' })],
         lookups(new Map([['elements@0/children@2/leaf', leaf]]), new Map([[element, ['e1']]]))
      );
      expect(markers).toEqual([{ elementId: 'e1', kind: MarkerKind.ERROR, label: 'unresolved leaf', description: 'unresolved leaf' }]);
   });

   it('prefers the exact element over an ancestor when both render', () => {
      const element = node('Element');
      const child = node('Child', element);
      const markers = diagnosticsToMarkers(
         [diagnostic({ element: 'elements@0/children@2' })],
         lookups(
            new Map([['elements@0/children@2', child]]),
            new Map([
               [element, ['e1']],
               [child, ['e1.children.2']]
            ])
         )
      );
      expect(markers.map(marker => marker.elementId)).toEqual(['e1.children.2']);
   });

   it('drops a diagnostic when neither the element nor any ancestor renders on this diagram', () => {
      const element = node('Element');
      const child = node('Child', element);
      const markers = diagnosticsToMarkers(
         [diagnostic({ element: 'elements@5/children@0' })],
         lookups(new Map([['elements@5/children@0', child]]), new Map())
      );
      expect(markers).toEqual([]);
   });

   it('drops a diagnostic whose element path does not resolve to a node', () => {
      const markers = diagnosticsToMarkers(
         [diagnostic({ element: 'elements@99' })],
         lookups(new Map(), new Map([[node('X'), ['anything']]]))
      );
      expect(markers).toEqual([]);
   });

   it('emits markers for every diagnostic, preserving each message even when bubbled', () => {
      const element = node('Element');
      const child = node('Child', element);
      const markers = diagnosticsToMarkers(
         [
            diagnostic({ element: 'elements@0', message: 'outer issue', severity: DiagnosticSeverity.Warning }),
            diagnostic({ element: 'elements@0/children@0', message: 'inner issue' })
         ],
         lookups(
            new Map([
               ['elements@0', element],
               ['elements@0/children@0', child]
            ]),
            new Map([[element, ['e1']]])
         )
      );
      expect(markers).toEqual([
         { elementId: 'e1', kind: MarkerKind.WARNING, label: 'outer issue', description: 'outer issue' },
         { elementId: 'e1', kind: MarkerKind.ERROR, label: 'inner issue', description: 'inner issue' }
      ]);
   });
});
