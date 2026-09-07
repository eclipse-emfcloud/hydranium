/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, expect, it } from 'vitest';
import { type AstNode } from '@hydranium/langium';
import { DefaultLabelProvider } from '../../../src/langium/labeling/label-provider.js';
import { type HydraniumLanguageServices } from '../../../src/langium/language-module.js';
import { makeFakeAstNode, makeNoopTracer } from '../../../src/testing/index.js';

type AnyNode = AstNode & Record<string, unknown>;

const noopLogger = { for: () => noopLogger, trace: () => undefined };

/**
 * Services stub exposing a {@link NameProvider}'s `getOwnName` (the identifier
 * axis the label provider falls back to in `getLabelOrName`) and a no-op
 * logger. `getOwnName` defaults to reading `id` — modelling an adopter whose
 * identifier axis differs from its label axis.
 */
function makeServices(
   getOwnName: (node: AstNode) => string | undefined = node => (node as AnyNode).id as string | undefined
): HydraniumLanguageServices {
   return {
      references: { NameProvider: { getOwnName } },
      shared: { Logger: noopLogger, Tracer: makeNoopTracer() }
   } as unknown as HydraniumLanguageServices;
}

describe('DefaultLabelProvider', () => {
   describe('getLabel', () => {
      it('reads the configured labelProperties (default ["name"])', () => {
         const provider = new DefaultLabelProvider(makeServices());
         expect(provider.getLabel(makeFakeAstNode<AnyNode>({ $type: 'TypeOne', name: 'Element' }))).toBe('Element');
      });

      it('reads a custom label property independent of the name axis', () => {
         const provider = new DefaultLabelProvider(makeServices(), { labelProperties: ['label'] });
         expect(provider.getLabel(makeFakeAstNode<AnyNode>({ $type: 'TypeOne', label: 'Element', id: 'element-1' }))).toBe('Element');
      });

      it('is independent of nameProperties — labels by name even when the identifier is id', () => {
         // NameProvider reads `id`; LabelProvider (default ['name']) reads `name`.
         const provider = new DefaultLabelProvider(makeServices());
         const node = makeFakeAstNode<AnyNode>({ $type: 'TypeOne', id: 'element-1', name: 'Element1' });
         expect(provider.getLabel(node)).toBe('Element1');
      });

      it('returns undefined when no label property is present', () => {
         const provider = new DefaultLabelProvider(makeServices());
         expect(provider.getLabel(makeFakeAstNode<AnyNode>({ $type: 'Anonymous', id: 'x' }))).toBeUndefined();
      });

      it('returns undefined when the label property is not a string', () => {
         const provider = new DefaultLabelProvider(makeServices());
         expect(provider.getLabel(makeFakeAstNode<AnyNode>({ $type: 'Quirky', name: 42 }))).toBeUndefined();
      });

      it('returns undefined for undefined input', () => {
         const provider = new DefaultLabelProvider(makeServices());
         expect(provider.getLabel(undefined)).toBeUndefined();
      });
   });

   describe('hasLabel', () => {
      it('is true exactly when getLabel is defined', () => {
         const provider = new DefaultLabelProvider(makeServices());
         expect(provider.hasLabel(makeFakeAstNode<AnyNode>({ $type: 'TypeOne', name: 'X' }))).toBe(true);
         expect(provider.hasLabel(makeFakeAstNode<AnyNode>({ $type: 'TypeOne', id: 'X' }))).toBe(false);
      });
   });

   describe('getLabelOrName', () => {
      it('returns the own label when present', () => {
         const provider = new DefaultLabelProvider(makeServices());
         expect(provider.getLabelOrName(makeFakeAstNode<AnyNode>({ $type: 'TypeOne', name: 'Element', id: 'element-1' }))).toBe('Element');
      });

      it('falls back to NameProvider.getOwnName (the identifier) when no label', () => {
         const provider = new DefaultLabelProvider(makeServices());
         // No `name` → fall back to the identifier axis, which reads `id`.
         expect(provider.getLabelOrName(makeFakeAstNode<AnyNode>({ $type: 'TypeTwo', id: 'element-1' }))).toBe('element-1');
      });

      it('returns undefined when neither a label nor an identifier exists', () => {
         const provider = new DefaultLabelProvider(makeServices(() => undefined));
         expect(provider.getLabelOrName(makeFakeAstNode<AnyNode>({ $type: 'Anonymous' }))).toBeUndefined();
      });
   });
});
