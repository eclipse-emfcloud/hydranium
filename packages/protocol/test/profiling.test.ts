/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, expect, it } from 'vitest';
import { PROFILING_SCHEMA_VERSION, type ProfilingArtifact, type ProfilingEnvironment, type ProfilingManifest } from '../src/profiling';

/*
 * The manifest schema lives in `protocol` (not the Node-only `ProfilingRun`) so a
 * Playwright-side assembler can build the bundle index without a `node`-only
 * dependency chain.
 */
describe('ProfilingManifest schema', () => {
   it('exposes the schema version as a shared constant', () => {
      expect(PROFILING_SCHEMA_VERSION).toBe(1);
   });

   it('types a manifest a Playwright-side assembler can construct', () => {
      const artifact: ProfilingArtifact = { kind: 'browser-runtime', path: 'browser-runtime.json' };
      const environment: ProfilingEnvironment = { mode: 'app', container: false, node: process.version, windows: [] };
      const manifest: ProfilingManifest = {
         schemaVersion: PROFILING_SCHEMA_VERSION,
         sessionId: 'e2e-session',
         environment,
         artifacts: [artifact]
      };
      expect(manifest.artifacts[0].kind).toBe('browser-runtime');
      expect(manifest.environment.mode).toBe('app');
   });
});
