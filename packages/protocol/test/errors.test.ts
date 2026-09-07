/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, expect, it } from 'vitest';
import { ResponseError } from 'vscode-jsonrpc';
import { CONFLICT_ERROR_CODE, ConflictError, isConflictError } from '../src/errors';

describe('ConflictError', () => {
   it('exposes uri / expected / actual via getters backed by the data payload', () => {
      const error = new ConflictError('file:///A.fake', 3, 5);
      expect(error.uri).toBe('file:///A.fake');
      expect(error.expected).toBe(3);
      expect(error.actual).toBe(5);
   });

   it('carries the typed data payload on the JSON-RPC error envelope', () => {
      const error = new ConflictError('file:///A.fake', 3, 5);
      expect(error.data).toEqual({ uri: 'file:///A.fake', expected: 3, actual: 5 });
   });

   it('sets the application-specific JSON-RPC code', () => {
      const error = new ConflictError('file:///A.fake', 3, 5);
      expect(error.code).toBe(CONFLICT_ERROR_CODE);
   });

   it('builds a message that names the URI and both versions', () => {
      const error = new ConflictError('file:///A.fake', 3, 5);
      expect(error.message).toContain('file:///A.fake');
      expect(error.message).toContain('v3');
      expect(error.message).toContain('v5');
   });

   it('has name "ConflictError" so direct-throw detection works without instanceof', () => {
      const error = new ConflictError('file:///A.fake', 3, 5);
      expect(error.name).toBe('ConflictError');
   });

   it('is a ResponseError subclass — survives JSON-RPC reconstruction', () => {
      const error = new ConflictError('file:///A.fake', 3, 5);
      expect(error).toBeInstanceOf(ResponseError);
   });
});

describe('isConflictError', () => {
   it('returns true for a ConflictError instance (direct throw)', () => {
      expect(isConflictError(new ConflictError('file:///A.fake', 3, 5))).toBe(true);
   });

   it('returns true for any Error whose name is "ConflictError"', () => {
      const cloned = new Error('boom');
      cloned.name = 'ConflictError';
      expect(isConflictError(cloned)).toBe(true);
   });

   it('returns true for a generic ResponseError carrying the conflict code (post-RPC reconstruction)', () => {
      const reconstructed = new ResponseError(CONFLICT_ERROR_CODE, 'some transport-wrapped message', {
         uri: 'file:///A.fake',
         expected: 3,
         actual: 5
      });
      expect(isConflictError(reconstructed)).toBe(true);
   });

   it('returns true for a plain Error whose message contains the marker (message fallback)', () => {
      const wrapped = new Error('Request ns/save failed: Stale-based update for file:///A: expected v1, server is at v2');
      expect(isConflictError(wrapped)).toBe(true);
   });

   it('returns false for a plain Error', () => {
      expect(isConflictError(new Error('boom'))).toBe(false);
   });

   it('returns false for a ResponseError with a different code', () => {
      expect(isConflictError(new ResponseError(-32603, 'internal error'))).toBe(false);
   });

   it('returns false for non-Error values', () => {
      expect(isConflictError(undefined)).toBe(false);
      expect(isConflictError(null)).toBe(false);
      expect(isConflictError('ConflictError')).toBe(false);
      expect(isConflictError({ name: 'ConflictError' })).toBe(false);
   });
});
