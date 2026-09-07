/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, expect, it } from 'vitest';
import {
   isLocalTier,
   isProjectTier,
   isPublicFor,
   isPublicTier,
   isTieredDescription,
   isUniversalTier
} from '../../../src/langium/scope/scoped-ast-node-description.js';
import { makeFakeDescription } from '../../../src/testing/index.js';

describe('TieredAstNodeDescription', () => {
   describe('isTieredDescription', () => {
      it('returns true for a description carrying a tier field', () => {
         const description = makeFakeDescription('X', { tier: 'project' });
         expect(isTieredDescription(description)).toBe(true);
      });

      it('returns false for a plain Langium description', () => {
         const description = makeFakeDescription('X');
         expect(isTieredDescription(description)).toBe(false);
      });
   });

   describe('isLocalTier / isProjectTier / isPublicTier / isUniversalTier', () => {
      const local = makeFakeDescription('L', { tier: 'local' });
      const project = makeFakeDescription('P', { tier: 'project', projectId: 'dm1' });
      const publicTier = makeFakeDescription('Pu', { tier: 'public', projectId: 'dm1' });
      const universal = makeFakeDescription('U', { tier: 'universal' });
      const untagged = makeFakeDescription('X');

      it('isLocalTier matches only local-tier descriptions', () => {
         expect(isLocalTier(local)).toBe(true);
         expect(isLocalTier(project)).toBe(false);
         expect(isLocalTier(publicTier)).toBe(false);
         expect(isLocalTier(universal)).toBe(false);
         expect(isLocalTier(untagged)).toBe(false);
      });

      it('isProjectTier matches only project-tier descriptions', () => {
         expect(isProjectTier(local)).toBe(false);
         expect(isProjectTier(project)).toBe(true);
         expect(isProjectTier(publicTier)).toBe(false);
         expect(isProjectTier(universal)).toBe(false);
         expect(isProjectTier(untagged)).toBe(false);
      });

      it('isPublicTier matches only public-tier descriptions', () => {
         expect(isPublicTier(local)).toBe(false);
         expect(isPublicTier(project)).toBe(false);
         expect(isPublicTier(publicTier)).toBe(true);
         expect(isPublicTier(universal)).toBe(false);
         expect(isPublicTier(untagged)).toBe(false);
      });

      it('isUniversalTier matches only universal-tier descriptions', () => {
         expect(isUniversalTier(local)).toBe(false);
         expect(isUniversalTier(project)).toBe(false);
         expect(isUniversalTier(publicTier)).toBe(false);
         expect(isUniversalTier(universal)).toBe(true);
         expect(isUniversalTier(untagged)).toBe(false);
      });

      it('isProjectTier narrows projectId to non-nullable at the type level', () => {
         if (isProjectTier(project)) {
            const id: string = project.projectId;
            expect(id).toBe('dm1');
         }
      });

      it('isPublicTier narrows projectId to non-nullable at the type level', () => {
         if (isPublicTier(publicTier)) {
            const id: string = publicTier.projectId;
            expect(id).toBe('dm1');
         }
      });
   });

   describe('isPublicFor', () => {
      const publicDm1 = makeFakeDescription('G', { tier: 'public', projectId: 'dm1' });
      const publicDm2 = makeFakeDescription('G', { tier: 'public', projectId: 'dm2' });
      const project = makeFakeDescription('P', { tier: 'project', projectId: 'dm1' });
      const universal = makeFakeDescription('U', { tier: 'universal' });

      it('matches public-tier descriptions whose home is the given project', () => {
         expect(isPublicFor(publicDm1, 'dm1')).toBe(true);
      });

      it('rejects public-tier descriptions whose home is a different project', () => {
         expect(isPublicFor(publicDm2, 'dm1')).toBe(false);
      });

      it('rejects project-tier descriptions even when projectId matches', () => {
         expect(isPublicFor(project, 'dm1')).toBe(false);
      });

      it('rejects universal-tier descriptions (no projectId)', () => {
         expect(isPublicFor(universal, 'dm1')).toBe(false);
      });

      it('returns false when source projectId is undefined (no source project context)', () => {
         expect(isPublicFor(publicDm1, undefined)).toBe(false);
      });

      it('returns false for an undefined source even against a public-tier description lacking a projectId', () => {
         // Pins the `projectId !== undefined` guard specifically: with both the
         // source projectId and the description projectId undefined, the equality
         // check alone would pass, so only the guard keeps the result false.
         const publicNoProject = makeFakeDescription('G', { tier: 'public' });
         expect(isPublicFor(publicNoProject, undefined)).toBe(false);
      });
   });
});
