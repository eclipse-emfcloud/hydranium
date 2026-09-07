/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { MarkerKind } from '@eclipse-glsp/protocol';
import { ModelState } from '@eclipse-glsp/server';
import 'reflect-metadata';
import { Container } from 'inversify';
import { describe, expect, it } from 'vitest';
import type { AstNode } from '@hydranium/langium';
import { DiagnosticSeverity } from 'vscode-languageserver-types';
import type { ServerSharedServices } from '@hydranium/core';
import { makeFakeAstNode, makeNoopSharedServices } from '@hydranium/core/testing';
import { HydraniumGlspModelValidator } from '../src/validation/hydranium-glsp-model-validator.js';
import { HydraniumTypes } from '../src/state/hydranium-shared-core-services.js';

/** A loaded document with its root, diagnostics, and `element-path → node` resolution. */
interface FakeDoc {
   uri: string;
   diagnostics: unknown[];
   /** element-path → node, as the per-document AstNodeLocator would resolve it */
   nodesByPath?: Map<string, AstNode>;
}

interface Fakes {
   /** Whether the diagram has been loaded (sourceUri set). */
   loaded?: boolean;
   /** Every document currently in LangiumDocuments (resolvable via `getDocument`). */
   documents?: FakeDoc[];
   /**
    * The uris the index reports as contributing rendered elements (what
    * `index.renderedDocumentUris()` returns). Defaults to every document's uri,
    * so the validator scans them all unless a test narrows the set.
    */
   renderedUris?: string[];
   /** node → stable GModel id (what `index.findId` returns). */
   idsByNode?: Map<AstNode, string>;
   /** node → GModel ids registered as representing it (the reverse projection; one element may be drawn several times). */
   elementIds?: Map<AstNode, string[]>;
   /** GModel ids currently drawn on this diagram. */
   rendered?: Set<string>;
}

function createValidator(fakes: Fakes): HydraniumGlspModelValidator {
   const { loaded = true, documents = [], idsByNode = new Map(), elementIds = new Map(), rendered = new Set() } = fakes;
   const renderedUris = fakes.renderedUris ?? documents.map(doc => doc.uri);
   const byUri = new Map(documents.map(doc => [doc.uri, doc]));

   const sharedServices = makeNoopSharedServices<ServerSharedServices>({
      workspace: {
         LangiumDocuments: {
            // The validator resolves each rendered-document uri to its document.
            getDocument(uri: { toString(): string }): unknown {
               const doc = byUri.get(uri.toString());
               return doc
                  ? {
                       uri: doc.uri,
                       diagnostics: doc.diagnostics,
                       parseResult: { value: makeFakeAstNode<AstNode>({ $type: 'Root', $doc: doc.uri }) }
                    }
                  : undefined;
            }
         }
      },
      ServiceRegistry: {
         getServices: (uri: string) => ({
            workspace: {
               AstNodeLocator: {
                  getAstNode: (_root: AstNode, path: string): AstNode | undefined => byUri.get(uri)?.nodesByPath?.get(path)
               }
            }
         })
      }
   });
   const modelState = {
      sourceUri: loaded ? 'file:///m/diagram.a' : undefined,
      index: {
         renderedDocumentUris: (): readonly string[] => renderedUris,
         findId: (node: AstNode | undefined): string | undefined => (node ? idsByNode.get(node) : undefined),
         findElementIds: (node?: AstNode): readonly string[] => (node ? (elementIds.get(node) ?? []) : []),
         find: (id: string): object | undefined => (rendered.has(id) ? { id } : undefined)
      }
   };

   const container = new Container();
   container.bind(HydraniumTypes.SharedCoreServices).toConstantValue(sharedServices);
   container.bind(ModelState).toConstantValue(modelState as unknown as object);
   container.bind(HydraniumGlspModelValidator).toSelf().inSingletonScope();
   return container.get(HydraniumGlspModelValidator);
}

function diagnostic(element: string, severity: DiagnosticSeverity = DiagnosticSeverity.Error, message = 'boom'): unknown {
   return { element, message, severity, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } };
}

describe('HydraniumGlspModelValidator', () => {
   it("maps a diagnostic on the diagram's own document onto a rendered element", () => {
      const element = makeFakeAstNode<AstNode>({ $type: 'Element' });
      const validator = createValidator({
         documents: [
            {
               uri: 'file:///m/diagram.a',
               diagnostics: [diagnostic('elements@0', DiagnosticSeverity.Warning, 'dup')],
               nodesByPath: new Map([['elements@0', element]])
            }
         ],
         idsByNode: new Map([[element, 'e1']]),
         rendered: new Set(['e1'])
      });
      expect(validator.validate([], 'batch')).toEqual([{ elementId: 'e1', kind: MarkerKind.WARNING, label: 'dup', description: 'dup' }]);
   });

   it('maps a diagnostic from a DIFFERENT referenced document onto its rendered element', () => {
      // The cross-document case: the element (and its error) live in another
      // file, while the diagram's own document carries no diagnostic.
      const child = makeFakeAstNode<AstNode>({ $type: 'Child' });
      const validator = createValidator({
         documents: [
            { uri: 'file:///m/diagram.a', diagnostics: [] },
            {
               uri: 'file:///m/other.a',
               diagnostics: [diagnostic('elements@0/children@2', DiagnosticSeverity.Error, 'Must provide a unique id.')],
               nodesByPath: new Map([['elements@0/children@2', child]])
            }
         ],
         idsByNode: new Map([[child, 'element.child.2']]),
         rendered: new Set(['element.child.2'])
      });
      expect(validator.validate([], 'batch')).toEqual([
         {
            elementId: 'element.child.2',
            kind: MarkerKind.ERROR,
            label: 'Must provide a unique id.',
            description: 'Must provide a unique id.'
         }
      ]);
   });

   it('aggregates diagnostics across multiple documents, dropping those not drawn on this diagram', () => {
      const shown = makeFakeAstNode<AstNode>({ $type: 'Element' });
      const elsewhere = makeFakeAstNode<AstNode>({ $type: 'Element' });
      const validator = createValidator({
         documents: [
            {
               uri: 'file:///m/a.a',
               diagnostics: [diagnostic('e', DiagnosticSeverity.Error, 'on diagram')],
               nodesByPath: new Map([['e', shown]])
            },
            {
               uri: 'file:///m/b.a',
               diagnostics: [diagnostic('e', DiagnosticSeverity.Error, 'off diagram')],
               nodesByPath: new Map([['e', elsewhere]])
            }
         ],
         idsByNode: new Map([
            [shown, 'shown'],
            [elsewhere, 'elsewhere']
         ]),
         rendered: new Set(['shown'])
      });
      expect(validator.validate([], 'batch')).toEqual([
         { elementId: 'shown', kind: MarkerKind.ERROR, label: 'on diagram', description: 'on diagram' }
      ]);
   });

   it('skips a loaded document that contributes no rendered elements', () => {
      // The scoping optimization: a document with diagnostics that the index does
      // not report among `renderedDocumentUris()` is never resolved or scanned —
      // even if (hypothetically) one of its element ids were drawn.
      const ghost = makeFakeAstNode<AstNode>({ $type: 'Element' });
      const validator = createValidator({
         documents: [
            { uri: 'file:///m/diagram.a', diagnostics: [] },
            {
               uri: 'file:///m/ghost.a',
               diagnostics: [diagnostic('e', DiagnosticSeverity.Error, 'ghost')],
               nodesByPath: new Map([['e', ghost]])
            }
         ],
         renderedUris: ['file:///m/diagram.a'], // ghost.a not among the rendered docs
         idsByNode: new Map([[ghost, 'g1']]),
         rendered: new Set(['g1'])
      });
      expect(validator.validate([], 'batch')).toEqual([]);
   });

   it('maps an element diagnostic to the node registered as representing it (reference projection)', () => {
      // The node is keyed by the diagram-node id, not the element's stable id;
      // the element is reached only via the node's registered projection.
      const element = makeFakeAstNode<AstNode>({ $type: 'Element' });
      const validator = createValidator({
         documents: [
            {
               uri: 'file:///m/other.a',
               diagnostics: [diagnostic('element', DiagnosticSeverity.Error, 'The element name must be unique.')],
               nodesByPath: new Map([['element', element]])
            }
         ],
         idsByNode: new Map([[element, 'ElementStableId']]), // not rendered — the node uses the diagram-node id
         elementIds: new Map([[element, ['DiagramNode1']]]),
         rendered: new Set(['DiagramNode1'])
      });
      expect(validator.validate([], 'batch')).toEqual([
         {
            elementId: 'DiagramNode1',
            kind: MarkerKind.ERROR,
            label: 'The element name must be unique.',
            description: 'The element name must be unique.'
         }
      ]);
   });

   it('marks every node when one element is drawn multiple times in the diagram', () => {
      const element = makeFakeAstNode<AstNode>({ $type: 'Element' });
      const validator = createValidator({
         documents: [
            {
               uri: 'file:///m/other.a',
               diagnostics: [diagnostic('element', DiagnosticSeverity.Warning, 'dup')],
               nodesByPath: new Map([['element', element]])
            }
         ],
         elementIds: new Map([[element, ['NodeA', 'NodeB']]]),
         rendered: new Set(['NodeA', 'NodeB'])
      });
      expect(validator.validate([], 'batch')).toEqual([
         { elementId: 'NodeA', kind: MarkerKind.WARNING, label: 'dup', description: 'dup' },
         { elementId: 'NodeB', kind: MarkerKind.WARNING, label: 'dup', description: 'dup' }
      ]);
   });

   it('returns no markers when the model has not been loaded yet', () => {
      // The fixture is deliberately the marker-PRODUCING one from the first
      // case, with `loaded: false` the only difference: an empty `documents`
      // default would produce `[]` on its own, so the guard would be the one
      // thing the assertion could not see.
      const element = makeFakeAstNode<AstNode>({ $type: 'Element' });
      const validator = createValidator({
         loaded: false,
         documents: [
            {
               uri: 'file:///m/diagram.a',
               diagnostics: [diagnostic('elements@0', DiagnosticSeverity.Warning, 'dup')],
               nodesByPath: new Map([['elements@0', element]])
            }
         ],
         idsByNode: new Map([[element, 'e1']]),
         rendered: new Set(['e1'])
      });
      expect(validator.validate([], 'batch')).toEqual([]);
   });

   it('returns no markers when no document carries diagnostics', () => {
      expect(createValidator({ documents: [{ uri: 'file:///m/diagram.a', diagnostics: [] }] }).validate([], 'batch')).toEqual([]);
   });
});
