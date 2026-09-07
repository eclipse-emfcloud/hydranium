/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, expect, it } from 'vitest';
import { Disposable, type Project } from '@hydranium/protocol';
import { type AstNode, URI } from '@hydranium/langium';
import type { HydraniumLanguageServices } from '../../../src/langium/language-module.js';
import { DefaultNameProvider } from '../../../src/langium/naming/name-provider.js';
import { DefaultReferenceBuilder } from '../../../src/langium/scope/reference-builder.js';
import { makeFakeAstNode, makeNoopTracer, makeStubServiceRegistry } from '../../../src/testing/index.js';

type AnyNode = AstNode & Record<string, unknown>;

/** Walk to the container-less root — mirrors `AstUtils.findRootNode`. */
function findRoot(node: AnyNode): AnyNode {
   let current = node;
   while (current.$container) {
      current = current.$container as AnyNode;
   }
   return current;
}

const URI_PROJ_A = URI.parse('file:///workspace/projA/foo.a');
const URI_PROJ_B = URI.parse('file:///workspace/projB/bar.a');

const noopLogger = { for: () => noopLogger, trace: () => undefined };

/**
 * Build a {@link DefaultReferenceBuilder} over a real {@link DefaultNameProvider}
 * and a `ProjectManager` stub. `getProjectForNode` resolves a node's root
 * `$document` URI to a project (the builder's identity axis); `getProject(uri)`
 * backs the name provider's `referenceName` lookup; `isVisible` answers the
 * cross-project visibility gate.
 */
function buildBuilder(visibilityMatrix: Record<string, readonly string[]> = { projA: ['projA'], projB: ['projB'] }): {
   builder: DefaultReferenceBuilder;
   nameProvider: DefaultNameProvider;
   rootA: AnyNode;
   rootB: AnyNode;
   services: HydraniumLanguageServices;
} {
   const rootA = makeFakeAstNode<AnyNode>({ $type: 'Container', name: 'P' });
   Object.assign(rootA, { $document: { uri: URI_PROJ_A } });
   const rootB = makeFakeAstNode<AnyNode>({ $type: 'Container', name: 'Q' });
   Object.assign(rootB, { $document: { uri: URI_PROJ_B } });

   const getProject = (uri: URI | string): Project | undefined => {
      const str = typeof uri === 'string' ? uri : uri.toString();
      if (str === URI_PROJ_A.toString()) return { id: 'projA', referenceName: 'projA' };
      if (str === URI_PROJ_B.toString()) return { id: 'projB', referenceName: 'projB' };
      return undefined;
   };
   const services = {
      references: {},
      shared: {
         Logger: noopLogger,
         Tracer: makeNoopTracer(),
         workspace: {
            ProjectManager: {
               getProject,
               getProjectForNode: (node: AnyNode) => {
                  const uri = (findRoot(node) as unknown as { $document?: { uri: URI } }).$document?.uri;
                  return uri ? getProject(uri) : undefined;
               },
               isVisible: (source: string, target: string, selfVisible = false) => {
                  if (source === target) return selfVisible;
                  return visibilityMatrix[source]?.includes(target) ?? false;
               }
            },
            DocumentBuilder: { onUpdate: () => Disposable.EMPTY }
         }
      }
   } as unknown as HydraniumLanguageServices;
   const nameProvider = new DefaultNameProvider(services);
   (services.references as unknown as { NameProvider: DefaultNameProvider }).NameProvider = nameProvider;
   return { builder: new DefaultReferenceBuilder(services), nameProvider, rootA, rootB, services };
}

describe('DefaultReferenceBuilder', () => {
   it('toOwnReference returns the bare-name reference when the node has an own name', () => {
      const { builder, rootA } = buildBuilder();
      const member = makeFakeAstNode<AnyNode>({ $type: 'TypeOne', $container: rootA, name: 'C' });
      expect(builder.toOwnReference(member)).toEqual({ ref: member, $refText: 'C' });
   });

   it('toOwnReference returns undefined when the node has no own name', () => {
      const { builder, rootA } = buildBuilder();
      const inner = makeFakeAstNode<AnyNode>({ $type: 'Inner', $container: rootA });
      expect(builder.toOwnReference(inner)).toBeUndefined();
   });

   it('toOwnReference returns undefined for undefined target', () => {
      const { builder } = buildBuilder();
      expect(builder.toOwnReference(undefined)).toBeUndefined();
   });

   it('toDocumentReference returns undefined for undefined target', () => {
      const { builder } = buildBuilder();
      expect(builder.toDocumentReference(undefined)).toBeUndefined();
   });

   it('toProjectReference returns undefined for undefined target', () => {
      const { builder } = buildBuilder();
      expect(builder.toProjectReference(undefined)).toBeUndefined();
   });

   it('toDocumentReference returns the document-qualified-name reference', () => {
      const { builder, rootA } = buildBuilder();
      const member = makeFakeAstNode<AnyNode>({ $type: 'TypeOne', $container: rootA, name: 'C' });
      expect(builder.toDocumentReference(member)).toEqual({ ref: member, $refText: 'P.C' });
   });

   it('toProjectReference prepends the owning project referenceName', () => {
      const { builder, rootA } = buildBuilder();
      const member = makeFakeAstNode<AnyNode>({ $type: 'TypeOne', $container: rootA, name: 'C' });
      expect(builder.toProjectReference(member)).toEqual({ ref: member, $refText: 'projA.P.C' });
   });

   it('toReference: same project resolves to document-qualified form', () => {
      const { builder, rootA } = buildBuilder();
      const source = makeFakeAstNode<AnyNode>({ $type: 'TypeOne', $container: rootA, name: 'S' });
      const target = makeFakeAstNode<AnyNode>({ $type: 'TypeOne', $container: rootA, name: 'T' });
      expect(builder.toReference(target, source)).toEqual({ ref: target, $refText: 'P.T' });
   });

   it('toReference: different project, visible — resolves to project-qualified form', () => {
      const { builder, rootA, rootB } = buildBuilder({ projA: ['projA', 'projB'], projB: ['projB'] });
      const source = makeFakeAstNode<AnyNode>({ $type: 'TypeOne', $container: rootA, name: 'S' });
      const target = makeFakeAstNode<AnyNode>({ $type: 'TypeOne', $container: rootB, name: 'T' });
      expect(builder.toReference(target, source)).toEqual({ ref: target, $refText: 'projB.Q.T' });
   });

   it('toReference: different project, NOT visible — returns undefined', () => {
      const { builder, rootA, rootB } = buildBuilder({ projA: ['projA'], projB: ['projB'] });
      const source = makeFakeAstNode<AnyNode>({ $type: 'TypeOne', $container: rootA, name: 'S' });
      const target = makeFakeAstNode<AnyNode>({ $type: 'TypeOne', $container: rootB, name: 'T' });
      expect(builder.toReference(target, source)).toBeUndefined();
   });

   it('toReference: undefined source — no visibility check, falls back to project-qualified', () => {
      const { builder, rootA } = buildBuilder();
      const target = makeFakeAstNode<AnyNode>({ $type: 'TypeOne', $container: rootA, name: 'T' });
      expect(builder.toReference(target, undefined)).toEqual({ ref: target, $refText: 'projA.P.T' });
   });

   it('toReference: undefined target returns undefined', () => {
      const { builder, rootA } = buildBuilder();
      const source = makeFakeAstNode<AnyNode>({ $type: 'TypeOne', $container: rootA, name: 'S' });
      expect(builder.toReference(undefined, source)).toBeUndefined();
   });

   it('getReferenceName tolerates a source whose root has no $document (undefined source project)', () => {
      // A source node whose root carries no $document resolves to projectId undefined
      // (not throw); with no source project, getReferenceName falls back to the
      // project-qualified target form.
      const { builder, rootA } = buildBuilder();
      const target = makeFakeAstNode<AnyNode>({ $type: 'TypeOne', $container: rootA, name: 'T' });
      const orphanRoot = makeFakeAstNode<AnyNode>({ $type: 'Container', name: 'Z' }); // no $document planted
      const source = makeFakeAstNode<AnyNode>({ $type: 'TypeOne', $container: orphanRoot, name: 'S' });
      expect(builder.getReferenceName(target, source)).toBe('projA.P.T');
   });

   it('getReferenceName tolerates a source whose URI maps to no project (undefined source project)', () => {
      const { builder, rootA } = buildBuilder();
      const target = makeFakeAstNode<AnyNode>({ $type: 'TypeOne', $container: rootA, name: 'T' });
      const unmappedRoot = makeFakeAstNode<AnyNode>({ $type: 'Container', name: 'Z' });
      Object.assign(unmappedRoot, { $document: { uri: URI.parse('file:///workspace/unmapped/x.a') } });
      const source = makeFakeAstNode<AnyNode>({ $type: 'TypeOne', $container: unmappedRoot, name: 'S' });
      expect(builder.getReferenceName(target, source)).toBe('projA.P.T');
   });

   it('encodeRefText hook is honoured by the name constructors and getReferenceName', () => {
      class EncodingBuilder extends DefaultReferenceBuilder {
         protected override encodeRefText(name: string): string {
            return '<<' + name + '>>';
         }
      }
      const fixture = buildBuilder();
      const builder = new EncodingBuilder(fixture.services);
      const member = makeFakeAstNode<AnyNode>({ $type: 'TypeOne', $container: fixture.rootA, name: 'C' });
      expect(builder.toOwnReference(member)?.$refText).toBe('<<C>>');
      expect(builder.toDocumentReference(member)?.$refText).toBe('<<P.C>>');
      expect(builder.toProjectReference(member)?.$refText).toBe('<<projA.P.C>>');
      expect(builder.getReferenceName(member)).toBe('<<projA.P.C>>');
   });

   describe('cross-grammar name derivation', () => {
      /**
       * Two languages whose naming config genuinely differs: `.a` joins
       * segments with `.`, `.b` with `::`. Both are per-language settings a
       * grammar is free to choose, and the combination is what makes deriving
       * a target's name with the SOURCE language's provider observable.
       */
      function crossGrammarFixture(): {
         builder: DefaultReferenceBuilder;
         services: HydraniumLanguageServices;
         targetInOtherGrammar: AnyNode;
      } {
         const fixture = buildBuilder();
         const langBServices = { ...fixture.services, references: {} } as unknown as HydraniumLanguageServices;
         const langBNames = new DefaultNameProvider(langBServices, { nameSeparator: '::' });
         (langBServices.references as unknown as { NameProvider: DefaultNameProvider }).NameProvider = langBNames;

         const registry = makeStubServiceRegistry([
            { languageId: 'langA', fileExtensions: ['.a'], services: { references: fixture.services.references } },
            { languageId: 'langB', fileExtensions: ['.b'], services: { references: langBServices.references } }
         ]);
         (fixture.services.shared as unknown as { ServiceRegistry: unknown }).ServiceRegistry = registry;

         // A target living in a `.b` document — the other grammar.
         const langBRoot = makeFakeAstNode<AnyNode>({ $type: 'Container', name: 'Q' });
         Object.assign(langBRoot, { $document: { uri: URI.parse('file:///workspace/projA/other.b') } });
         const target = makeFakeAstNode<AnyNode>({ $type: 'TypeOne', $container: langBRoot, name: 'T' });
         return { builder: fixture.builder, services: fixture.services, targetInOtherGrammar: target };
      }

      it("derives a cross-grammar target's name with the TARGET language's provider", () => {
         // Derived with the source's `.` separator this would read `Q.T` — text
         // no `.b` document can ever resolve, written with no diagnostic.
         const { builder, targetInOtherGrammar } = crossGrammarFixture();
         expect(builder.toDocumentReference(targetInOtherGrammar)?.$refText).toBe('Q::T');
      });

      it('still derives a same-grammar target with its own provider', () => {
         const fixture = buildBuilder();
         const member = makeFakeAstNode<AnyNode>({ $type: 'TypeOne', $container: fixture.rootA, name: 'C' });
         expect(fixture.builder.toDocumentReference(member)?.$refText).toBe('P.C');
      });

      it('escapes with the SOURCE language, since escaping serves the writing grammar', () => {
         // Derivation follows the target, encoding stays with the source: a
         // source-side escape must still wrap a name derived by the other
         // grammar.
         class EncodingBuilder extends DefaultReferenceBuilder {
            protected override encodeRefText(name: string): string {
               return '<<' + name + '>>';
            }
         }
         const { services, targetInOtherGrammar } = crossGrammarFixture();
         const builder = new EncodingBuilder(services);
         // Own-name has no separator to differ on, so this isolates the
         // encoding half: the source's escape still applies to a foreign target.
         expect(builder.toOwnReference(targetInOtherGrammar)?.$refText).toBe('<<T>>');
         // And the derivation half still follows the target's separator.
         expect(builder.toDocumentReference(targetInOtherGrammar)?.$refText).toBe('<<Q::T>>');
      });
   });
});
