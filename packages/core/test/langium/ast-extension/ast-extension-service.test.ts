/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { afterEach, describe, expect, it } from 'vitest';
import { type AstNode, DocumentState, type LangiumDocument } from '@hydranium/langium';
import { CancellationToken } from 'vscode-languageserver';
import { Logger } from '@hydranium/protocol';
import { makeFakeClock } from '@hydranium/protocol/testing';
import {
   type AstExtensionService,
   DefaultAstExtensionService,
   setHiddenProperty
} from '../../../src/langium/ast-extension/ast-extension-service.js';
import { makeCapturingTracer, makeFakeAstNode, makeFakeDocument, makeNoopLanguageServices } from '../../../src/testing/index.js';

interface FakeNode extends AstNode {
   readonly $type: string;
   readonly id?: string;
   _computed?: string;
   _children?: FakeNode[];
}

function isType(type: string): (node: AstNode) => node is FakeNode {
   return (node: AstNode): node is FakeNode => node.$type === type;
}

/**
 * Build a `LangiumDocument`-shaped object backed by an explicit child list. We
 * stub `parseResult.value` and rely on `streamAllContents` walking own
 * enumerable properties — assigning the children to an own enumerable property
 * that is a real array is sufficient for the iterator.
 */
function buildDocument(root: FakeNode, children: FakeNode[]): LangiumDocument {
   for (const child of children) {
      (child as { $container?: AstNode }).$container = root;
   }
   (root as FakeNode & { _children?: FakeNode[] })._children = children;
   return makeFakeDocument('file:///doc.fake', root);
}

function makeService(): AstExtensionService {
   // Per-language shape: the service reads its tracer via `.shared` (the no-op
   // default) and its contribution group via `.ast`, which the no-op stub omits
   // — the constructor's optional chaining is what tolerates that.
   return new DefaultAstExtensionService(makeNoopLanguageServices());
}

describe('AstExtensionService — extendNode', () => {
   it('runs only registrations whose `nodeFilter` matches the node', () => {
      const service = makeService();
      const fooCalls: AstNode[] = [];
      const barCalls: AstNode[] = [];

      service.register({
         id: 'foo',
         nodeFilter: isType('Foo'),
         state: DocumentState.ComputedScopes,
         compute: node => void fooCalls.push(node)
      });
      service.register({
         id: 'bar',
         nodeFilter: isType('Bar'),
         state: DocumentState.ComputedScopes,
         compute: node => void barCalls.push(node)
      });

      const fooNode = makeFakeAstNode<FakeNode>({ $type: 'Foo' });
      service.extendNode(fooNode, {} as LangiumDocument, DocumentState.ComputedScopes);

      expect(fooCalls).toEqual([fooNode]);
      expect(barCalls).toEqual([]);
   });

   it('dispatches in priority order — lower runs first', () => {
      const service = makeService();
      const calls: string[] = [];

      service.register({
         id: 'late',
         priority: 10,
         nodeFilter: isType('Foo'),
         state: DocumentState.ComputedScopes,
         compute: () => void calls.push('late')
      });
      service.register({
         id: 'early',
         priority: -1,
         nodeFilter: isType('Foo'),
         state: DocumentState.ComputedScopes,
         compute: () => void calls.push('early')
      });
      service.register({
         id: 'mid',
         priority: 5,
         nodeFilter: isType('Foo'),
         state: DocumentState.ComputedScopes,
         compute: () => void calls.push('mid')
      });

      service.extendNode(makeFakeAstNode<FakeNode>({ $type: 'Foo' }), {} as LangiumDocument, DocumentState.ComputedScopes);
      expect(calls).toEqual(['early', 'mid', 'late']);
   });

   it('breaks priority ties by registration order', () => {
      const service = makeService();
      const calls: string[] = [];

      service.register({
         id: 'first',
         nodeFilter: isType('Foo'),
         state: DocumentState.ComputedScopes,
         compute: () => void calls.push('first')
      });
      service.register({
         id: 'second',
         nodeFilter: isType('Foo'),
         state: DocumentState.ComputedScopes,
         compute: () => void calls.push('second')
      });

      service.extendNode(makeFakeAstNode<FakeNode>({ $type: 'Foo' }), {} as LangiumDocument, DocumentState.ComputedScopes);
      expect(calls).toEqual(['first', 'second']);
   });
});

describe('AstExtensionService — extendDocument', () => {
   it('refresh runs the matching registration against every node in the document', () => {
      const service = makeService();
      const refreshCalls: string[] = [];

      service.register({
         id: 'refresh-foo',
         nodeFilter: isType('Foo'),
         state: DocumentState.Linked,
         compute: node => void refreshCalls.push((node as FakeNode).id ?? '')
      });

      const root = makeFakeAstNode<FakeNode>({ $type: 'Root' });
      const doc = buildDocument(root, [
         makeFakeAstNode<FakeNode>({ $type: 'Foo', id: 'a' }),
         makeFakeAstNode<FakeNode>({ $type: 'Bar', id: 'b' }),
         makeFakeAstNode<FakeNode>({ $type: 'Foo', id: 'c' })
      ]);
      service.extendDocument(doc, DocumentState.Linked);

      expect(refreshCalls).toEqual(['a', 'c']);
   });

   it('documentFilter skips compute for documents the filter rejects', () => {
      const service = makeService();
      const calls: string[] = [];

      service.register({
         id: 'filtered',
         nodeFilter: isType('Foo'),
         documentFilter: document => (document as unknown as { tag?: string }).tag === 'apply',
         state: DocumentState.Linked,
         compute: () => void calls.push('ran')
      });

      const accept = buildDocument(makeFakeAstNode<FakeNode>({ $type: 'Root' }), [makeFakeAstNode<FakeNode>({ $type: 'Foo' })]);
      (accept as unknown as { tag: string }).tag = 'apply';
      const reject = buildDocument(makeFakeAstNode<FakeNode>({ $type: 'Root' }), [makeFakeAstNode<FakeNode>({ $type: 'Foo' })]);
      (reject as unknown as { tag: string }).tag = 'skip';

      service.extendDocument(reject, DocumentState.Linked);
      expect(calls).toEqual([]);

      service.extendDocument(accept, DocumentState.Linked);
      expect(calls).toEqual(['ran']);
   });

   it('refresh skips streamAllContents walk entirely when every registration rejects the document', () => {
      const service = makeService();
      let streamWalked = false;

      service.register({
         id: 'a',
         nodeFilter: isType('Foo'),
         documentFilter: () => false,
         state: DocumentState.Linked,
         compute: () => undefined
      });
      service.register({
         id: 'b',
         nodeFilter: isType('Bar'),
         documentFilter: () => false,
         state: DocumentState.Linked,
         compute: () => undefined
      });

      // Root with a getter on `_children` — fired only if streamAllContents
      // enumerates own enumerable properties of root looking for AstNode-shaped
      // values. If every documentFilter rejects, the walk is skipped and the
      // getter never runs.
      const root = makeFakeAstNode<FakeNode>({ $type: 'Root' });
      Object.defineProperty(root, '_children', {
         configurable: true,
         enumerable: true,
         get() {
            streamWalked = true;
            return [];
         }
      });
      const document = { parseResult: { value: root } } as unknown as LangiumDocument;

      service.extendDocument(document, DocumentState.Linked);
      expect(streamWalked).toBe(false);
   });

   it('refresh runs registrations whose filter accepts even if siblings reject', () => {
      const service = makeService();
      const calls: string[] = [];

      service.register({
         id: 'rejected',
         nodeFilter: isType('Foo'),
         documentFilter: () => false,
         state: DocumentState.Linked,
         compute: () => void calls.push('rejected')
      });
      service.register({
         id: 'accepted',
         nodeFilter: isType('Foo'),
         documentFilter: () => true,
         state: DocumentState.Linked,
         compute: () => void calls.push('accepted')
      });
      service.register({
         id: 'no-filter',
         nodeFilter: isType('Foo'),
         state: DocumentState.Linked,
         compute: () => void calls.push('no-filter')
      });

      const doc = buildDocument(makeFakeAstNode<FakeNode>({ $type: 'Root' }), [makeFakeAstNode<FakeNode>({ $type: 'Foo' })]);
      service.extendDocument(doc, DocumentState.Linked);

      expect(calls).toEqual(['accepted', 'no-filter']);
   });

   it('refresh bucket invalidates when a registration is disposed', () => {
      const service = makeService();
      const calls: string[] = [];

      const handle = service.register({
         id: 'temp',
         nodeFilter: isType('Foo'),
         state: DocumentState.Linked,
         compute: () => void calls.push('temp')
      });
      service.register({
         id: 'permanent',
         nodeFilter: isType('Foo'),
         state: DocumentState.Linked,
         compute: () => void calls.push('permanent')
      });

      const doc = buildDocument(makeFakeAstNode<FakeNode>({ $type: 'Root' }), [makeFakeAstNode<FakeNode>({ $type: 'Foo' })]);
      service.extendDocument(doc, DocumentState.Linked);
      expect(calls).toEqual(['temp', 'permanent']);

      handle.dispose();
      calls.length = 0;
      service.extendDocument(doc, DocumentState.Linked);
      expect(calls).toEqual(['permanent']);
   });

   it('refresh fires only at the registered state, not at other states', () => {
      const service = makeService();
      let calls = 0;

      service.register({
         id: 'linked-only',
         nodeFilter: isType('Foo'),
         state: DocumentState.Linked,
         compute: () => void calls++
      });

      const doc = buildDocument(makeFakeAstNode<FakeNode>({ $type: 'Root' }), [makeFakeAstNode<FakeNode>({ $type: 'Foo' })]);
      service.extendDocument(doc, DocumentState.Parsed);
      expect(calls).toBe(0);

      service.extendDocument(doc, DocumentState.Linked);
      expect(calls).toBe(1);
   });
});

describe('AstExtensionService — extendDocument cancellation', () => {
   it('skips the refresh walk for documents arriving with an already-cancelled token', () => {
      const service = makeService();
      const calls: string[] = [];

      service.register({
         id: 'refresh-foo',
         nodeFilter: isType('Foo'),
         state: DocumentState.Linked,
         compute: () => void calls.push('ran')
      });

      const doc = buildDocument(makeFakeAstNode<FakeNode>({ $type: 'Root' }), [makeFakeAstNode<FakeNode>({ $type: 'Foo' })]);
      service.extendDocument(doc, DocumentState.Linked, CancellationToken.Cancelled);
      expect(calls).toEqual([]);

      // Subsequent uncancelled fire still runs — entry-check is per-document, not sticky.
      service.extendDocument(doc, DocumentState.Linked);
      expect(calls).toEqual(['ran']);
   });
});

describe('AstExtensionService — disposal', () => {
   it('removes the registration so subsequent dispatches skip it', () => {
      const service = makeService();
      const calls: string[] = [];

      const handle = service.register({
         id: 'x',
         nodeFilter: isType('Foo'),
         state: DocumentState.ComputedScopes,
         compute: () => void calls.push('x')
      });
      service.extendNode(makeFakeAstNode<FakeNode>({ $type: 'Foo' }), {} as LangiumDocument, DocumentState.ComputedScopes);
      handle.dispose();
      service.extendNode(makeFakeAstNode<FakeNode>({ $type: 'Foo' }), {} as LangiumDocument, DocumentState.ComputedScopes);

      expect(calls).toEqual(['x']);
   });

   it('throws on duplicate id', () => {
      const service = makeService();
      service.register({ id: 'dup', nodeFilter: isType('Foo'), state: DocumentState.ComputedScopes, compute: () => undefined });
      expect(() =>
         service.register({ id: 'dup', nodeFilter: isType('Foo'), state: DocumentState.ComputedScopes, compute: () => undefined })
      ).toThrow(/Duplicate registry id: 'dup'/);
   });
});

describe('AstExtensionService — extendDocument profiling', () => {
   afterEach(() => Logger.setLevel('info'));

   it('profiles per-registration self-time and reports it line-based at debug level', () => {
      const { tracer, lines } = makeCapturingTracer(makeFakeClock());
      const service = new DefaultAstExtensionService(makeNoopLanguageServices({ shared: { Tracer: tracer } }));
      service.register({ id: 'extA', nodeFilter: isType('Foo'), state: DocumentState.Linked, compute: () => undefined });
      service.register({ id: 'extB', nodeFilter: isType('Foo'), state: DocumentState.Linked, compute: () => undefined });
      Logger.setLevel('debug');

      const doc = buildDocument(makeFakeAstNode<FakeNode>({ $type: 'Root' }), [
         makeFakeAstNode<FakeNode>({ $type: 'Foo', id: 'a' }),
         makeFakeAstNode<FakeNode>({ $type: 'Foo', id: 'b' })
      ]);
      service.extendDocument(doc, DocumentState.Linked);

      const profileLines = lines.map(line => line.message).filter(message => message.includes('[profile ast-extension'));
      expect(profileLines.some(message => message.includes('extA'))).toBe(true);
      expect(profileLines.some(message => message.includes('extB'))).toBe(true);
   });

   it('allocates no session at the default info level', () => {
      const { tracer, lines } = makeCapturingTracer(makeFakeClock());
      const service = new DefaultAstExtensionService(makeNoopLanguageServices({ shared: { Tracer: tracer } }));
      service.register({ id: 'extA', nodeFilter: isType('Foo'), state: DocumentState.Linked, compute: () => undefined });

      const doc = buildDocument(makeFakeAstNode<FakeNode>({ $type: 'Root' }), [makeFakeAstNode<FakeNode>({ $type: 'Foo', id: 'a' })]);
      service.extendDocument(doc, DocumentState.Linked);

      expect(lines.map(line => line.message).filter(message => message.includes('[profile'))).toHaveLength(0);
   });
});

describe('AstExtensionService — contribution group consumption', () => {
   it('reads `services.ast.extensions` and calls each contribution at construction', () => {
      const calls: string[] = [];
      const ext = (id: string) => ({
         id,
         nodeFilter: isType('Foo'),
         state: DocumentState.ComputedScopes,
         compute: () => undefined
      });
      const services = makeNoopLanguageServices({
         ast: {
            extensions: {
               foo: {
                  registerAstExtensions: (registry: AstExtensionService) => {
                     calls.push('foo');
                     registry.register(ext('foo-1'));
                     registry.register(ext('foo-2'));
                  }
               },
               bar: {
                  registerAstExtensions: (registry: AstExtensionService) => {
                     calls.push('bar');
                     registry.register(ext('bar-1'));
                  }
               }
            }
         }
      });
      const service = new DefaultAstExtensionService(services);
      // Scope: that the service iterates whatever group it receives at
      // construction. How framework and adopter entries accumulate into that
      // group is a module-composition concern, not this service's.
      expect(calls.sort()).toEqual(['bar', 'foo']);
      // The contributions' own registrations record nothing, so dispatching
      // only shows that the imperative `register` below coexists with them
      // rather than replacing the group.
      const sink: string[] = [];
      service.register({
         id: 'sink',
         nodeFilter: isType('Foo'),
         state: DocumentState.ComputedScopes,
         compute: () => void sink.push('sink')
      });
      service.extendNode(makeFakeAstNode<FakeNode>({ $type: 'Foo' }), {} as LangiumDocument, DocumentState.ComputedScopes);
      expect(sink).toEqual(['sink']);
   });
});

describe('setHiddenProperty', () => {
   it('assigns a non-enumerable own property — invisible to Object.keys / for-in', () => {
      const target: { _hidden?: number; visible?: number } = { visible: 1 };
      setHiddenProperty(target, '_hidden', 42);

      expect(target._hidden).toBe(42);
      expect(Object.keys(target)).toEqual(['visible']);
      const enumerated: string[] = [];
      for (const key in target) {
         enumerated.push(key);
      }
      expect(enumerated).toEqual(['visible']);
   });

   it('still appears in Object.getOwnPropertyNames so wire-shape converters can find it', () => {
      const target = {};
      setHiddenProperty(target, '_hidden', 'value');
      expect(Object.getOwnPropertyNames(target)).toContain('_hidden');
   });

   it('is writable and configurable — subsequent calls overwrite cleanly', () => {
      const target: { _hidden?: number } = {};
      setHiddenProperty(target, '_hidden', 1);
      setHiddenProperty(target, '_hidden', 2);
      expect(target._hidden).toBe(2);
   });
});
