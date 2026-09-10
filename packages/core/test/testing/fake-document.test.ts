/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { DocumentState, URI, type AstNode } from '@hydranium/langium';
import type { TransferDiagnostic } from '@hydranium/protocol';
import { describe, expect, it } from 'vitest';
import { makeFakeAstNode, makeFakeDocument } from '../../src/testing/fake-document.js';
import { makeFakeReflection } from '../../src/testing/fake-reflection.js';

interface FakeRoot extends AstNode {
   readonly $type: 'FakeRoot';
   readonly name: string;
}

const URI_A = 'file:///A.fake';

describe('makeFakeAstNode', () => {
   it('returns the node verbatim, typed as the requested AST node', () => {
      const node = makeFakeAstNode({ $type: 'Edge', target: 'someId' });
      expect(node).toEqual({ $type: 'Edge', target: 'someId' });
   });

   it('preserves nested objects, arrays, and internal _id properties', () => {
      const node = makeFakeAstNode({ $type: 'Group', members: ['a', 'b'], _id: 'g1', meta: { kind: 'x' } });
      expect(node).toEqual({ $type: 'Group', members: ['a', 'b'], _id: 'g1', meta: { kind: 'x' } });
   });

   it('does NOT set the $synthetic marker (it is a fixture, not a framework synthetic node)', () => {
      const node = makeFakeAstNode({ $type: 'TypeOne' }) as AstNode & { $synthetic?: boolean };
      expect(node.$synthetic).toBeUndefined();
   });

   it('hands back the same reference it was given (no copy)', () => {
      const input = { $type: 'Node' };
      expect(makeFakeAstNode(input)).toBe(input);
   });

   describe('with a reflection', () => {
      const reflection = makeFakeReflection({
         TypeOne: { children: { defaultValue: [] }, active: { defaultValue: false } }
      });

      it("fills the grammar's declared defaults, so a fixture matches what parsing produces", () => {
         const node = makeFakeAstNode<AstNode>({ $type: 'TypeOne' }, reflection);
         expect(node).toEqual({ $type: 'TypeOne', children: [], active: false });
      });

      it('lets the fixture override a default', () => {
         const node = makeFakeAstNode({ $type: 'TypeOne', active: true }, reflection);
         expect((node as AstNode & { active: boolean }).active).toBe(true);
      });

      it('copies rather than aliasing the input, so a shared literal cannot leak defaults', () => {
         const input = { $type: 'TypeOne' };
         const node = makeFakeAstNode(input, reflection);
         expect(node).not.toBe(input);
         expect(input).toEqual({ $type: 'TypeOne' });
      });

      it('adds nothing for a type the reflection does not declare', () => {
         const node = makeFakeAstNode({ $type: 'ns.Element' }, reflection);
         expect(node).toEqual({ $type: 'ns.Element' });
      });
   });
});

describe('makeFakeDocument', () => {
   it('builds a LangiumDocument shell with sensible defaults', () => {
      const document = makeFakeDocument(URI_A, makeFakeAstNode<FakeRoot>({ $type: 'FakeRoot', name: 'a' }));
      expect(document.uri.toString()).toBe(URI.parse(URI_A).toString());
      expect(document.parseResult.value.$type).toBe('FakeRoot');
      expect(document.state).toBe(DocumentState.Validated);
      expect(document.textDocument.version).toBe(1);
   });

   it('honours overrides for text, version, state, and diagnostics', () => {
      const document = makeFakeDocument<FakeRoot, TransferDiagnostic>(URI_A, makeFakeAstNode<FakeRoot>({ $type: 'FakeRoot', name: 'a' }), {
         text: 'name:a',
         version: 7,
         state: DocumentState.IndexedReferences,
         diagnostics: [{ id: 'd', message: 'msg' } as unknown as TransferDiagnostic]
      });
      expect(document.textDocument.getText()).toBe('name:a');
      expect(document.textDocument.version).toBe(7);
      expect(document.state).toBe(DocumentState.IndexedReferences);
      expect(document.diagnostics).toHaveLength(1);
   });
});
