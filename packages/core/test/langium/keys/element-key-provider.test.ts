/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, expect, it } from 'vitest';
import { asMutable, Logger } from '@hydranium/protocol';
import { type AstNode, type AstNodeLocator, type LangiumCoreServices } from '@hydranium/langium';
import type { LangiumServices, LangiumSharedServices } from '@hydranium/langium/lsp';
import { assertCoreSlotsBound, STRICT_BINDINGS_ENV, warnOnUnexpectedBindings } from '../../../src/langium/bootstrap.js';
import { DefaultElementKeyProvider } from '../../../src/langium/keys/default-element-key-provider.js';
import { type ElementKeyProvider } from '../../../src/langium/keys/element-key-provider.js';
import { NameBasedKeyProvider } from '../../../src/langium/keys/name-based-key-provider.js';
import { type NameProvider } from '../../../src/langium/naming/name-provider.js';
import { PositionalKeyProvider } from '../../../src/langium/keys/positional-key-provider.js';
import { makeCapturingTracer, makeFakeAstNode, makeNoopLogger, makeNoopTracer } from '../../../src/testing/index.js';

type AnyNode = AstNode & Record<string, unknown>;

/**
 * Link `children` onto `parent[property]` and wire each child's
 * `$container`/`$containerProperty`/`$containerIndex` so Langium's
 * `streamAllContents` traverses them — needed to exercise the name-based
 * scan in {@link NameBasedKeyProvider.resolveElement}.
 */
function linkChildren(parent: AnyNode, property: string, children: AnyNode[]): void {
   parent[property] = children;
   children.forEach((child, index) => {
      asMutable(child).$container = parent;
      asMutable(child).$containerProperty = property;
      asMutable(child).$containerIndex = index;
   });
}

/**
 * Build a services stub with a stub {@link AstNodeLocator} (for
 * PositionalKeyProvider) and a stub {@link NameProvider} (for
 * NameBasedKeyProvider). The two providers consume different services
 * — both stubs are present so a single helper covers either class.
 */
function makeServices(
   options: {
      getAstNodePath?: (node: AstNode) => string;
      getAstNode?: (root: AstNode, path: string) => AstNode | undefined;
      getOwnName?: (node: AstNode) => string | undefined;
      hasName?: (node: AstNode) => boolean;
      nameSeparator?: string;
   } = {}
): LangiumCoreServices {
   const locator = {
      getAstNodePath: options.getAstNodePath ?? (() => '<no-locator>'),
      getAstNode: options.getAstNode ?? (() => undefined)
   } as unknown as AstNodeLocator;
   const nameProvider = {
      getOwnName: options.getOwnName ?? ((node: AstNode) => (node as AnyNode).name as string | undefined),
      hasName: options.hasName ?? ((node: AstNode) => typeof (node as AnyNode).name === 'string'),
      nameSeparator: options.nameSeparator ?? '.'
   } as unknown as NameProvider;
   return {
      references: { NameProvider: nameProvider },
      workspace: { AstNodeLocator: locator },
      shared: { Logger: makeNoopLogger(), Tracer: makeNoopTracer() }
   } as unknown as LangiumCoreServices;
}

describe('PositionalKeyProvider', () => {
   it('returns undefined when node is undefined', () => {
      const provider = new PositionalKeyProvider(makeServices({ getAstNodePath: () => '<should-not-be-called>' }) as never);
      expect(provider.getElementKey(undefined)).toBeUndefined();
   });

   it('emits a `trace` log line on construction', () => {
      // Guards the constructor body (the only side effect is the trace call).
      // The line is emitted at trace level, so raise the threshold to capture it.
      // The threshold is process-wide, not per logger — hence the restore.
      const previousLevel = Logger.getLevel();
      Logger.setLevel('trace');
      try {
         const { tracer, lines } = makeCapturingTracer();
         const services = makeServices();
         (services.shared as unknown as { Tracer: unknown }).Tracer = tracer;
         const provider = new PositionalKeyProvider(services as never);
         expect(provider).toBeInstanceOf(PositionalKeyProvider);
         expect(lines.map(line => line.message)).toContain('instantiated');
      } finally {
         Logger.setLevel(previousLevel);
      }
   });

   it('delegates to AstNodeLocator.getAstNodePath for the positional path', () => {
      const provider = new PositionalKeyProvider(makeServices({ getAstNodePath: () => '/members@0/members@2' }) as never);
      const node = makeFakeAstNode<AnyNode>({ $type: 'TypeOne', name: 'Element' });
      expect(provider.getElementKey(node)).toBe('/members@0/members@2');
   });

   it('forwards the AstNodeLocator output verbatim — no rewriting', () => {
      const provider = new PositionalKeyProvider(makeServices({ getAstNodePath: node => `path-for-${node.$type}` }) as never);
      const node = makeFakeAstNode<AnyNode>({ $type: 'TypeTwo', name: 'Element' });
      expect(provider.getElementKey(node)).toBe('path-for-TypeTwo');
   });
});

describe('NameBasedKeyProvider', () => {
   it('returns undefined when node is undefined', () => {
      const provider = new NameBasedKeyProvider(makeServices() as never);
      expect(provider.getElementKey(undefined)).toBeUndefined();
   });

   it('returns the own name for a semantic root', () => {
      // Unwrapped grammar: the named document root IS the semantic root.
      const provider = new NameBasedKeyProvider(makeServices() as never);
      const root = makeFakeAstNode<AnyNode>({ $type: 'BaseType', name: 'Element' });
      expect(provider.getElementKey(root)).toBe('Element');
   });

   it('walks named ancestors stopping at the semantic root (wrapper grammar)', () => {
      // Wrapper grammar: unnamed wrapper → named semantic root → intermediate → leaf.
      // Expected key of the leaf: "Element1.Element2" (semantic root excluded by predicate).
      const wrapper = makeFakeAstNode<AnyNode>({ $type: 'Root' });
      const semanticRoot = makeFakeAstNode<AnyNode>({ $type: 'BaseType', $container: wrapper, name: 'Element' });
      const intermediate = makeFakeAstNode<AnyNode>({ $type: 'TypeTwo', $container: semanticRoot, name: 'Element1' });
      const leaf = makeFakeAstNode<AnyNode>({ $type: 'TypeOne', $container: intermediate, name: 'Element2' });
      const provider = new NameBasedKeyProvider(makeServices() as never);
      expect(provider.getElementKey(leaf)).toBe('Element1.Element2');
   });

   it('walks named ancestors stopping at the semantic root (unwrapped grammar)', () => {
      // Unwrapped grammar: the named document root IS the semantic root, so it is excluded
      // and only the intermediate and the leaf contribute segments.
      const root = makeFakeAstNode<AnyNode>({ $type: 'BaseType', name: 'Element' });
      const intermediate = makeFakeAstNode<AnyNode>({ $type: 'TypeTwo', $container: root, name: 'Element1' });
      const leaf = makeFakeAstNode<AnyNode>({ $type: 'TypeOne', $container: intermediate, name: 'Element2' });
      const provider = new NameBasedKeyProvider(makeServices() as never);
      expect(provider.getElementKey(leaf)).toBe('Element1.Element2');
   });

   it('uses containerProperty@containerIndex fallback for unnamed intermediate ancestors', () => {
      // wrapper → named semantic root → unnamed intermediate → named leaf.
      const wrapper = makeFakeAstNode<AnyNode>({ $type: 'Root' });
      const semanticRoot = makeFakeAstNode<AnyNode>({ $type: 'BaseType', $container: wrapper, name: 'Element1' });
      const unnamed = makeFakeAstNode<AnyNode>({ $type: 'TypeTwo', $container: semanticRoot });
      asMutable(unnamed).$containerProperty = 'members';
      asMutable(unnamed).$containerIndex = 2;
      const leaf = makeFakeAstNode<AnyNode>({ $type: 'TypeOne', $container: unnamed, name: 'Element2' });
      const provider = new NameBasedKeyProvider(makeServices() as never);
      expect(provider.getElementKey(leaf)).toBe('members@2.Element2');
   });

   it('returns undefined when the node has no name and no container position', () => {
      const node = makeFakeAstNode<AnyNode>({ $type: 'UnknownType' });
      const provider = new NameBasedKeyProvider(makeServices() as never);
      expect(provider.getElementKey(node)).toBeUndefined();
   });

   it('returns undefined when the first segment resolves to an empty string', () => {
      // getOwnName yields '' (not nullish, so it is taken verbatim as the key), and the
      // node is a semantic root (hasName → true, no container). The `if (!id)` guard must
      // reject the empty key rather than returning '' as a valid one.
      const node = makeFakeAstNode<AnyNode>({ $type: 'BaseType' });
      const provider = new NameBasedKeyProvider(
         makeServices({
            getOwnName: () => '',
            hasName: () => true
         }) as never
      );
      expect(provider.getElementKey(node)).toBeUndefined();
   });

   it('stops at the semantic root — does not fold a (named) container into the key', () => {
      // Wrapper is named so the walk WOULD prepend it if the semantic-root short-circuit
      // were skipped, but hasName(wrapper) is false so the child is classified as the
      // semantic root. Skipping the early return would yield 'Element1.Element2'.
      const wrapper = makeFakeAstNode<AnyNode>({ $type: 'Wrapper', name: 'Element1' });
      const root = makeFakeAstNode<AnyNode>({ $type: 'Root', $container: wrapper, name: 'Element2' });
      const provider = new NameBasedKeyProvider(
         makeServices({
            getOwnName: node => (node as AnyNode).name as string | undefined,
            // Wrapper reports no name → its direct child is the semantic root.
            hasName: node => (node as AnyNode).$type !== 'Wrapper' && typeof (node as AnyNode).name === 'string'
         }) as never
      );
      expect(provider.getElementKey(root)).toBe('Element2');
   });

   it('skips an unnamed intermediate ancestor with no container position (no empty segment folded in)', () => {
      // intermediate has neither a name nor a container position → unidentifiedSegment
      // returns undefined → the `if (segment)` guard must skip it. If it always prepended,
      // the key would contain the string 'undefined'.
      const wrapper = makeFakeAstNode<AnyNode>({ $type: 'Root' });
      const semanticRoot = makeFakeAstNode<AnyNode>({ $type: 'BaseType', $container: wrapper, name: 'Element1' });
      const intermediate = makeFakeAstNode<AnyNode>({ $type: 'TypeTwo', $container: semanticRoot }); // no name, no $containerProperty/$containerIndex
      const leaf = makeFakeAstNode<AnyNode>({ $type: 'TypeOne', $container: intermediate, name: 'Element2' });
      const provider = new NameBasedKeyProvider(makeServices() as never);
      expect(provider.getElementKey(leaf)).toBe('Element2');
   });

   it('treats an intermediate with a containerProperty but no containerIndex as having no segment', () => {
      const wrapper = makeFakeAstNode<AnyNode>({ $type: 'Root' });
      const semanticRoot = makeFakeAstNode<AnyNode>({ $type: 'BaseType', $container: wrapper, name: 'Element1' });
      const intermediate = makeFakeAstNode<AnyNode>({ $type: 'TypeTwo', $container: semanticRoot });
      asMutable(intermediate).$containerProperty = 'members';
      // $containerIndex deliberately left undefined.
      const leaf = makeFakeAstNode<AnyNode>({ $type: 'TypeOne', $container: intermediate, name: 'Element2' });
      const provider = new NameBasedKeyProvider(makeServices() as never);
      // With `&&` instead of `||`, or with the guard dropped, this would be 'members@undefined.Element2'.
      expect(provider.getElementKey(leaf)).toBe('Element2');
   });

   it('treats an intermediate with a containerIndex but no containerProperty as having no segment', () => {
      const wrapper = makeFakeAstNode<AnyNode>({ $type: 'Root' });
      const semanticRoot = makeFakeAstNode<AnyNode>({ $type: 'BaseType', $container: wrapper, name: 'Element1' });
      const intermediate = makeFakeAstNode<AnyNode>({ $type: 'TypeTwo', $container: semanticRoot });
      asMutable(intermediate).$containerIndex = 0;
      // $containerProperty deliberately left undefined.
      const leaf = makeFakeAstNode<AnyNode>({ $type: 'TypeOne', $container: intermediate, name: 'Element2' });
      const provider = new NameBasedKeyProvider(makeServices() as never);
      expect(provider.getElementKey(leaf)).toBe('Element2');
   });

   it('respects nameSeparator from the NameProvider', () => {
      const wrapper = makeFakeAstNode<AnyNode>({ $type: 'Root' });
      const semanticRoot = makeFakeAstNode<AnyNode>({ $type: 'BaseType', $container: wrapper, name: 'Element' });
      const intermediate = makeFakeAstNode<AnyNode>({ $type: 'TypeTwo', $container: semanticRoot, name: 'Element1' });
      const leaf = makeFakeAstNode<AnyNode>({ $type: 'TypeOne', $container: intermediate, name: 'Element2' });
      const provider = new NameBasedKeyProvider(makeServices({ nameSeparator: '::' }) as never);
      expect(provider.getElementKey(leaf)).toBe('Element1::Element2');
   });
});

describe('DefaultElementKeyProvider — framework default', () => {
   it('is aliased to NameBasedKeyProvider', () => {
      expect(DefaultElementKeyProvider).toBe(NameBasedKeyProvider);
   });

   it('produces name-based keys out of the box', () => {
      const wrapper = makeFakeAstNode<AnyNode>({ $type: 'Root' });
      const semanticRoot = makeFakeAstNode<AnyNode>({ $type: 'BaseType', $container: wrapper, name: 'Element' });
      const intermediate = makeFakeAstNode<AnyNode>({ $type: 'TypeTwo', $container: semanticRoot, name: 'Element1' });
      const leaf = makeFakeAstNode<AnyNode>({ $type: 'TypeOne', $container: intermediate, name: 'Element2' });
      const provider = new DefaultElementKeyProvider(makeServices() as never);
      expect(provider.getElementKey(leaf)).toBe('Element1.Element2');
   });
});

describe('ElementKeyProvider — swap interface', () => {
   /**
    * A plain object literal implementing {@link ElementKeyProvider} — no
    * framework base class anywhere in its prototype chain. This is the binding
    * an adopter with externally-assigned identifiers produces.
    */
   const uuidProvider: ElementKeyProvider = {
      getElementKey: (node?: AstNode) => (node ? `uuid-${(node as AnyNode).id}` : undefined),
      resolveElement: () => undefined
   };

   /** Language tree whose ElementKeyProvider slot holds {@link uuidProvider}. */
   function languageWithSwappedProvider(): LangiumServices {
      return {
         references: {
            ScopeComputation: {},
            ScopeProvider: {},
            ElementKeyProvider: uuidProvider,
            NameProvider: {}
         },
         serializer: { Serializer: {} }
      } as unknown as LangiumServices;
   }

   function sharedWithCapturingLogger(warns: string[]): LangiumSharedServices {
      return {
         ServiceRegistry: { register: () => undefined },
         Logger: { warn: (message: string) => warns.push(message) },
         Tracer: makeNoopTracer(),
         lsp: { configurationRoot: 'test-language' },
         workspace: {
            WorkspaceManager: {},
            ProjectManager: {},
            SelfSaveRegistry: {},
            TextDocuments: {},
            AstDocumentManager: {},
            BuildPipelineIntegration: {}
         }
      } as unknown as LangiumSharedServices;
   }

   function withStrictEnv<T>(value: string | undefined, fn: () => T): T {
      const previous = process.env[STRICT_BINDINGS_ENV];
      if (value === undefined) {
         delete process.env[STRICT_BINDINGS_ENV];
      } else {
         process.env[STRICT_BINDINGS_ENV] = value;
      }
      try {
         return fn();
      } finally {
         if (previous === undefined) {
            delete process.env[STRICT_BINDINGS_ENV];
         } else {
            process.env[STRICT_BINDINGS_ENV] = previous;
         }
      }
   }

   it('accepts an inheritance-free ElementKeyProvider as a bound framework slot', () => {
      // Framework code has to participate for this to be able to fail: the slot
      // is one `assertCoreSlotsBound` walks, so a binding it rejected would
      // throw here. Asserting an inline literal's own arrow return, by contrast,
      // is enforced by the type annotation under `typecheck:test` and no
      // framework change of any kind can redden it.
      expect(() => assertCoreSlotsBound(sharedWithCapturingLogger([]), languageWithSwappedProvider())).not.toThrow();
   });

   it('is exempt from the strict-binding base-class diagnostic, unlike the slots that carry framework behaviour', () => {
      const warns: string[] = [];
      withStrictEnv('1', () => warnOnUnexpectedBindings(sharedWithCapturingLogger(warns), languageWithSwappedProvider()));

      // The checker RAN — the neighbouring behaviour-bearing slots in the same
      // tree are bound to bare literals and do warn. Without this, an empty
      // `warns` proves nothing: a diagnostic that never executed looks the same.
      expect(warns.some(message => /references\.ScopeComputation/.test(message))).toBe(true);
      // ...and having run, it said nothing about the swapped slot.
      expect(warns.filter(message => /ElementKeyProvider/.test(message))).toEqual([]);
   });

   it('produces the adopter key through the swapped implementation', () => {
      const node = makeFakeAstNode<AnyNode>({ $type: 'TypeOne', id: 'element-1', name: 'Element' });
      const services = languageWithSwappedProvider() as unknown as { references: { ElementKeyProvider: ElementKeyProvider } };
      expect(services.references.ElementKeyProvider.getElementKey(node)).toBe('uuid-element-1');
   });
});

describe('PositionalKeyProvider.resolveElement', () => {
   it('delegates to AstNodeLocator.getAstNode against the document root', () => {
      const wrapper = makeFakeAstNode<AnyNode>({ $type: 'Root' });
      const child = makeFakeAstNode<AnyNode>({ $type: 'TypeTwo', $container: wrapper, name: 'Element' });
      const seen: Array<{ root: AstNode; path: string }> = [];
      const target = makeFakeAstNode<AnyNode>({ $type: 'TypeTwo', name: 'Element1' });
      const provider = new PositionalKeyProvider(
         makeServices({
            getAstNode: (root, path) => {
               seen.push({ root, path });
               return target;
            }
         }) as never
      );
      // context is a deep child; resolution must run from the document root.
      expect(provider.resolveElement('/members@0', child)).toBe(target);
      expect(seen).toEqual([{ root: wrapper, path: '/members@0' }]);
   });
});

describe('NameBasedKeyProvider.resolveElement', () => {
   // wrapper → semantic root → intermediate → two leaves, linked so streamAllContents traverses.
   function buildTree(): { semanticRoot: AnyNode; intermediate: AnyNode; first: AnyNode; second: AnyNode } {
      const wrapper = makeFakeAstNode<AnyNode>({ $type: 'Root' });
      const semanticRoot = makeFakeAstNode<AnyNode>({ $type: 'BaseType', $container: wrapper, name: 'Element' });
      linkChildren(wrapper, 'members', [semanticRoot]);
      const intermediate = makeFakeAstNode<AnyNode>({ $type: 'TypeTwo', name: 'Element1' });
      linkChildren(semanticRoot, 'members', [intermediate]);
      const first = makeFakeAstNode<AnyNode>({ $type: 'TypeOne', name: 'Element2' });
      const second = makeFakeAstNode<AnyNode>({ $type: 'TypeOne', name: 'Element' });
      linkChildren(intermediate, 'members', [first, second]);
      return { semanticRoot, intermediate, first, second };
   }

   it('round-trips a key back to its node within the scope', () => {
      const { semanticRoot, first } = buildTree();
      const provider = new NameBasedKeyProvider(makeServices() as never);
      const key = provider.getElementKey(first);
      expect(key).toBe('Element1.Element2');
      expect(provider.resolveElement(key!, semanticRoot)).toBe(first);
   });

   it('returns undefined for a key that matches nothing in scope', () => {
      const { semanticRoot } = buildTree();
      const provider = new NameBasedKeyProvider(makeServices() as never);
      expect(provider.resolveElement('Element1.Missing', semanticRoot)).toBeUndefined();
   });

   it('returns the first (document-order) match when keys collide (no uniqueness guarantee)', () => {
      // Two leaves that produce the SAME key — the round-trip law would fail here, which is
      // exactly the duplicate-name condition adopter validation is responsible for.
      const wrapper = makeFakeAstNode<AnyNode>({ $type: 'Root' });
      const semanticRoot = makeFakeAstNode<AnyNode>({ $type: 'BaseType', $container: wrapper, name: 'Element' });
      linkChildren(wrapper, 'members', [semanticRoot]);
      const intermediate = makeFakeAstNode<AnyNode>({ $type: 'TypeTwo', name: 'Element1' });
      linkChildren(semanticRoot, 'members', [intermediate]);
      const first = makeFakeAstNode<AnyNode>({ $type: 'TypeOne', name: 'Element2' });
      const second = makeFakeAstNode<AnyNode>({ $type: 'TypeOne', name: 'Element2' });
      linkChildren(intermediate, 'members', [first, second]);
      const provider = new NameBasedKeyProvider(makeServices() as never);
      expect(provider.resolveElement('Element1.Element2', semanticRoot)).toBe(first);
   });
});
