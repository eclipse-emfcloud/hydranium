/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { expectTypeOf, it } from 'vitest';
import { type ProjectScopeIndex } from '../../../src/index.js';

it('ProjectScopeIndex exposes readonly shared collections', () => {
   expectTypeOf<ProjectScopeIndex['own']>().toEqualTypeOf<ReadonlyMap<string, readonly number[]>>();
   expectTypeOf<ProjectScopeIndex['dependencies']>().toEqualTypeOf<ReadonlyMap<string, readonly number[]>>();
   expectTypeOf<ProjectScopeIndex['universal']>().toEqualTypeOf<readonly number[]>();
   const refuseMutation = (index: ProjectScopeIndex): void => {
      // @ts-expect-error Shared ownership buckets cannot be replaced.
      index.own.set('project', []);
      // @ts-expect-error Shared dependency buckets cannot be replaced.
      index.dependencies.set('project', []);
      // @ts-expect-error Shared positions cannot be appended.
      index.own.get('project')?.push(0);
      // @ts-expect-error Shared universal positions cannot be appended.
      index.universal.push(0);
      // @ts-expect-error The shared description list cannot be appended.
      index.descriptions.push(index.descriptions[0]);
   };
   void refuseMutation;
});
