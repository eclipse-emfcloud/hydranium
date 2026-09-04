/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, expect, it } from 'vitest';
import { Disposable } from '@hydranium/protocol';
import { type AstNode, type AstNodeDescription, type AstNodeLocator, type AstReflection, type LangiumDocument } from '@hydranium/langium';
import { URI } from '@hydranium/langium';
import type { ServerSharedServicesMinimal } from '../../../src/langium/shared-services.js';
import { HydraniumIndexManager } from '../../../src/langium/workspace/index-manager.js';
import { makeFakeAstNode, makeNoopSharedServices, makeStubServiceRegistry } from '../../../src/testing/index.js';

const URI_A = URI.parse('memory:///doc-a.a');
const URI_B = URI.parse('memory:///doc-b.a');
/** A document of the SECOND language, for the cross-grammar name-clash case. */
const URI_LANG_B = URI.parse('memory:///doc-a.b');

function desc(name: string, type: string, uri: URI, path = '/'): AstNodeDescription {
   return { name, type, documentUri: uri, path };
}

function makeAstReflection(isSubtypeImpl: (descType: string, refType: string) => boolean = () => true): AstReflection {
   return {
      isSubtype: isSubtypeImpl,
      getReferenceType: () => 'Fake'
   } as unknown as AstReflection;
}

/**
 * Stub services that satisfy `DefaultIndexManager`'s constructor without
 * pulling in the full DI graph. Tests interact with the index manager's
 * `updateContent` lifecycle directly.
 */
function makeServices(
   astReflection: AstReflection,
   locator?: AstNodeLocator,
   projectMembers: Map<string, URI[]> = new Map()
): ServerSharedServicesMinimal {
   const projectManager = {
      getProjectUris: (id: string) => projectMembers.get(id) ?? [],
      getVisibleProjects: (id: string) => (projectMembers.has(id) ? [id] : []),
      getProject: () => undefined,
      getProjectById: () => undefined,
      getProjects: () => [],
      isProjectDescriptor: () => false,
      onProjectsChanged: () => Disposable.EMPTY,
      ready: Promise.resolve(),
      discoverProjects: async () => undefined
   };
   return makeNoopSharedServices({
      ServiceRegistry: {
         all: [],
         getServices: () => ({
            workspace: { AstNodeLocator: locator ?? { getAstNode: () => undefined } }
         })
      },
      workspace: {
         LangiumDocuments: {
            getDocument: () => undefined,
            all: { filter: () => ({ map: () => ({ toArray: () => [] }) }) }
         },
         ProjectManager: projectManager
      },
      AstReflection: astReflection
   });
}

/**
 * Test subclass that exposes the symbolIndex so we can seed it without
 * going through the full Langium build pipeline.
 */
class TestIndexManager extends HydraniumIndexManager {
   seedSymbols(uri: URI, descriptions: AstNodeDescription[]): void {
      this.symbolIndex.set(uri.toString(), descriptions);
   }

   triggerAdd(uri: URI): void {
      this.addToElementsByName(uri.toString());
   }

   triggerRemove(uri: URI): void {
      this.removeFromElementsByName(uri.toString());
   }

   get index(): Map<string, AstNodeDescription[]> {
      return this.elementsByName;
   }
}

describe('HydraniumIndexManager', () => {
   describe('elementsByName maintenance', () => {
      it('addToElementsByName collects names from symbolIndex', () => {
         const manager = new TestIndexManager(makeServices(makeAstReflection()));
         manager.seedSymbols(URI_A, [desc('Foo', 'TypeOne', URI_A), desc('Bar', 'TypeOne', URI_A)]);
         manager.triggerAdd(URI_A);
         expect(manager.index.get('Foo')).toHaveLength(1);
         expect(manager.index.get('Bar')).toHaveLength(1);
      });

      it('removeFromElementsByName drops entries for the URI but keeps others', () => {
         const manager = new TestIndexManager(makeServices(makeAstReflection()));
         manager.seedSymbols(URI_A, [desc('Foo', 'TypeOne', URI_A)]);
         manager.seedSymbols(URI_B, [desc('Foo', 'TypeOne', URI_B)]);
         manager.triggerAdd(URI_A);
         manager.triggerAdd(URI_B);
         expect(manager.index.get('Foo')).toHaveLength(2);
         manager.triggerRemove(URI_A);
         const remaining = manager.index.get('Foo');
         expect(remaining).toHaveLength(1);
         expect(remaining![0].documentUri.toString()).toBe(URI_B.toString());
      });

      it('removeFromElementsByName clears the bucket when no entries remain', () => {
         const manager = new TestIndexManager(makeServices(makeAstReflection()));
         manager.seedSymbols(URI_A, [desc('Foo', 'TypeOne', URI_A)]);
         manager.triggerAdd(URI_A);
         manager.triggerRemove(URI_A);
         expect(manager.index.has('Foo')).toBe(false);
      });

      it('removeFromElementsByName is a no-op for a URI with no symbols (guards the missing-descriptions case)', () => {
         // symbolIndex has no entry for URI_A -> oldDescs is undefined, so the
         // `if (!oldDescs) return` guard must short-circuit. Without it the
         // loop iterates `undefined` and throws.
         const manager = new TestIndexManager(makeServices(makeAstReflection()));
         expect(() => manager.triggerRemove(URI_A)).not.toThrow();
      });

      it('addToElementsByName is a no-op for a URI with no symbols (guards the missing-descriptions case)', () => {
         // symbolIndex has no entry -> newDescs undefined, so
         // `if (!newDescs) return` must short-circuit rather than iterate it.
         const manager = new TestIndexManager(makeServices(makeAstReflection()));
         expect(() => manager.triggerAdd(URI_A)).not.toThrow();
         expect(manager.index.size).toBe(0);
      });

      it('removeFromElementsByName skips names absent from elementsByName (guards the missing-bucket case)', () => {
         // Seed symbolIndex but never call triggerAdd, so elementsByName has no
         // bucket for 'Foo'. removeFromElementsByName must `continue` past the
         // missing bucket rather than call `.filter` on undefined.
         const manager = new TestIndexManager(makeServices(makeAstReflection()));
         manager.seedSymbols(URI_A, [desc('Foo', 'TypeOne', URI_A)]);
         expect(() => manager.triggerRemove(URI_A)).not.toThrow();
      });
   });

   describe('getElementByName', () => {
      it('returns the first match when the name is not unique', () => {
         // Deliberate: one langA element is routinely indexed several times
         // (a symbol per visibility tier, a wrapper root beside its semantic
         // root), so abstaining here would break scope resolution. Callers that
         // must distinguish use `getElementsByName`.
         const manager = new TestIndexManager(makeServices(makeAstReflection()));
         manager.seedSymbols(URI_A, [desc('Foo', 'TypeOne', URI_A, '/foo'), desc('Foo', 'TypeTwo', URI_A, '/bar')]);
         manager.triggerAdd(URI_A);
         expect(manager.getElementByName('Foo')?.path).toBe('/foo');
      });

      it('answers when the name matches exactly one element', () => {
         const manager = new TestIndexManager(makeServices(makeAstReflection()));
         manager.seedSymbols(URI_A, [desc('Foo', 'TypeOne', URI_A)]);
         manager.triggerAdd(URI_A);
         expect(manager.getElementByName('Foo')?.type).toBe('TypeOne');
      });

      it('filters by type via AstReflection.isSubtype', () => {
         const reflection = makeAstReflection((descType, refType) => descType === refType);
         const manager = new TestIndexManager(makeServices(reflection));
         manager.seedSymbols(URI_A, [desc('Foo', 'TypeOne', URI_A, '/foo'), desc('Foo', 'TypeTwo', URI_A, '/bar')]);
         manager.triggerAdd(URI_A);
         expect(manager.getElementByName('Foo', 'TypeTwo')?.type).toBe('TypeTwo');
      });

      it('returns undefined when no candidate exists', () => {
         const manager = new TestIndexManager(makeServices(makeAstReflection()));
         expect(manager.getElementByName('Missing')).toBeUndefined();
      });

      it('does NOT consult isSubtype when no type is given', () => {
         // isSubtype is forced to always-false. With no type filter the lookup
         // must not route through it at all — losing the `type ?` guard would
         // filter every candidate away and answer undefined.
         const reflection = makeAstReflection(() => false);
         const manager = new TestIndexManager(makeServices(reflection));
         manager.seedSymbols(URI_A, [desc('Foo', 'TypeOne', URI_A)]);
         manager.triggerAdd(URI_A);
         expect(manager.getElementByName('Foo')?.type).toBe('TypeOne');
      });
   });

   describe('getElementsByName', () => {
      it('returns every match, so a caller can tell none from several', () => {
         const manager = new TestIndexManager(makeServices(makeAstReflection()));
         manager.seedSymbols(URI_A, [desc('Foo', 'TypeOne', URI_A), desc('Foo', 'TypeTwo', URI_A)]);
         manager.triggerAdd(URI_A);
         expect(manager.getElementsByName('Foo').map(match => match.type)).toEqual(['TypeOne', 'TypeTwo']);
         expect(manager.getElementsByName('Missing')).toEqual([]);
      });

      it('narrows by owning language, which is what disambiguates a cross-grammar name clash', () => {
         // Two languages deriving names from a shared imported base is exactly
         // how the same name lands twice in one workspace-global index.
         const services = makeServices(makeAstReflection());
         (services as unknown as Record<string, unknown>).ServiceRegistry = makeStubServiceRegistry([
            { languageId: 'langA', fileExtensions: ['.a'] },
            { languageId: 'langB', fileExtensions: ['.b'] }
         ]);
         const manager = new TestIndexManager(services);
         manager.seedSymbols(URI_A, [desc('Foo', 'TypeOne', URI_A), desc('Foo', 'TypeOne', URI_LANG_B)]);
         manager.triggerAdd(URI_A);

         expect(manager.getElementsByName('Foo')).toHaveLength(2);
         // Same name, same type, different languages — only the language tells them apart.
         expect(manager.getElementByName('Foo', undefined, 'langA')?.documentUri).toBe(URI_A);
         expect(manager.getElementByName('Foo', undefined, 'langB')?.documentUri).toBe(URI_LANG_B);
      });
   });

   describe('resolveElement', () => {
      it('returns undefined for a description whose document is not loaded', () => {
         const manager = new TestIndexManager(makeServices(makeAstReflection()));
         expect(manager.resolveElement(desc('Foo', 'TypeOne', URI_A))).toBeUndefined();
      });

      it('uses AstNodeLocator on the document parse result when the document is loaded', () => {
         const stubNode = makeFakeAstNode<AstNode>({ $type: 'TypeOne' });
         const stubDocument = { parseResult: { value: makeFakeAstNode<AstNode>({ $type: 'Root' }) } } as LangiumDocument;
         const locator: AstNodeLocator = { getAstNode: () => stubNode } as unknown as AstNodeLocator;
         const services = makeServices(makeAstReflection(), locator);
         (services.workspace.LangiumDocuments.getDocument as unknown as () => LangiumDocument | undefined) = () => stubDocument;
         const manager = new TestIndexManager(services);
         expect(manager.resolveElement(desc('Foo', 'TypeOne', URI_A))).toBe(stubNode);
      });

      it('returns undefined when description is undefined', () => {
         const manager = new TestIndexManager(makeServices(makeAstReflection()));
         expect(manager.resolveElement(undefined)).toBeUndefined();
      });
   });

   describe('resolveSemanticElement', () => {
      it('returns the parse-result root by default', () => {
         const root = makeFakeAstNode<AstNode>({ $type: 'Root' });
         const stubDocument = { parseResult: { value: root } } as LangiumDocument;
         const services = makeServices(makeAstReflection());
         (services.workspace.LangiumDocuments.getDocument as unknown as () => LangiumDocument | undefined) = () => stubDocument;
         const manager = new TestIndexManager(services);
         expect(manager.resolveSemanticElement(URI_A)).toBe(root);
      });

      it('returns undefined when the document is not loaded', () => {
         const manager = new TestIndexManager(makeServices(makeAstReflection()));
         expect(manager.resolveSemanticElement(URI_A)).toBeUndefined();
      });

      it('honours subclass findSemanticRoot override', () => {
         const inner = makeFakeAstNode<AstNode>({ $type: 'Inner' });
         const root = makeFakeAstNode<AstNode & { inner: AstNode }>({ $type: 'Root', inner });
         const stubDocument = { parseResult: { value: root } } as unknown as LangiumDocument;
         const services = makeServices(makeAstReflection());
         (services.workspace.LangiumDocuments.getDocument as unknown as () => LangiumDocument | undefined) = () => stubDocument;
         class SubclassManager extends HydraniumIndexManager {
            protected override findSemanticRoot(document: LangiumDocument): AstNode {
               return (document.parseResult.value as unknown as { inner: AstNode }).inner;
            }
         }
         const manager = new SubclassManager(services);
         expect(manager.resolveSemanticElement(URI_A)).toBe(inner);
      });
   });

   describe('getElementsInProject', () => {
      it('returns descriptions whose documentUri is a project member', () => {
         const members = new Map<string, URI[]>([['projA', [URI_A]]]);
         const manager = new TestIndexManager(makeServices(makeAstReflection(), undefined, members));
         manager.seedSymbols(URI_A, [desc('Foo', 'TypeOne', URI_A), desc('Bar', 'TypeOne', URI_A)]);
         manager.seedSymbols(URI_B, [desc('Baz', 'TypeOne', URI_B)]);
         manager.triggerAdd(URI_A);
         manager.triggerAdd(URI_B);

         const result = manager.getElementsInProject('projA');
         expect(result.map(d => d.name).sort()).toEqual(['Bar', 'Foo']);
      });

      it('filters by type via AstReflection.isSubtype', () => {
         const reflection = makeAstReflection((descType, refType) => descType === refType);
         const members = new Map<string, URI[]>([['projA', [URI_A]]]);
         const manager = new TestIndexManager(makeServices(reflection, undefined, members));
         manager.seedSymbols(URI_A, [desc('Foo', 'TypeOne', URI_A), desc('Foo', 'TypeTwo', URI_A)]);
         manager.triggerAdd(URI_A);

         const interfaces = manager.getElementsInProject('projA', 'TypeTwo');
         expect(interfaces).toHaveLength(1);
         expect(interfaces[0].type).toBe('TypeTwo');
      });

      it('returns [] for unknown project id', () => {
         const manager = new TestIndexManager(makeServices(makeAstReflection()));
         manager.seedSymbols(URI_A, [desc('Foo', 'TypeOne', URI_A)]);
         manager.triggerAdd(URI_A);
         expect(manager.getElementsInProject('does-not-exist')).toEqual([]);
      });

      it('excludes descriptions from other projects', () => {
         const members = new Map<string, URI[]>([
            ['projA', [URI_A]],
            ['projB', [URI_B]]
         ]);
         const manager = new TestIndexManager(makeServices(makeAstReflection(), undefined, members));
         manager.seedSymbols(URI_A, [desc('Foo', 'TypeOne', URI_A)]);
         manager.seedSymbols(URI_B, [desc('Foo', 'TypeOne', URI_B)]);
         manager.triggerAdd(URI_A);
         manager.triggerAdd(URI_B);

         const inA = manager.getElementsInProject('projA');
         expect(inA).toHaveLength(1);
         expect(inA[0].documentUri.toString()).toBe(URI_A.toString());

         const inB = manager.getElementsInProject('projB');
         expect(inB).toHaveLength(1);
         expect(inB[0].documentUri.toString()).toBe(URI_B.toString());
      });
   });
});
