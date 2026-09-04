/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, expect, it } from 'vitest';
import { Disposable, type Project, UNQUALIFIED_PROJECT_REFERENCE } from '@hydranium/protocol';
import { type AstNode } from '@hydranium/langium';
import { URI } from '@hydranium/langium';
import type { HydraniumLanguageServices } from '../../../src/langium/language-module.js';
import { DefaultNameProvider } from '../../../src/langium/naming/name-provider.js';
import { makeFakeAstNode } from '../../../src/testing/index.js';

type AnyNode = AstNode & Record<string, unknown>;

/**
 * Minimal services stub carrying the two workspace services
 * {@link DefaultNameProvider} reaches for on the paths exercised here:
 * `ProjectManager.getProject(uri)` (via
 * {@link DefaultNameProvider.getProjectReferenceName}) and
 * `DocumentBuilder.onUpdate` (the qualified-name memos). Tests whose
 * fixture never traverses to a document root never reach the former, so it
 * may report no owning project. The `findNext*` fixtures need
 * `IndexManager` and `DocumentUriPolicy` on top and build their own stub.
 */
function makeServices(projectFor: (uri: URI) => Project | undefined = () => undefined): HydraniumLanguageServices {
   return {
      shared: {
         workspace: {
            ProjectManager: {
               getProject: (uri: URI | string) => projectFor(typeof uri === 'string' ? URI.parse(uri) : uri)
            },
            // DocumentCache (used by the qualified-name memos) subscribes
            // to DocumentBuilder.onUpdate; no-op stub keeps tests
            // independent of workspace lifecycle.
            DocumentBuilder: { onUpdate: () => Disposable.EMPTY }
         }
      }
   } as unknown as HydraniumLanguageServices;
}

describe('DefaultNameProvider', () => {
   describe('getOwnName', () => {
      it('reads the name property by default (Langium convention)', () => {
         const provider = new DefaultNameProvider(makeServices());
         const node = makeFakeAstNode<AnyNode>({ $type: 'TypeOne', name: 'Foo' });
         expect(provider.getOwnName(node)).toBe('Foo');
      });

      it('does NOT probe `id` by default — adopters with id-bearing grammars opt in via nameProperties', () => {
         const provider = new DefaultNameProvider(makeServices());
         const node = makeFakeAstNode<AnyNode>({ $type: 'TypeOne', id: 'E1' });
         expect(provider.getOwnName(node)).toBeUndefined();
      });

      it('reads the id property when nameProperties is configured for it', () => {
         const provider = new DefaultNameProvider(makeServices(), { nameProperties: ['id', 'name'] });
         const node = makeFakeAstNode<AnyNode>({ $type: 'TypeOne', id: 'E1', name: 'Element' });
         expect(provider.getOwnName(node)).toBe('E1');
      });

      it('returns undefined when no name-like property is present', () => {
         const provider = new DefaultNameProvider(makeServices());
         const node = makeFakeAstNode<AnyNode>({ $type: 'Anonymous' });
         expect(provider.getOwnName(node)).toBeUndefined();
      });

      it('returns undefined when node is undefined', () => {
         const provider = new DefaultNameProvider(makeServices());
         expect(provider.getOwnName(undefined)).toBeUndefined();
      });

      it('ignores non-string property values', () => {
         const provider = new DefaultNameProvider(makeServices());
         const node = makeFakeAstNode<AnyNode>({ $type: 'Quirky', name: 42 });
         expect(provider.getOwnName(node)).toBeUndefined();
      });

      it('falls through to the next configured property when the earlier one is non-string', () => {
         const provider = new DefaultNameProvider(makeServices(), { nameProperties: ['id', 'name'] });
         const node = makeFakeAstNode<AnyNode>({ $type: 'Quirky', id: 42, name: 'Real' });
         expect(provider.getOwnName(node)).toBe('Real');
      });

      it('respects a custom nameProperties order', () => {
         const provider = new DefaultNameProvider(makeServices(), { nameProperties: ['_id', 'id'] });
         const node = makeFakeAstNode<AnyNode>({ $type: 'Custom', _id: 'syn', id: 'plain' });
         expect(provider.getOwnName(node)).toBe('syn');
      });
   });

   describe('hasName', () => {
      it('returns true when a configured name property is present', () => {
         const provider = new DefaultNameProvider(makeServices());
         expect(provider.hasName(makeFakeAstNode<AnyNode>({ $type: 'TypeOne', name: 'Foo' }))).toBe(true);
      });

      it('returns false when no configured name property is present', () => {
         const provider = new DefaultNameProvider(makeServices());
         expect(provider.hasName(makeFakeAstNode<AnyNode>({ $type: 'Anonymous' }))).toBe(false);
      });

      it('respects nameProperties: an id-only adopter returns true for id-bearing nodes', () => {
         const provider = new DefaultNameProvider(makeServices(), { nameProperties: ['id'] });
         expect(provider.hasName(makeFakeAstNode<AnyNode>({ $type: 'TypeOne', id: 'E1' }))).toBe(true);
         expect(provider.hasName(makeFakeAstNode<AnyNode>({ $type: 'TypeOne', name: 'Element' }))).toBe(false);
      });

      it('returns false when node is undefined', () => {
         const provider = new DefaultNameProvider(makeServices());
         expect(provider.hasName(undefined)).toBe(false);
      });
   });

   describe('getNameProperty', () => {
      it('returns the property the name was read from, not the name', () => {
         const provider = new DefaultNameProvider(makeServices());
         expect(provider.getNameProperty(makeFakeAstNode<AnyNode>({ $type: 'TypeOne', name: 'Foo' }))).toBe('name');
      });

      it('respects nameProperties — an id-keyed grammar reports id', () => {
         const provider = new DefaultNameProvider(makeServices(), { nameProperties: ['id', 'name'] });
         expect(provider.getNameProperty(makeFakeAstNode<AnyNode>({ $type: 'TypeOne', id: 'E1' }))).toBe('id');
      });

      it('agrees with getOwnName about WHICH property won when several could match', () => {
         const provider = new DefaultNameProvider(makeServices(), { nameProperties: ['id', 'name'] });
         const node = makeFakeAstNode<AnyNode>({ $type: 'TypeOne', id: 'E1', name: 'Element' });
         const property = provider.getNameProperty(node);
         expect(property).toBe('id');
         // The pair must stay consistent: reading the reported property off the
         // node has to yield exactly what getOwnName returned.
         expect((node as Record<string, unknown>)[property!]).toBe(provider.getOwnName(node));
      });

      it('skips a configured property whose value is not a string', () => {
         const provider = new DefaultNameProvider(makeServices(), { nameProperties: ['id', 'name'] });
         const node = makeFakeAstNode<AnyNode>({ $type: 'TypeOne', id: 42, name: 'Element' });
         expect(provider.getNameProperty(node)).toBe('name');
      });

      it('returns undefined exactly when hasName is false', () => {
         const provider = new DefaultNameProvider(makeServices());
         const anonymous = makeFakeAstNode<AnyNode>({ $type: 'Anonymous' });
         expect(provider.hasName(anonymous)).toBe(false);
         expect(provider.getNameProperty(anonymous)).toBeUndefined();
         expect(provider.getNameProperty(undefined)).toBeUndefined();
      });
   });

   describe('qualify', () => {
      it('joins segments with the configured separator', () => {
         const provider = new DefaultNameProvider(makeServices());
         expect(provider.qualify('ns', 'BaseType', 'ref')).toBe('ns.BaseType.ref');
      });

      it('uses the adopter-configured separator', () => {
         const provider = new DefaultNameProvider(makeServices(), { nameSeparator: '::' });
         expect(provider.qualify('ns', 'TypeOne')).toBe('ns::TypeOne');
      });

      it('drops empty segments so an unqualified prefix produces no leading separator', () => {
         const provider = new DefaultNameProvider(makeServices());
         expect(provider.qualify('', 'BaseType', 'ref')).toBe('BaseType.ref');
         expect(provider.qualify('ns', '', 'ref')).toBe('ns.ref');
      });

      it('returns an empty string when every segment is empty', () => {
         const provider = new DefaultNameProvider(makeServices());
         expect(provider.qualify('', '')).toBe('');
         expect(provider.qualify()).toBe('');
      });
   });

   describe('getDocumentQualifiedName', () => {
      it('returns the bare name for a top-level node', () => {
         const provider = new DefaultNameProvider(makeServices());
         const root = makeFakeAstNode<AnyNode>({ $type: 'BaseType', name: 'P' });
         expect(provider.getDocumentQualifiedName(root)).toBe('P');
      });

      it('qualifies with every named ancestor', () => {
         const provider = new DefaultNameProvider(makeServices());
         const pkg = makeFakeAstNode<AnyNode>({ $type: 'BaseType', name: 'P' });
         const cls = makeFakeAstNode<AnyNode>({ $type: 'TypeOne', $container: pkg, name: 'C' });
         const attr = makeFakeAstNode<AnyNode>({ $type: 'TypeTwo', $container: cls, name: 'a' });
         expect(provider.getDocumentQualifiedName(attr)).toBe('P.C.a');
      });

      it('skips ancestors that lack a name (unnamed wrapper case)', () => {
         const provider = new DefaultNameProvider(makeServices());
         const root = makeFakeAstNode<AnyNode>({ $type: 'ModelRoot' });
         const cls = makeFakeAstNode<AnyNode>({ $type: 'TypeOne', $container: root, name: 'C' });
         expect(provider.getDocumentQualifiedName(cls)).toBe('C');
      });

      it('returns undefined when the leaf node has no own name', () => {
         const provider = new DefaultNameProvider(makeServices());
         const root = makeFakeAstNode<AnyNode>({ $type: 'BaseType', name: 'P' });
         const inner = makeFakeAstNode<AnyNode>({ $type: 'Inner', $container: root });
         expect(provider.getDocumentQualifiedName(inner)).toBeUndefined();
      });

      it('uses the configured nameSeparator to join segments', () => {
         const provider = new DefaultNameProvider(makeServices(), { nameSeparator: '::' });
         const pkg = makeFakeAstNode<AnyNode>({ $type: 'BaseType', name: 'P' });
         const cls = makeFakeAstNode<AnyNode>({ $type: 'TypeOne', $container: pkg, name: 'C' });
         expect(provider.getDocumentQualifiedName(cls)).toBe('P::C');
      });

      it('returns undefined for an undefined node (does not crash trying to find a root)', () => {
         // Kills the `if (!node)` guard mutated to `if (false)`: with the guard
         // removed AstUtils.findRootNode(undefined) throws instead of returning undefined.
         const provider = new DefaultNameProvider(makeServices());
         expect(provider.getDocumentQualifiedName(undefined)).toBeUndefined();
      });
   });

   /**
    * Caching-path coverage for the two qualified-name memos. The mutate-after-cache
    * trick distinguishes "served from cache" (returns the OLD value) from "recomputed"
    * (returns the NEW value): plant a `$document` so the cache path is taken, compute
    * once to populate the memo, mutate the node's own-name, then compute again. A correct
    * cache returns the stale value; mutants that disable the cache return the fresh value.
    */
   describe('qualified-name caching', () => {
      function withDocument(node: AnyNode, uri = 'file:///workspace/foo.a'): AnyNode {
         Object.assign(node, { $document: { uri: URI.parse(uri) } });
         return node;
      }

      it('getDocumentQualifiedName serves a cached result on the second call (mutating the node has no effect)', () => {
         // Kills, in getDocumentQualifiedName:
         //  - `if (!document)` -> `if (true)` (always recompute, never cache)
         //  - `if (cached !== undefined)` -> `if (false)` (never serve cache)
         //  - `if (computed !== undefined)` -> `if (false)` / `=== undefined` (never store defined results)
         const provider = new DefaultNameProvider(makeServices());
         const root = withDocument(makeFakeAstNode<AnyNode>({ $type: 'BaseType', name: 'P' }));
         const cls = makeFakeAstNode<AnyNode>({ $type: 'TypeOne', $container: root, name: 'C' });
         expect(provider.getDocumentQualifiedName(cls)).toBe('P.C');
         cls.name = 'RENAMED';
         // Served from cache -> stale 'P.C'. Any cache-disabling mutant recomputes -> 'P.RENAMED'.
         expect(provider.getDocumentQualifiedName(cls)).toBe('P.C');
      });

      it('getProjectQualifiedName serves a cached result on the second call (mutating the node has no effect)', () => {
         // Kills, in getProjectQualifiedName, `if (cached !== undefined)` -> `if (false)`
         // for the project memo, and `if (!document)` -> `if (false)` (the document path
         // must be taken for anything to be cached).
         const documentUri = URI.parse('file:///workspace/foo.a');
         const services = makeServices(uri =>
            uri.toString() === documentUri.toString() ? { id: 'projA', referenceName: 'projA' } : undefined
         );
         const provider = new DefaultNameProvider(services);
         const root = withDocument(makeFakeAstNode<AnyNode>({ $type: 'BaseType', name: 'P' }), documentUri.toString());
         const cls = makeFakeAstNode<AnyNode>({ $type: 'TypeOne', $container: root, name: 'C' });
         expect(provider.getProjectQualifiedName(cls)).toBe('projA.P.C');
         cls.name = 'RENAMED';
         expect(provider.getProjectQualifiedName(cls)).toBe('projA.P.C');
      });

      it('getProjectQualifiedName falls back to the document-qualified form when the root has no $document', () => {
         // Kills getProjectQualifiedName's `if (!document)` -> `if (false)`: with no
         // $document it must delegate to getDocumentQualifiedName; the mutant skips the fallback and
         // proceed into the cache/lookup path, which needs a document uri.
         const provider = new DefaultNameProvider(makeServices());
         const root = makeFakeAstNode<AnyNode>({ $type: 'BaseType', name: 'P' }); // no $document planted
         const cls = makeFakeAstNode<AnyNode>({ $type: 'TypeOne', $container: root, name: 'C' });
         expect(provider.getProjectQualifiedName(cls)).toBe('P.C');
      });
   });

   describe('getProjectQualifiedName', () => {
      /**
       * Build a fixture where the node lives in a fake document whose
       * URI maps to a project with the supplied referenceName. The
       * services stub returns the matching project from `getProject`,
       * letting {@link DefaultNameProvider.getProjectReferenceName}
       * resolve.
       */
      function buildFixture(referenceName: string, root: AnyNode): HydraniumLanguageServices {
         const documentUri = URI.parse('file:///workspace/foo.a');
         // `AstUtils.findRootNode(node).$document.uri` is the path used by
         // `getProjectQualifiedName` to look up the project. Plant
         // `$document` on the synthetic root.
         Object.assign(root, { $document: { uri: documentUri } });
         return makeServices(uri => (uri.toString() === documentUri.toString() ? { id: 'projA', referenceName } : undefined));
      }

      it('prepends a non-empty project referenceName to the document-qualified name', () => {
         const root = makeFakeAstNode<AnyNode>({ $type: 'BaseType', name: 'P' });
         const cls = makeFakeAstNode<AnyNode>({ $type: 'TypeOne', $container: root, name: 'C' });
         const provider = new DefaultNameProvider(buildFixture('myProj', root));
         expect(provider.getProjectQualifiedName(cls)).toBe('myProj.P.C');
      });

      it('collapses to the document-qualified name when referenceName is the unqualified sentinel', () => {
         const root = makeFakeAstNode<AnyNode>({ $type: 'BaseType', name: 'P' });
         const cls = makeFakeAstNode<AnyNode>({ $type: 'TypeOne', $container: root, name: 'C' });
         const provider = new DefaultNameProvider(buildFixture(UNQUALIFIED_PROJECT_REFERENCE, root));
         expect(provider.getProjectQualifiedName(cls)).toBe('P.C');
      });

      it('returns the document-qualified name when no project owns the document', () => {
         const root = makeFakeAstNode<AnyNode>({ $type: 'BaseType', name: 'P' });
         const cls = makeFakeAstNode<AnyNode>({ $type: 'TypeOne', $container: root, name: 'C' });
         // services returns undefined for every URI lookup.
         Object.assign(root, { $document: { uri: URI.parse('file:///workspace/foo.a') } });
         const provider = new DefaultNameProvider(makeServices());
         expect(provider.getProjectQualifiedName(cls)).toBe('P.C');
      });

      it('returns undefined when the leaf has no own name', () => {
         const root = makeFakeAstNode<AnyNode>({ $type: 'BaseType', name: 'P' });
         const inner = makeFakeAstNode<AnyNode>({ $type: 'Inner', $container: root });
         const provider = new DefaultNameProvider(buildFixture('myProj', root));
         expect(provider.getProjectQualifiedName(inner)).toBeUndefined();
      });

      it('returns undefined for an undefined node (does not crash trying to find a root)', () => {
         // Kills the `if (!node)` guard mutated to `if (false)` at the top of
         // getProjectQualifiedName: with the guard removed, AstUtils.findRootNode(undefined)
         // throws instead of returning undefined.
         const provider = new DefaultNameProvider(makeServices());
         expect(provider.getProjectQualifiedName(undefined)).toBeUndefined();
      });
   });

   describe('getName (Langium contract)', () => {
      it('defaults to getProjectQualifiedName so the linker resolves workspace-unique forms', () => {
         const root = makeFakeAstNode<AnyNode>({ $type: 'BaseType', name: 'P' });
         Object.assign(root, { $document: { uri: URI.parse('file:///workspace/foo.a') } });
         const cls = makeFakeAstNode<AnyNode>({ $type: 'TypeOne', $container: root, name: 'C' });
         // Project with non-empty referenceName so qualified form differs from document-qualified.
         const services = makeServices(uri => (uri.toString().endsWith('foo.a') ? { id: 'projA', referenceName: 'projA' } : undefined));
         const provider = new DefaultNameProvider(services);
         expect(provider.getName(cls)).toBe('projA.P.C');
      });

      it('collapses to getDocumentQualifiedName when the project is unqualified', () => {
         const root = makeFakeAstNode<AnyNode>({ $type: 'BaseType', name: 'P' });
         Object.assign(root, { $document: { uri: URI.parse('file:///workspace/foo.a') } });
         const cls = makeFakeAstNode<AnyNode>({ $type: 'TypeOne', $container: root, name: 'C' });
         const services = makeServices(uri =>
            uri.toString().endsWith('foo.a') ? { id: 'projA', referenceName: UNQUALIFIED_PROJECT_REFERENCE } : undefined
         );
         const provider = new DefaultNameProvider(services);
         expect(provider.getName(cls)).toBe('P.C');
      });

      it('subclasses can override to return a different qualification level', () => {
         class BareNameProvider extends DefaultNameProvider {
            override getName(node: AstNode): string | undefined {
               return this.getOwnName(node);
            }
         }
         const provider = new BareNameProvider(makeServices());
         const pkg = makeFakeAstNode<AnyNode>({ $type: 'BaseType', name: 'P' });
         const cls = makeFakeAstNode<AnyNode>({ $type: 'TypeOne', $container: pkg, name: 'C' });
         expect(provider.getName(cls)).toBe('C');
      });
   });

   describe('findNextName', () => {
      function element(name: string, parent: AnyNode): AnyNode {
         return makeFakeAstNode<AnyNode>({ $type: 'TypeOne', $container: parent, name });
      }

      it('returns the proposal unchanged if no collision exists', () => {
         const provider = new DefaultNameProvider(makeServices());
         const container = makeFakeAstNode<AnyNode>({ $type: 'BaseType' });
         expect(provider.findNextName('TypeOne', 'NodeA', container)).toBe('NodeA');
      });

      it('suffixes with 1, 2, 3... when collisions exist', () => {
         const provider = new DefaultNameProvider(makeServices());
         const container = makeFakeAstNode<AnyNode>({ $type: 'BaseType' });
         (container as AnyNode & { children?: AnyNode[] }).children = [
            element('NodeA', container),
            element('NodeA1', container),
            element('NodeA2', container)
         ];
         expect(provider.findNextName('TypeOne', 'NodeA', container)).toBe('NodeA3');
      });

      it('normalises proposals by replacing the id separator with underscores', () => {
         const provider = new DefaultNameProvider(makeServices());
         const container = makeFakeAstNode<AnyNode>({ $type: 'BaseType' });
         expect(provider.findNextName('TypeOne', 'Foo.Bar', container)).toBe('Foo_Bar');
      });

      it('only considers nodes of the requested type', () => {
         const provider = new DefaultNameProvider(makeServices());
         const container = makeFakeAstNode<AnyNode>({ $type: 'BaseType' });
         (container as AnyNode & { children?: AnyNode[] }).children = [
            makeFakeAstNode<AnyNode>({ $type: 'TypeTwo', $container: container, name: 'NodeA' }),
            makeFakeAstNode<AnyNode>({ $type: 'TypeOne', $container: container, name: 'NodeA' })
         ];
         expect(provider.findNextName('TypeOne', 'NodeA', container)).toBe('NodeA1');
      });

      it('excludes other-typed siblings from the known-name set so they do not shift the suffix', () => {
         // Kills the type filter `node => node.$type === type` mutated to `node => true`:
         // a TypeTwo node named 'NodeA1' must NOT count as a used TypeOne name. Correct:
         // known = ['NodeA'] -> 'NodeA1'. Mutant (all types count): known = ['NodeA','NodeA1']
         // -> 'NodeA2'.
         const provider = new DefaultNameProvider(makeServices());
         const container = makeFakeAstNode<AnyNode>({ $type: 'BaseType' });
         (container as AnyNode & { children?: AnyNode[] }).children = [
            makeFakeAstNode<AnyNode>({ $type: 'TypeOne', $container: container, name: 'NodeA' }),
            makeFakeAstNode<AnyNode>({ $type: 'TypeTwo', $container: container, name: 'NodeA1' })
         ];
         expect(provider.findNextName('TypeOne', 'NodeA', container)).toBe('NodeA1');
      });

      it('uses the configured nameSeparator to sanitise proposals', () => {
         const provider = new DefaultNameProvider(makeServices(), { nameSeparator: '::' });
         const container = makeFakeAstNode<AnyNode>({ $type: 'BaseType' });
         // Proposal contains '::' → must be replaced with underscores. Proposal also contains
         // '.' → that's NOT the separator any more, so it stays.
         expect(provider.findNextName('TypeOne', 'Foo::Bar.baz', container)).toBe('Foo_Bar.baz');
      });
   });

   describe('findNextDocumentQualifiedName', () => {
      function makeFixture(elementsByName: Record<string, string /* projectId */>): DefaultNameProvider {
         const elements = Object.entries(elementsByName).map(([name, projectId]) => ({
            name,
            type: 'TypeOne',
            documentUri: URI.parse(`file:///workspace/${projectId}/${name}.a`),
            path: '',
            node: makeFakeAstNode<AstNode>({ $type: 'TypeOne', name })
         }));
         // Chainable stream stub: the provider applies `filter` more than once
         // (project scope, then the optional self-exclusion), so each `filter`
         // must return something filterable again.
         type Element = (typeof elements)[number];
         const stream = (items: Element[]): unknown => ({
            filter: (predicate: (element: Element) => boolean) => stream(items.filter(predicate)),
            map: (mapFn: (element: Element) => string) => ({ toArray: () => items.map(mapFn) })
         });
         const services = {
            shared: {
               workspace: {
                  IndexManager: {
                     allElements: (_type: string) => stream(elements)
                  },
                  ProjectManager: {
                     getProject: (uri: URI | string) => {
                        const path = typeof uri === 'string' ? uri : uri.path;
                        const match = path.match(/\/workspace\/([^/]+)\//);
                        return match ? { id: match[1], referenceName: match[1] } : undefined;
                     }
                  },
                  DocumentUriPolicy: { canonicalUri: (uri: string) => uri },
                  DocumentBuilder: { onUpdate: () => Disposable.EMPTY }
               }
            }
         } as unknown as HydraniumLanguageServices;
         return new DefaultNameProvider(services);
      }

      it('returns the proposal unchanged when no collision exists in the project', () => {
         const provider = makeFixture({ Other: 'projA' });
         expect(provider.findNextDocumentQualifiedName('TypeOne', 'Element', 'projA')).toBe('Element');
      });

      it('suffixes with 1, 2, ... when names collide within the same project', () => {
         const provider = makeFixture({ Element: 'projA', Element1: 'projA', Element2: 'projA' });
         expect(provider.findNextDocumentQualifiedName('TypeOne', 'Element', 'projA')).toBe('Element3');
      });

      it('ignores elements owned by a different project', () => {
         const provider = makeFixture({ Element: 'projB' });
         // 'Element' is in projB but we ask for projA → no collision.
         expect(provider.findNextDocumentQualifiedName('TypeOne', 'Element', 'projA')).toBe('Element');
      });

      it('normalises proposals by replacing the id separator with underscores', () => {
         const provider = makeFixture({});
         expect(provider.findNextDocumentQualifiedName('TypeOne', 'Foo.Bar', 'projA')).toBe('Foo_Bar');
      });

      it('does not treat a document as colliding with its own indexed entry when excluded', () => {
         // The rename / provisional-id-confirm case: the caller proposes a name FOR
         // Element.a, which the index already lists. Without the exclusion the
         // document collides with itself and gets a spurious 'Element1'.
         const provider = makeFixture({ Element: 'projA' });
         expect(
            provider.findNextDocumentQualifiedName('TypeOne', 'Element', 'projA', {
               excludeDocumentUri: URI.parse('file:///workspace/projA/Element.a')
            })
         ).toBe('Element');
      });

      it('still collides with a DIFFERENT document holding the name while excluding its own', () => {
         const provider = makeFixture({ Element: 'projA', Other: 'projA' });
         expect(
            provider.findNextDocumentQualifiedName('TypeOne', 'Element', 'projA', {
               excludeDocumentUri: URI.parse('file:///workspace/projA/Other.a')
            })
         ).toBe('Element1');
      });

      it('accepts the excluded document URI as a plain string', () => {
         const provider = makeFixture({ Element: 'projA' });
         expect(
            provider.findNextDocumentQualifiedName('TypeOne', 'Element', 'projA', {
               excludeDocumentUri: 'file:///workspace/projA/Element.a'
            })
         ).toBe('Element');
      });

      it('excludes the document at workspace scope too', () => {
         const provider = makeFixture({ Element: 'projA' });
         expect(
            provider.findNextProjectQualifiedName('TypeOne', 'Element', {
               excludeDocumentUri: URI.parse('file:///workspace/projA/Element.a')
            })
         ).toBe('Element');
         // ...and without the exclusion the same call still sees the collision.
         expect(provider.findNextProjectQualifiedName('TypeOne', 'Element')).toBe('Element1');
      });

      it('tolerates index elements whose document has no owning project (optional-chaining guard)', () => {
         // Kills the `getProject(...)?.id` optional chaining mutated to `getProject(...).id`:
         // an element whose URI resolves to NO project (getProject -> undefined) must be
         // skipped via the `?.` guard. The mutant dereferences `.id` on undefined and throws.
         const orphan = {
            name: 'Element',
            type: 'TypeOne',
            documentUri: URI.parse('file:///elsewhere/orphan.a'),
            path: '',
            node: makeFakeAstNode<AstNode>({ $type: 'TypeOne', name: 'Element' })
         };
         const services = {
            shared: {
               workspace: {
                  IndexManager: {
                     allElements: (_type: string) => ({
                        filter: (predicate: (d: { documentUri: URI }) => boolean) => ({
                           filter: (second: (d: { documentUri: URI }) => boolean) => ({
                              map: (mapFn: (d: { name: string }) => string) => ({
                                 toArray: () => [orphan].filter(predicate).filter(second).map(mapFn)
                              })
                           }),
                           map: (mapFn: (d: { name: string }) => string) => ({
                              toArray: () => [orphan].filter(predicate).map(mapFn)
                           })
                        })
                     })
                  },
                  // No project owns the orphan's URI -> getProject returns undefined.
                  ProjectManager: { getProject: () => undefined },
                  DocumentUriPolicy: { canonicalUri: (uri: string) => uri },
                  DocumentBuilder: { onUpdate: () => Disposable.EMPTY }
               }
            }
         } as unknown as HydraniumLanguageServices;
         const provider = new DefaultNameProvider(services);
         // The orphan is filtered out (its project !== 'projA'), so no collision -> proposal unchanged.
         expect(provider.findNextDocumentQualifiedName('TypeOne', 'Element', 'projA')).toBe('Element');
      });
   });

   describe('findNextProjectQualifiedName', () => {
      function makeFixture(names: readonly string[]): DefaultNameProvider {
         const elements = names.map(name => ({
            name,
            type: 'TypeOne',
            documentUri: URI.parse('file:///workspace/foo.a'),
            path: '',
            node: makeFakeAstNode<AstNode>({ $type: 'TypeOne', name })
         }));
         const services = {
            shared: {
               workspace: {
                  IndexManager: {
                     allElements: (_type: string) => ({
                        filter: (predicate: (d: { documentUri: URI }) => boolean) => ({
                           map: (mapFn: (d: { name: string }) => string) => ({
                              toArray: () => elements.filter(predicate).map(mapFn)
                           })
                        }),
                        map: (mapFn: (d: { name: string }) => string) => ({
                           toArray: () => elements.map(mapFn)
                        })
                     })
                  },
                  ProjectManager: { getProject: () => undefined },
                  DocumentUriPolicy: { canonicalUri: (uri: string) => uri },
                  DocumentBuilder: { onUpdate: () => Disposable.EMPTY }
               }
            }
         } as unknown as HydraniumLanguageServices;
         return new DefaultNameProvider(services);
      }

      it('returns the proposal unchanged when no collision exists', () => {
         const provider = makeFixture([]);
         expect(provider.findNextProjectQualifiedName('TypeOne', 'Element')).toBe('Element');
      });

      it('suffixes with 1, 2, ... when names collide anywhere in the workspace', () => {
         const provider = makeFixture(['Element', 'Element1', 'Element2']);
         expect(provider.findNextProjectQualifiedName('TypeOne', 'Element')).toBe('Element3');
      });

      it('normalises proposals by replacing the id separator with underscores', () => {
         const provider = makeFixture([]);
         expect(provider.findNextProjectQualifiedName('TypeOne', 'Foo.Bar')).toBe('Foo_Bar');
      });
   });

   describe('nameSeparator parameterisation', () => {
      it('defaults to `.` when no options are passed', () => {
         const provider = new DefaultNameProvider(makeServices());
         expect(provider.nameSeparator).toBe('.');
      });

      it('uses the configured separator in getDocumentQualifiedName', () => {
         const provider = new DefaultNameProvider(makeServices(), { nameSeparator: '::' });
         expect(provider.nameSeparator).toBe('::');
         const pkg = makeFakeAstNode<AnyNode>({ $type: 'BaseType', name: 'P' });
         const cls = makeFakeAstNode<AnyNode>({ $type: 'TypeOne', $container: pkg, name: 'C' });
         const attr = makeFakeAstNode<AnyNode>({ $type: 'TypeTwo', $container: cls, name: 'a' });
         expect(provider.getDocumentQualifiedName(attr)).toBe('P::C::a');
      });

      it('explicit `.` is equivalent to default', () => {
         const provider = new DefaultNameProvider(makeServices(), { nameSeparator: '.' });
         expect(provider.nameSeparator).toBe('.');
         const pkg = makeFakeAstNode<AnyNode>({ $type: 'BaseType', name: 'P' });
         const cls = makeFakeAstNode<AnyNode>({ $type: 'TypeOne', $container: pkg, name: 'C' });
         expect(provider.getDocumentQualifiedName(cls)).toBe('P.C');
      });
   });
});
