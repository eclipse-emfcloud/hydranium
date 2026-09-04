/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, expect, it } from 'vitest';
import { ModelReadyTimeoutError } from '../src/state/model-ready-timeout-error.js';

describe('ModelReadyTimeoutError', () => {
   it('builds a message with uri, state, and elapsed', () => {
      const err = new ModelReadyTimeoutError('file:///a.a', 'IndexedReferences', 60000);
      expect(err.message).toBe("Timed out after 60000ms waiting for state 'IndexedReferences' on file:///a.a.");
      expect(err.name).toBe('ModelReadyTimeoutError');
   });

   it('appends a non-empty diagnostic with a leading space', () => {
      const err = new ModelReadyTimeoutError('file:///a.a', 'IndexedReferences', 60000, 'rebuild=12 phase=Linked');
      expect(err.message).toBe("Timed out after 60000ms waiting for state 'IndexedReferences' on file:///a.a. rebuild=12 phase=Linked");
   });

   it('omits the trailing space when diagnostic is empty', () => {
      const err = new ModelReadyTimeoutError('file:///a.a', 'Validated', 60000, '');
      expect(err.message).toBe("Timed out after 60000ms waiting for state 'Validated' on file:///a.a.");
   });

   it('preserves the fields for instanceof-based recovery', () => {
      const err = new ModelReadyTimeoutError('file:///x', 'Linked', 1234, 'snap');
      expect(err).toBeInstanceOf(ModelReadyTimeoutError);
      expect(err).toBeInstanceOf(Error);
      expect(err.uri).toBe('file:///x');
      expect(err.targetState).toBe('Linked');
      expect(err.elapsedMs).toBe(1234);
      expect(err.diagnostic).toBe('snap');
   });
});
