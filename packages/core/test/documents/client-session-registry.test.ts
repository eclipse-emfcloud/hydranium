/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { type CanonicalUri, LANGUAGE_CLIENT_ID, REVERT_ON_CLOSE_CLIENT_ID, UNKNOWN_CLIENT_ID } from '@hydranium/protocol';
import { describe, expect, it } from 'vitest';
import { DuplicateClientIdError, SessionClosedError } from '../../src/documents/client-session-errors.js';
import { ClientSessionRegistry, type ClientSessionClosedEvent } from '../../src/documents/client-session-registry.js';
import { INTEGRITY_CLIENT_ID } from '../../src/langium/integrity/integrity-rule.js';

const A = 'file:///a.x' as CanonicalUri;
const B = 'file:///b.x' as CanonicalUri;

describe('ClientSessionRegistry — the session table', () => {
   it('rejects an id that is already registered', () => {
      const registry = new ClientSessionRegistry();
      registry.register('form#1');

      expect(() => registry.register('form#1')).toThrow(DuplicateClientIdError);
      expect(registry.isRegistered('form#1')).toBe(true);
   });

   it('rejects an id a client already has documents open under', () => {
      const registry = new ClientSessionRegistry();
      registry.addOpen(A, 'wire-1');

      expect(() => registry.register('wire-1')).toThrow(DuplicateClientIdError);
      expect(registry.isRegistered('wire-1')).toBe(false);
   });

   it.each([LANGUAGE_CLIENT_ID, UNKNOWN_CLIENT_ID, REVERT_ON_CLOSE_CLIENT_ID, INTEGRITY_CLIENT_ID])(
      'rejects the framework id %s',
      reserved => {
         const registry = new ClientSessionRegistry();

         expect(() => registry.register(reserved)).toThrow(DuplicateClientIdError);
         expect(registry.isRegistered(reserved)).toBe(false);
      }
   );

   it('frees an id whose opens have all closed', () => {
      const registry = new ClientSessionRegistry();
      registry.addOpen(A, 'c');
      registry.removeOpen(A, 'c');

      expect(() => registry.register('c')).not.toThrow();
   });

   it('keeps the id taken while the session closes, and frees it once unregistered', () => {
      const registry = new ClientSessionRegistry();
      registry.register('s');
      registry.beginClose('s');

      expect(() => registry.register('s')).toThrow(DuplicateClientIdError);

      registry.unregister('s');
      expect(() => registry.register('s')).not.toThrow();
   });

   it('announces an unregistered session once', () => {
      const registry = new ClientSessionRegistry();
      const closed: ClientSessionClosedEvent[] = [];
      registry.onDidCloseSession(event => closed.push(event));
      registry.register('s');

      registry.unregister('s');
      registry.unregister('s');

      expect(closed).toEqual([{ clientId: 's' }]);
   });
});

describe('ClientSessionRegistry — opens', () => {
   it('tracks opens in both directions, for registered and unregistered ids alike', () => {
      const registry = new ClientSessionRegistry();
      registry.register('session');

      registry.addOpen(A, 'session');
      registry.addOpen(B, 'session');
      registry.addOpen(A, 'legacy');

      expect(registry.clientsOf(A)).toEqual(['session', 'legacy']);
      expect(registry.opensOf('session')).toEqual([A, B]);
      expect(registry.opensOf('legacy')).toEqual([A]);
      expect(registry.isRegistered('legacy')).toBe(false);
   });

   it('treats a repeat open as a no-op that one close ends', () => {
      const registry = new ClientSessionRegistry();

      expect(registry.addOpen(A, 'c')).toBe(true);
      expect(registry.addOpen(A, 'c')).toBe(false);
      expect(registry.removeOpen(A, 'c')).toBe(true);

      expect(registry.isOpenIn(A, 'c')).toBe(false);
      expect(registry.isOpen(A)).toBe(false);
   });

   it('refuses an open for a session that is closing', () => {
      const registry = new ClientSessionRegistry();
      registry.register('s');
      registry.beginClose('s');

      expect(() => registry.addOpen(A, 's')).toThrow(SessionClosedError);
      expect(registry.isOpen(A)).toBe(false);
   });
});
