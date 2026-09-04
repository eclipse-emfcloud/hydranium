/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { URI, UriUtils } from '@hydranium/langium';
import { describe, expect, it } from 'vitest';

describe('UriUtils.toUri', () => {
   it('parses a string argument into a URI', () => {
      const result = UriUtils.toUri('file:///workspace/A.a');
      expect(URI.isUri(result)).toBe(true);
      expect(result.scheme).toBe('file');
      expect(result.path).toBe('/workspace/A.a');
   });

   it('returns an existing URI argument unchanged (identity, not re-parsed)', () => {
      const uri = URI.parse('file:///workspace/B.a');
      // Mutant `return true ? URI.parse(value) : value` would call
      // `URI.parse(uri)` on a URI object, which is not the same reference.
      expect(UriUtils.toUri(uri)).toBe(uri);
   });
});

describe('UriUtils.isAncestorOrEqual', () => {
   it('returns false when schemes differ even if paths match', () => {
      const ancestor = URI.parse('file:///workspace/proj');
      const descendant = URI.parse('memory:///workspace/proj');
      expect(UriUtils.isAncestorOrEqual(ancestor, descendant)).toBe(false);
   });

   it('returns false when authorities differ even if scheme and path match', () => {
      const ancestor = URI.parse('file://hostA/workspace/proj');
      const descendant = URI.parse('file://hostB/workspace/proj');
      expect(UriUtils.isAncestorOrEqual(ancestor, descendant)).toBe(false);
   });

   it('returns true when scheme and authority match for a real descendant (proves it is not an unconditional false)', () => {
      const ancestor = URI.parse('file:///workspace/proj');
      const descendant = URI.parse('file:///workspace/proj/sub/Child.a');
      expect(UriUtils.isAncestorOrEqual(ancestor, descendant)).toBe(true);
   });

   it('returns true for identical URIs (equal-path branch)', () => {
      const uri = URI.parse('file:///workspace/proj/A.a');
      expect(UriUtils.isAncestorOrEqual(uri, URI.parse('file:///workspace/proj/A.a'))).toBe(true);
   });

   it('returns false for an unrelated sibling sharing a name prefix (no path-separator boundary)', () => {
      // `/workspace/proj` must NOT be considered an ancestor of
      // `/workspace/proj-other` — the boundary check appends a separator so
      // a bare `startsWith` on the raw path does not match. A mutant that
      // drops the `+ '/'` boundary (prefix = ancestorPath) would wrongly
      // return true here.
      const ancestor = URI.parse('file:///workspace/proj');
      const descendant = URI.parse('file:///workspace/proj-other/A.a');
      expect(UriUtils.isAncestorOrEqual(ancestor, descendant)).toBe(false);
   });

   it('matches a descendant under an ancestor whose path already ends with a slash (trailing-slash branch)', () => {
      // ancestorPath ends with '/', so `trailing` is true and the prefix is
      // used as-is (no extra separator appended). A mutant forcing
      // `trailing = false` would append '/' producing '...proj//' which the
      // descendant path does not start with -> would wrongly return false.
      const ancestor = URI.parse('file:///workspace/proj/');
      const descendant = URI.parse('file:///workspace/proj/sub/A.a');
      expect(UriUtils.isAncestorOrEqual(ancestor, descendant)).toBe(true);
   });

   it('returns false for a non-descendant under a different folder', () => {
      const ancestor = URI.parse('file:///workspace/projA');
      const descendant = URI.parse('file:///workspace/projB/A.a');
      expect(UriUtils.isAncestorOrEqual(ancestor, descendant)).toBe(false);
   });
});
