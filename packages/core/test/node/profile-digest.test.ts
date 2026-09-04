/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, expect, it } from 'vitest';
import { digestAllocationProfile, digestCpuProfile, type AllocationProfile, type CpuProfile } from '../../src/node/profile-digest.js';

describe('digestCpuProfile (pure)', () => {
   const profile: CpuProfile = {
      nodes: [
         { id: 1, callFrame: { functionName: '(root)', url: '', lineNumber: -1 } },
         { id: 2, callFrame: { functionName: 'hot', url: '/a/b/hot.js', lineNumber: 10 } },
         { id: 3, callFrame: { functionName: 'cool', url: '/a/b/cool.js', lineNumber: 20 } }
      ],
      samples: [2, 2, 2, 3],
      timeDeltas: [1000, 1000, 1000, 1000]
   };

   it('ranks functions by self-time with percentages, hottest first', () => {
      const digest = digestCpuProfile(profile);
      expect(digest).toContain('hot');
      expect(digest).toContain('cool');
      expect(digest.indexOf('hot')).toBeLessThan(digest.indexOf('cool'));
      expect(digest).toContain('75.0%');
      expect(digest).toContain('3.0ms');
   });

   it('aggregates self-time across nodes that share a call frame', () => {
      const recursive: CpuProfile = {
         nodes: [
            { id: 1, callFrame: { functionName: 'loop', url: '/x.js', lineNumber: 1 } },
            { id: 2, callFrame: { functionName: 'loop', url: '/x.js', lineNumber: 1 } }
         ],
         samples: [1, 2],
         timeDeltas: [2000, 3000]
      };
      const digest = digestCpuProfile(recursive);
      expect(digest).toContain('of 1 functions');
      expect(digest).toContain('5.0ms');
   });

   it('limits to the requested top-N', () => {
      const many: CpuProfile = {
         nodes: Array.from({ length: 5 }, (_value, index) => ({
            id: index + 1,
            callFrame: { functionName: `fn${index}`, url: '/m.js', lineNumber: index }
         })),
         samples: [1, 2, 3, 4, 5],
         timeDeltas: [1000, 1000, 1000, 1000, 1000]
      };
      const digest = digestCpuProfile(many, { topN: 2 });
      expect(digest).toContain('top 2 of 5 functions');
      expect(digest.trim().split('\n')).toHaveLength(3); // header + 2 rows
   });

   it('does not throw on an empty profile', () => {
      const empty: CpuProfile = {
         nodes: [{ id: 1, callFrame: { functionName: '(root)', url: '', lineNumber: 0 } }],
         samples: [],
         timeDeltas: []
      };
      expect(() => digestCpuProfile(empty)).not.toThrow();
      expect(digestCpuProfile(empty)).toContain('0.0ms');
   });
});

describe('digestAllocationProfile (pure)', () => {
   const profile: AllocationProfile = {
      head: {
         callFrame: { functionName: '(root)', url: '', lineNumber: 0 },
         selfSize: 0,
         children: [
            { callFrame: { functionName: 'allocBig', url: '/a/big.js', lineNumber: 5 }, selfSize: 3000, children: [] },
            { callFrame: { functionName: 'allocSmall', url: '/a/small.js', lineNumber: 7 }, selfSize: 1000, children: [] }
         ]
      }
   };

   it('ranks functions by self-size with percentages, largest first', () => {
      const digest = digestAllocationProfile(profile);
      expect(digest.indexOf('allocBig')).toBeLessThan(digest.indexOf('allocSmall'));
      expect(digest).toContain('75.0%');
   });

   it('walks the allocation tree, summing nested self-size by frame', () => {
      const nested: AllocationProfile = {
         head: {
            callFrame: { functionName: '(root)', url: '', lineNumber: 0 },
            selfSize: 0,
            children: [
               {
                  callFrame: { functionName: 'outer', url: '/o.js', lineNumber: 1 },
                  selfSize: 100,
                  children: [{ callFrame: { functionName: 'inner', url: '/i.js', lineNumber: 2 }, selfSize: 900, children: [] }]
               }
            ]
         }
      };
      const digest = digestAllocationProfile(nested);
      expect(digest).toContain('outer');
      expect(digest).toContain('inner');
      expect(digest.indexOf('inner')).toBeLessThan(digest.indexOf('outer')); // 900 > 100
   });

   it('does not throw on a head with no allocations', () => {
      const empty: AllocationProfile = {
         head: { callFrame: { functionName: '(root)', url: '', lineNumber: 0 }, selfSize: 0, children: [] }
      };
      expect(() => digestAllocationProfile(empty)).not.toThrow();
   });
});
