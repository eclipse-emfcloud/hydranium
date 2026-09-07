/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, expect, it } from 'vitest';
import { bindRpcMethods } from '../../src/rpc/bind-rpc-methods';
import { createRpcProxy } from '../../src/rpc/create-rpc-proxy';
import { assertValidMethodNamespace } from '../../src/rpc/wire-prefix';
import { makeDuplexConnectionPair } from '../../src/testing/node';

describe('assertValidMethodNamespace', () => {
   it('accepts the empty string (no-prefix mode)', () => {
      expect(() => assertValidMethodNamespace('', 'caller')).not.toThrow();
   });

   it('accepts strings ending with `/`', () => {
      expect(() => assertValidMethodNamespace('ns/', 'caller')).not.toThrow();
      expect(() => assertValidMethodNamespace('data-server/', 'caller')).not.toThrow();
      expect(() => assertValidMethodNamespace('a/b/', 'caller')).not.toThrow();
      expect(() => assertValidMethodNamespace('/', 'caller')).not.toThrow();
   });

   it('throws TypeError on missing trailing slash with a message naming the caller', () => {
      expect(() => assertValidMethodNamespace('ns', 'createRpcProxy')).toThrow(TypeError);
      expect(() => assertValidMethodNamespace('ns', 'createRpcProxy')).toThrow(/createRpcProxy/);
      expect(() => assertValidMethodNamespace('ns', 'createRpcProxy')).toThrow(/must end with '\/'/);
   });

   it('error message points at the fix (suggests the slashed form)', () => {
      try {
         assertValidMethodNamespace('foo', 'bindRpcMethods');
         throw new Error('expected TypeError');
      } catch (error) {
         const message = (error as Error).message;
         expect(message).toContain("'foo/'");
         expect(message).toContain('empty string');
      }
   });

   it('rejects values ending in non-slash separators (`.`, `:`, `-`)', () => {
      expect(() => assertValidMethodNamespace('ns.', 'caller')).toThrow(TypeError);
      expect(() => assertValidMethodNamespace('ns:', 'caller')).toThrow(TypeError);
      expect(() => assertValidMethodNamespace('ns-', 'caller')).toThrow(TypeError);
   });
});

describe('bindRpcMethods — methodNamespace validation', () => {
   it('throws at construction time when methodNamespace lacks a trailing slash', () => {
      const pair = makeDuplexConnectionPair();
      try {
         const target = { ping: async () => 'pong' };
         expect(() => bindRpcMethods(pair.left, target, ['ping'], { methodNamespace: 'ns' })).toThrow(/bindRpcMethods.*must end with '\//);
      } finally {
         pair.dispose();
      }
   });

   it('accepts the slashed form unchanged', () => {
      const pair = makeDuplexConnectionPair();
      try {
         const target = { ping: async () => 'pong' };
         expect(() => bindRpcMethods(pair.left, target, ['ping'], { methodNamespace: 'ns/' })).not.toThrow();
      } finally {
         pair.dispose();
      }
   });
});

describe('createRpcProxy — methodNamespace validation', () => {
   it('throws at construction time when methodNamespace lacks a trailing slash', () => {
      const pair = makeDuplexConnectionPair();
      try {
         expect(() => createRpcProxy(pair.right, { methodNamespace: 'ns' })).toThrow(/createRpcProxy.*must end with '\//);
      } finally {
         pair.dispose();
      }
   });

   it('accepts the slashed form unchanged', () => {
      const pair = makeDuplexConnectionPair();
      try {
         expect(() => createRpcProxy(pair.right, { methodNamespace: 'ns/' })).not.toThrow();
      } finally {
         pair.dispose();
      }
   });
});
