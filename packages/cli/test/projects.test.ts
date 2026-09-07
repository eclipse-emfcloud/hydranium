/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * Unit tests for the `projects` subcommand — bypass the subprocess spawn via
 * `__proxyForTest` and drive the subcommand against a stub proxy. A separate
 * tier spawns a real child and exercises real stdio.
 */

import { describe, expect, it } from 'vitest';
import type { DataServerProtocol } from '@hydranium/protocol/data';
import { runProjects } from '../src/commands/projects.js';

interface FakeRoot {
   readonly $type: 'FakeRoot';
}

function makeStubProxy(
   projects: ReadonlyArray<{ id: string; referenceName: string; version?: string; dependencies?: readonly string[] }>
): DataServerProtocol<FakeRoot> {
   return {
      openModelDocument: () => Promise.reject(new Error('not exercised')),
      closeModelDocument: () => Promise.reject(new Error('not exercised')),
      getModelDocument: () => Promise.reject(new Error('not exercised')),
      updateModelDocument: () => Promise.reject(new Error('not exercised')),
      saveModelDocument: () => Promise.reject(new Error('not exercised')),
      watchModelDocument: () => Promise.reject(new Error('not exercised')),
      unwatchModelDocument: () => Promise.reject(new Error('not exercised')),
      getProjects: () => Promise.resolve(projects),
      getProjectForUri: () => Promise.reject(new Error('not exercised')),
      waitForReady: () => Promise.reject(new Error('not exercised'))
   };
}

describe('runProjects', () => {
   it('writes one JSON object per project, newline-terminated', async () => {
      const written: string[] = [];
      await runProjects({
         serverCommand: 'unused',
         write: line => written.push(line),
         __proxyForTest: makeStubProxy([
            { id: 'p1', referenceName: 'p1', version: '1.0.0' },
            { id: 'p2', referenceName: 'p2', dependencies: ['p1'] }
         ])
      });
      expect(written).toEqual([
         `${JSON.stringify({ id: 'p1', referenceName: 'p1', version: '1.0.0' })}\n`,
         `${JSON.stringify({ id: 'p2', referenceName: 'p2', dependencies: ['p1'] })}\n`
      ]);
   });

   it('writes nothing for an empty project list (no header, no trailing newline)', async () => {
      const written: string[] = [];
      await runProjects({
         serverCommand: 'unused',
         write: line => written.push(line),
         __proxyForTest: makeStubProxy([])
      });
      expect(written).toEqual([]);
   });
});
