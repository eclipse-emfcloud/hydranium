/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * The invariant this package exists for, asserted rather than assumed.
 *
 * The whole point of the exact Langium pin and of routing every import through
 * this package is that there is ONE physical copy of Langium in the graph. Given
 * one copy, re-export is transparent: a symbol reached through
 * `@hydranium/langium` and the same symbol reached through `langium` are the
 * same object, and identity-sensitive checks (`instanceof` on an AST node, on a
 * `URI`) hold across the boundary.
 *
 * Two copies break that silently. Nothing throws; `instanceof` simply starts
 * answering `false`, and a scope lookup or a URI comparison quietly stops
 * matching. That failure mode is why the assertion belongs in a test rather
 * than in a comment — and why this package had none was that the invariant
 * looked too obvious to check.
 *
 * Importing `langium` directly is banned repo-wide by an eslint rule and
 * deliberately exempted here: comparing the two import paths is the one thing
 * that cannot be done through the chokepoint alone.
 */

/* eslint-disable @typescript-eslint/no-restricted-imports */
import { AstUtils as DirectAstUtils, URI as DirectURI, UriUtils as DirectUriUtils } from 'langium';
/* eslint-enable @typescript-eslint/no-restricted-imports */
import { describe, expect, it } from 'vitest';
import { AstUtils, URI, UriUtils } from '../src/index.js';

describe('@hydranium/langium chokepoint', () => {
   it('re-exports the same class object as a direct langium import', () => {
      // Object identity, not structural equality: a second physical copy would
      // pass any `toEqual` and fail this.
      expect(URI).toBe(DirectURI);
      expect(AstUtils).toBe(DirectAstUtils);
   });

   it('keeps instanceof working across the two import paths', () => {
      const throughChokepoint = URI.parse('file:///a/b.x');
      const throughDirect = DirectURI.parse('file:///a/b.x');

      expect(throughChokepoint instanceof DirectURI).toBe(true);
      expect(throughDirect instanceof URI).toBe(true);
   });

   it('augments the shared UriUtils object rather than shadowing it', () => {
      // The augmentation mutates the one runtime object, so a direct importer
      // that never loaded this package still sees the added helpers once
      // anything has. If these ever diverge, the augmentation has started
      // producing a copy and every consumer gets a different `UriUtils`.
      expect(UriUtils).toBe(DirectUriUtils);
      expect(typeof UriUtils.toUri).toBe('function');
      expect(typeof UriUtils.isAncestorOrEqual).toBe('function');
   });

   it('normalises a string and a URI to the same URI through toUri', () => {
      expect(UriUtils.toUri('file:///a/b.x').toString()).toBe(UriUtils.toUri(URI.parse('file:///a/b.x')).toString());
   });

   it('treats a path as its own ancestor but not as an ancestor of a sibling', () => {
      const root = URI.parse('file:///a');
      expect(UriUtils.isAncestorOrEqual(root, URI.parse('file:///a'))).toBe(true);
      expect(UriUtils.isAncestorOrEqual(root, URI.parse('file:///a/b.x'))).toBe(true);
      expect(UriUtils.isAncestorOrEqual(root, URI.parse('file:///ab/c.x'))).toBe(false);
   });
});
