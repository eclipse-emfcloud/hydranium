/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, expect, it } from 'vitest';
import { ReferenceContext, ReferenceRequest } from '../src/model-server';

describe('ReferenceContext.builder', () => {
   it('builds a context anchored at a document source, no synthetic path', () => {
      const context = ReferenceContext.builder().document('memory://a.a').property('child').build();
      expect(context).toEqual({ source: { uri: 'memory://a.a' }, property: 'child' });
      expect('syntheticPath' in context).toBe(false);
   });

   it('threads chained steps into syntheticPath in call order', () => {
      const context = ReferenceContext.builder()
         .element('Diagram1')
         .step('nodes', 'NodeOne')
         .step('parts', 'PartOne')
         .property('ref')
         .build();
      expect(context).toEqual({
         source: { name: 'Diagram1', type: undefined },
         property: 'ref',
         syntheticPath: [
            { containerProperty: 'nodes', type: 'NodeOne' },
            { containerProperty: 'parts', type: 'PartOne' }
         ]
      });
   });

   it('carries the element source type when given', () => {
      const context = ReferenceContext.builder().element('Diagram1', 'Diagram').property('ref').build();
      expect(context.source).toEqual({ name: 'Diagram1', type: 'Diagram' });
   });
});

describe('ReferenceContext.builder is persistent', () => {
   it('lets one stage serve as a prefix for two independent branches', () => {
      const prefix = ReferenceContext.builder().document('memory://a.a').step('nodes', 'NodeOne');
      const left = prefix.step('left', 'LeftOne').property('ref').build();
      const right = prefix.step('right', 'RightOne').property('ref').build();
      expect(left.syntheticPath).toEqual([
         { containerProperty: 'nodes', type: 'NodeOne' },
         { containerProperty: 'left', type: 'LeftOne' }
      ]);
      expect(right.syntheticPath).toEqual([
         { containerProperty: 'nodes', type: 'NodeOne' },
         { containerProperty: 'right', type: 'RightOne' }
      ]);
   });

   it('does not alias the path across two contexts built from one stage', () => {
      const stage = ReferenceContext.builder().document('memory://a.a').step('nodes', 'NodeOne');
      const first = stage.property('ref').build();
      const second = stage.property('other').build();
      expect(first.syntheticPath).not.toBe(second.syntheticPath);
      // A later step off the same stage must leave both built contexts alone.
      stage.step('parts', 'PartOne').property('ref').build();
      expect(first.syntheticPath).toHaveLength(1);
      expect(second.syntheticPath).toHaveLength(1);
   });
});

describe('ReferenceRequest.builder', () => {
   it('extends the context with the mandatory value', () => {
      const request = ReferenceRequest.builder().synthetic('memory://new.a', 'TypeOne').property('part').value('ValueOne').build();
      expect(request).toEqual({
         source: { uri: 'memory://new.a', type: 'TypeOne' },
         property: 'part',
         value: 'ValueOne'
      });
   });

   it('keeps the synthetic path when resolving a nested source', () => {
      const request = ReferenceRequest.builder()
         .document('memory://a.a')
         .step('links', 'LinkOne')
         .property('source')
         .value('ns.Element')
         .build();
      expect(request.syntheticPath).toEqual([{ containerProperty: 'links', type: 'LinkOne' }]);
      expect(request.value).toBe('ns.Element');
   });

   it('promotes a context to a request via from(context, candidate)', () => {
      const context = ReferenceContext.builder().document('memory://a.a').step('links', 'LinkOne').property('source').build();
      const candidate = { uri: 'memory://b.a', type: 'PartOne', label: 'ns.Element', value: 'ns.Element' };
      const request = ReferenceRequest.from(context, candidate);
      expect(request).toEqual({
         source: { uri: 'memory://a.a' },
         property: 'source',
         syntheticPath: [{ containerProperty: 'links', type: 'LinkOne' }],
         value: 'ns.Element'
      });
   });

   it('rejects step() after property() at the type level', () => {
      // Compile-only: the closure is never invoked, so the illegal chain never
      // runs at runtime — the `@ts-expect-error` asserts the staging at build.
      const illegal = (): unknown =>
         // @ts-expect-error — `step` is not available on the post-property stage.
         ReferenceContext.builder().document('memory://a.a').property('child').step('x', 'Y');
      expect(typeof illegal).toBe('function');
   });
});
