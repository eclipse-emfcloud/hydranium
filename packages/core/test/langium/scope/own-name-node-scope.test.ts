/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * `HydraniumScopeProvider.createScopeForNodes` re-keys Langium's helper from
 * `getName` (project-qualified in this framework) to `getOwnName`. Built
 * against the REAL `DefaultNameProvider` and
 * `HydraniumAstNodeDescriptionProvider`, because the whole point is which of
 * the three qualification levels the key comes from — a stubbed name provider
 * would make the test pass whatever the implementation did.
 */

import {
   type AstNode,
   DefaultAstNodeLocator,
   DocumentState,
   type LangiumDocument,
   type Scope,
   type ScopeOptions,
   URI
} from '@hydranium/langium';
import { describe, expect, it } from 'vitest';
import { type HydraniumLanguageServices } from '../../../src/langium/language-module.js';
import { DefaultNameProvider } from '../../../src/langium/naming/name-provider.js';
import { HydraniumAstNodeDescriptionProvider } from '../../../src/langium/scope/ast-node-description-provider.js';
import { HydraniumScopeProvider } from '../../../src/langium/scope/hydranium-scope-provider.js';
import { makeFakeAstNode, makeFakeDescription, makeFakeDocument, makeTestServices } from '../../../src/testing/index.js';

const DOCUMENT_URI = 'file:///workspace/projA/a.x';

/**
 * A name held by the seeded global index and by NOTHING in the member fixture.
 * The closed-scope assertion needs a name that a fall-through WOULD resolve —
 * a name absent everywhere is answered `undefined` by an open scope too.
 */
const INDEX_ONLY_NAME = 'indexonly';

interface FakeMember extends AstNode {
   readonly $type: 'TypeOne';
   readonly name: string;
}

interface FakeContainer extends AstNode {
   readonly $type: 'BaseType';
   readonly name: string;
   readonly members: FakeMember[];
}

/** A `Base` container holding two named members, wired as a real document so `getDocument` works. */
function makeContainer(): { container: FakeContainer; document: LangiumDocument<FakeContainer> } {
   const container = makeFakeAstNode<FakeContainer>({ $type: 'BaseType', name: 'Base', members: [] });
   const members = ['one', 'two'].map(name =>
      makeFakeAstNode<FakeMember>({ $type: 'TypeOne', name, $container: container, $containerProperty: 'members' })
   );
   (container as { members: FakeMember[] }).members = members;
   const document = makeFakeDocument<FakeContainer>(DOCUMENT_URI, container, { state: DocumentState.Validated });
   (container as { $document?: unknown }).$document = document;
   return { container, document };
}

/** Exposes the protected helper, plus the name the base helper would have keyed by. */
class ProbeScopeProvider extends HydraniumScopeProvider {
   scopeFor(nodes: Iterable<AstNode>, outerScope?: Scope): Scope {
      return this.createScopeForNodes(nodes, outerScope);
   }

   qualifiedNameOf(node: AstNode): string | undefined {
      return this.nameProvider.getName(node);
   }
}

/** Counts the scopes {@link HydraniumScopeProvider.createNodeScope} builds, as an adopter's override would run. */
class CountingScopeProvider extends ProbeScopeProvider {
   built = 0;

   protected override createNodeScope(elements: Iterable<AstNode>, outerScope?: Scope, options?: ScopeOptions): Scope {
      this.built++;
      return super.createNodeScope(elements, outerScope, options);
   }
}

/**
 * Provider over the real naming + description services, in a project that
 * qualifies its names, with a global index holding {@link INDEX_ONLY_NAME}.
 * The index is what makes "closed" observable: `DefaultScopeProvider` reads
 * that slot, so a scope that fabricated an outer would answer from it.
 */
function probe<TProvider extends ProbeScopeProvider>(Provider: new (services: HydraniumLanguageServices) => TProvider): TProvider {
   const bundle = makeTestServices<FakeContainer>({
      seedProjects: [{ id: 'projA', referenceName: 'projA' }],
      seedIndex: [makeFakeDescription(INDEX_ONLY_NAME, { type: 'TypeOne', documentUri: URI.parse('file:///workspace/projA/b.x') })]
   });
   bundle.projectManager.ownUri(DOCUMENT_URI, 'projA');
   const language = {
      references: { ScopeExtensionService: {} },
      // The real locator: the description provider computes an AST path per
      // description, so a stub would only prove the stub.
      workspace: { AstNodeLocator: new DefaultAstNodeLocator() },
      shared: bundle.services
   } as unknown as HydraniumLanguageServices;
   const writable = language as unknown as {
      references: { NameProvider: unknown };
      workspace: { AstNodeDescriptionProvider: unknown };
   };
   writable.references.NameProvider = new DefaultNameProvider(language);
   writable.workspace.AstNodeDescriptionProvider = new HydraniumAstNodeDescriptionProvider(language);
   return new Provider(language);
}

describe('HydraniumScopeProvider.createScopeForNodes own-name keying', () => {
   it('keys entries by the bare own-name, which is the text a member reference carries', () => {
      const { container } = makeContainer();
      const scope = probe(ProbeScopeProvider).scopeFor(container.members);

      expect(
         scope
            .getAllElements()
            .map(description => description.name)
            .toArray()
      ).toEqual(['one', 'two']);
      expect(scope.getElement('one')?.name).toBe('one');
   });

   it('would key them project-qualified under the getName the base helper reads', () => {
      const { container } = makeContainer();
      const provider = probe(ProbeScopeProvider);

      // The contrast that makes the test above non-vacuous: `getName` — what
      // the base helper reads — returns a qualified form no reference text
      // after a `.` ever matches.
      expect(provider.qualifiedNameOf(container.members[0])).toBe('projA.Base.one');
      expect(provider.scopeFor(container.members).getElement('projA.Base.one')).toBeUndefined();
   });

   it('is closed when no outer scope is passed, so a name only the global index holds fails to resolve', () => {
      // A reference to a member the container does not have must fail rather
      // than reach the workspace: resolving it would bind the reference to a
      // same-named declaration on an unrelated type.
      const { container } = makeContainer();

      expect(probe(ProbeScopeProvider).scopeFor(container.members).getElement(INDEX_ONLY_NAME)).toBeUndefined();
   });

   it('falls through to an outer scope when one is passed', () => {
      const { container } = makeContainer();
      const provider = probe(ProbeScopeProvider);
      const outer = provider.scopeFor(container.members);

      expect(provider.scopeFor([], outer).getElement('one')?.name).toBe('one');
   });

   it('skips nodes the name provider cannot read a name from', () => {
      const { container, document } = makeContainer();
      const unnamed = makeFakeAstNode({ $type: 'TypeOne', $container: container, $document: document });

      expect(
         probe(ProbeScopeProvider)
            .scopeFor([...container.members, unnamed])
            .getAllElements()
            .count()
      ).toBe(2);
   });

   it('stamps the local tier, since constructed member descriptions are never index entries', () => {
      const { container } = makeContainer();
      const description = probe(ProbeScopeProvider).scopeFor(container.members).getElement('one');

      expect((description as { tier?: string } | undefined)?.tier).toBe('local');
   });
});

describe('HydraniumScopeProvider.createScopeForNodes once per build', () => {
   /** Give `document` fresh local symbols, as a build that recomputes them does. */
   const rebuild = (document: LangiumDocument): void => {
      (document as { localSymbols?: object }).localSymbols = {};
   };

   it('answers a list of a built document with the same scope until the document is built again', () => {
      const { container, document } = makeContainer();
      const provider = probe(ProbeScopeProvider);
      rebuild(document);
      const first = provider.scopeFor(container.members);

      // Identity compared as a boolean: `toBe` deep-compares on a mismatch,
      // which reads description getters these stub services cannot serve.
      expect(provider.scopeFor(container.members) === first).toBe(true);
      rebuild(document);
      expect(provider.scopeFor(container.members) === first).toBe(false);
   });

   it('keeps the cache for a subclass that changes the scope through createNodeScope', () => {
      const { container, document } = makeContainer();
      const provider = probe(CountingScopeProvider);
      rebuild(document);

      provider.scopeFor(container.members);
      provider.scopeFor(container.members);
      expect(provider.built).toBe(1);
   });

   it('builds a scope per call for a list outside the built root, such as an operation copy', () => {
      const { container, document } = makeContainer();
      const provider = probe(ProbeScopeProvider);
      rebuild(document);
      const copy = makeFakeAstNode<FakeContainer>({ $type: 'BaseType', name: 'Base', members: [] });
      (copy as { members: FakeMember[] }).members = container.members.map(member =>
         makeFakeAstNode<FakeMember>({ $type: 'TypeOne', name: member.name, $container: copy, $containerProperty: 'members' })
      );
      (copy as { $document?: unknown }).$document = document;

      expect(provider.scopeFor(copy.members) === provider.scopeFor(copy.members)).toBe(false);
      expect(provider.scopeFor(copy.members).getElement('one')?.name).toBe('one');
   });

   it('builds a scope per call when an outer scope is passed', () => {
      const { container, document } = makeContainer();
      const provider = probe(ProbeScopeProvider);
      rebuild(document);
      const outer = provider.scopeFor([]);

      expect(provider.scopeFor(container.members, outer) === provider.scopeFor(container.members, outer)).toBe(false);
   });
});
