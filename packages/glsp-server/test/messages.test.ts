/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { collectMessages } from '@hydranium/protocol';
import { describe, expect, it } from 'vitest';
import * as messages from '../src/messages/index.js';

/**
 * The ONLY enforcement of the `hydranium/<unscoped-package>/<name>` convention.
 * Lint cannot see a key's shape, and declaring messages per-package means
 * nothing else checks uniqueness or the prefix — a copy-pasted declaration could
 * otherwise claim another package's namespace and no gate would notice.
 */
describe('the glsp-server message barrel', () => {
   const declarations = collectMessages(messages);
   const codes = declarations.map(declaration => declaration.code);

   it('enumerates every declaration the package raises', () => {
      expect(codes.length).toBeGreaterThan(0);
   });

   it('prefixes every code with this package', () => {
      expect(codes.filter(code => !code.startsWith('hydranium/glsp-server/'))).toEqual([]);
   });

   it('has no duplicate code', () => {
      expect(new Set(codes).size).toBe(codes.length);
   });

   it('has no code that is a prefix of another', () => {
      // Hard-required rather than insurance: a host catalogue is nested JSON and
      // errors outright when one key is a prefix of another.
      const prefixed = codes.filter(code => codes.some(other => other !== code && other.startsWith(code)));
      expect(prefixed).toEqual([]);
   });

   it('gives every declaration a non-empty English default', () => {
      expect(declarations.filter(declaration => declaration.text.trim() === '')).toEqual([]);
   });
});
