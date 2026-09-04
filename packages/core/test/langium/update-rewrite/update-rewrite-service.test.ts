/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, expect, it } from 'vitest';
import { type AstNode, OperationCancelled } from '@hydranium/langium';
import { CancellationToken } from 'vscode-languageserver';
import { type TransferElement } from '@hydranium/protocol';
import { DefaultUpdateRewriteService } from '../../../src/langium/update-rewrite/update-rewrite-service.js';
import { type UpdateRewriteContribution } from '../../../src/langium/update-rewrite/update-rewrite-contribution.js';
import { NormalizeEmptyStringsContribution } from '../../../src/langium/update-rewrite/normalize-empty-strings.js';
import { makeFakeAstNode, makeNoopLanguageServices } from '../../../src/testing/index.js';

interface Model extends TransferElement {
   $type: string;
   [key: string]: unknown;
}

function makeService(rewrites: Record<string, UpdateRewriteContribution> = {}): DefaultUpdateRewriteService {
   // Per-language shape: the service reads only its tracer via `.shared` (the
   // no-op default) and its own `updateRewrite.rewrites` contribution group.
   return new DefaultUpdateRewriteService(makeNoopLanguageServices({ updateRewrite: { rewrites } }));
}

describe('UpdateRewriteService', () => {
   it('returns the model unchanged for an empty chain', async () => {
      const service = makeService();
      const model: Model = { $type: 'M' };
      expect(await service.apply(model, undefined)).toBe(model);
   });

   it('runs rewrites in priority order, ties by registration order', async () => {
      const service = makeService();
      const trail: string[] = [];
      service.register({ id: 'late', priority: 10, rewrite: model => (trail.push('late'), model) });
      service.register({ id: 'early', priority: -10, rewrite: model => (trail.push('early'), model) });
      service.register({ id: 'mid-a', rewrite: model => (trail.push('mid-a'), model) });
      service.register({ id: 'mid-b', rewrite: model => (trail.push('mid-b'), model) });
      await service.apply({ $type: 'M' }, undefined);
      expect(trail).toEqual(['early', 'mid-a', 'mid-b', 'late']);
   });

   it('threads the model through the chain', async () => {
      const service = makeService();
      service.register({ id: 'x', priority: 0, rewrite: model => ({ ...model, x: 1 }) });
      service.register({ id: 'y', priority: 1, rewrite: model => ({ ...model, y: (model as Model).x }) });
      const out = (await service.apply({ $type: 'M' }, undefined)) as Model;
      expect(out).toMatchObject({ x: 1, y: 1 });
   });

   it('passes the previous root through to each rewrite', async () => {
      const service = makeService();
      const previous = makeFakeAstNode<AstNode>({ $type: 'Root' });
      let seen: unknown = 'unset';
      service.register({ id: 'p', rewrite: (model, prev) => ((seen = prev), model) });
      await service.apply({ $type: 'M' }, previous);
      expect(seen).toBe(previous);
   });

   it('awaits async rewrites and keeps sync ones in order around them', async () => {
      const service = makeService();
      service.register({ id: 'sync-before', priority: 0, rewrite: model => ({ ...model, a: 1 }) });
      service.register({ id: 'async', priority: 1, rewrite: async model => ({ ...model, b: 2 }) });
      service.register({ id: 'sync-after', priority: 2, rewrite: model => ({ ...model, c: 3 }) });
      expect(await service.apply({ $type: 'M' }, undefined)).toMatchObject({ a: 1, b: 2, c: 3 });
   });

   it('reads its contribution group at construction', async () => {
      const contribution: UpdateRewriteContribution = {
         registerUpdateRewrites: registry => registry.register({ id: 'c', rewrite: model => ({ ...model, fromContribution: true }) })
      };
      const service = makeService({ mine: contribution });
      expect(await service.apply({ $type: 'M' }, undefined)).toMatchObject({ fromContribution: true });
   });

   it('unregisters a rewrite by id', async () => {
      const service = makeService();
      service.register({ id: 'drop-me', rewrite: model => ({ ...model, touched: true }) });
      expect(service.unregister('drop-me')).toBe(true);
      expect(await service.apply({ $type: 'M' }, undefined)).toEqual({ $type: 'M' });
   });

   it('aborts the chain when the cancellation token is already cancelled', async () => {
      const service = makeService();
      let ran = false;
      service.register({ id: 'should-not-run', rewrite: model => ((ran = true), model) });
      // Cancellation is Langium's `OperationCancelled` sentinel, and only that:
      // a `TypeError` from a broken chain aborts the same way and would satisfy a
      // bare `rejects.toThrow()` while proving nothing about cancellation.
      await expect(service.apply({ $type: 'M' }, undefined, CancellationToken.Cancelled)).rejects.toBe(OperationCancelled);
      expect(ran).toBe(false);
   });
});

describe('NormalizeEmptyStringsContribution', () => {
   function normalizedThrough(model: Model): Promise<Model> {
      const service = makeService({ normalize: new NormalizeEmptyStringsContribution() });
      return service.apply(model, undefined) as Promise<Model>;
   }

   it('drops empty-string keys, preserves $-/_-prefixed and refText, recurses objects', async () => {
      expect(
         await normalizedThrough({
            $type: 'M',
            keep: 'x',
            drop: '',
            _derived: '',
            ref: { $refText: '' },
            nested: { inner: '', keepInner: 'y' }
         } as Model)
      ).toEqual({
         $type: 'M',
         keep: 'x',
         _derived: '',
         ref: { $refText: '' },
         nested: { keepInner: 'y' }
      });
   });

   it('leaves primitive array elements untouched, recurses object elements', async () => {
      expect(await normalizedThrough({ $type: 'M', refs: ['a', '', 'b'], rows: [{ v: '' }] } as Model)).toEqual({
         $type: 'M',
         refs: ['a', '', 'b'],
         rows: [{}]
      });
   });

   it('is adaptable by overriding the normalize hook', async () => {
      class CustomContribution extends NormalizeEmptyStringsContribution {
         protected override normalize<T>(value: T): T {
            return { ...(value as Record<string, unknown>), marked: true } as T;
         }
      }
      const service = makeService({ normalize: new CustomContribution() });
      expect(await service.apply({ $type: 'M' }, undefined)).toMatchObject({ marked: true });
   });
});
