/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { DocumentState } from '@hydranium/langium';
import { describe, expect, it } from 'vitest';
import { type AstExtension, AstExtensionPhase } from '../../src/langium/ast-extension/ast-extension-service.js';
import { type BuildPhasePass, BuildPassPhase } from '../../src/langium/build-phase-pass/build-phase-pass.js';

describe('AstExtensionPhase', () => {
   it('rejects a phase the pipeline never notifies at compile time', () => {
      const extension: AstExtension = {
         id: 'changed',
         nodeFilter: (node): node is never => node === undefined,
         // @ts-expect-error `Changed` has no AST yet, so no listener is wired for it
         phase: DocumentState.Changed,
         compute: () => undefined
      };
      expect(AstExtensionPhase.all()).not.toContain(extension.phase);
   });

   it('all() leaves out Changed, which has no AST, and IndexedContent, which per document adds nothing to Parsed', () => {
      expect(AstExtensionPhase.all()).not.toContain(DocumentState.Changed);
      expect(AstExtensionPhase.all()).not.toContain(DocumentState.IndexedContent);
      expect(AstExtensionPhase.all()).toContain(DocumentState.Parsed);
   });
});

describe('BuildPassPhase', () => {
   it('rejects a phase the pipeline never notifies at compile time', () => {
      const pass: BuildPhasePass = {
         id: 'changed',
         // @ts-expect-error `Changed` has no AST yet, so no listener is wired for it
         phase: DocumentState.Changed,
         run: () => undefined
      };
      expect(BuildPassPhase.all()).not.toContain(pass.phase);
   });

   it('all() keeps IndexedContent, where the global index is whole, and leaves out Changed', () => {
      expect(BuildPassPhase.all()).not.toContain(DocumentState.Changed);
      expect(BuildPassPhase.all()).toContain(DocumentState.IndexedContent);
      expect(BuildPassPhase.all()).toContain(DocumentState.Parsed);
   });
});
