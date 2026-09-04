/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { makeFakeClock } from '@hydranium/protocol/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { SelfSaveRegistry } from '../../src/documents/self-save-registry.js';

/**
 * Exposes the entry map's size. Eviction has no public observable — `matches`
 * recomputes the expiry comparison, so it answers `false` for a retained stale
 * entry exactly as it does for a deleted one.
 */
class ProbeRegistry extends SelfSaveRegistry {
   get entryCount(): number {
      return this.entries.size;
   }
}

describe('SelfSaveRegistry', () => {
   it('matches a self-write with the same mtime within the TTL', () => {
      const clock = makeFakeClock();
      const registry = new SelfSaveRegistry({ Clock: clock }, { ttlMs: 1000 });
      registry.register('/a.a', 1000);

      clock.advance(999);
      expect(registry.matches('/a.a', 1000)).toBe(true);
   });

   it('expires an entry once the TTL elapses', () => {
      const clock = makeFakeClock();
      const registry = new SelfSaveRegistry({ Clock: clock }, { ttlMs: 1000 });
      registry.register('/a.a', 1000);

      clock.advance(1001);
      expect(registry.matches('/a.a', 1000)).toBe(false);
   });

   it('evicts the expired entry rather than only reporting no match', () => {
      const clock = makeFakeClock();
      const registry = new ProbeRegistry({ Clock: clock }, { ttlMs: 1000 });
      registry.register('/a.a', 1000);
      expect(registry.entryCount).toBe(1);

      clock.advance(1001);
      expect(registry.matches('/a.a', 1000)).toBe(false);
      // The map size, not a second `matches` call: the expiry branch recomputes
      // the TTL comparison on every call, so a second `false` is produced whether
      // or not the delete ran. Only the entry count separates eviction — the
      // unbounded-growth guard — from expiry.
      expect(registry.entryCount).toBe(0);
   });

   it('treats an entry aged exactly to the TTL as still eligible (boundary, non-zero registeredAt)', () => {
      const clock = makeFakeClock();
      // Register at a non-zero base time so registeredAt > 0: this distinguishes
      // the `now - registeredAt` subtraction from a `now + registeredAt` mutant,
      // and exercising the exact boundary distinguishes `>` from `>=`.
      clock.advance(100);
      const registry = new SelfSaveRegistry({ Clock: clock }, { ttlMs: 1000 });
      registry.register('/a.a', 1000); // registeredAt = 100

      clock.advance(1000); // now = 1100; age = 1100 - 100 = 1000 === ttlMs
      // `now - registeredAt > ttlMs` -> `1000 > 1000` -> false -> NOT expired -> matches.
      // `>=` mutant: `1000 >= 1000` -> true -> expired -> would NOT match.
      // `+` mutant: `1100 + 100 = 1200 > 1000` -> true -> expired -> would NOT match.
      expect(registry.matches('/a.a', 1000)).toBe(true);
   });

   it('does not match a different mtime (a foreign write to the same path)', () => {
      const clock = makeFakeClock();
      const registry = new SelfSaveRegistry({ Clock: clock });
      registry.register('/a.a', 1000);

      expect(registry.matches('/a.a', 2000)).toBe(false);
   });

   it('does not match an unknown path', () => {
      expect(new SelfSaveRegistry({ Clock: makeFakeClock() }).matches('/missing.a', 1000)).toBe(false);
   });

   it('defaults the TTL to 30s when no option is given', () => {
      const clock = makeFakeClock();
      const registry = new SelfSaveRegistry({ Clock: clock });
      registry.register('/a.a', 1000);

      clock.advance(29_999);
      expect(registry.matches('/a.a', 1000)).toBe(true);
      clock.advance(2);
      expect(registry.matches('/a.a', 1000)).toBe(false);
   });
});

describe('path casing', () => {
   const realPlatform = process.platform;
   const asPlatform = (platform: string): void => {
      Object.defineProperty(process, 'platform', { value: platform, configurable: true });
   };
   afterEach(() => asPlatform(realPlatform));

   it('suppresses the echo when the watcher reports a different casing, on a case-insensitive host', () => {
      asPlatform('win32');
      const registry = new SelfSaveRegistry({ Clock: makeFakeClock() });
      registry.register('C:\\Work\\Model.a', 1000);
      expect(registry.matches('c:\\work\\model.a', 1000)).toBe(true);
   });

   it('keeps two casings distinct on a case-sensitive host, where they are two files', () => {
      asPlatform('linux');
      const registry = new SelfSaveRegistry({ Clock: makeFakeClock() });
      registry.register('/work/Model.a', 1000);
      expect(registry.matches('/work/model.a', 1000)).toBe(false);
      // The registered spelling still matches, so the guard has not simply
      // disabled suppression.
      expect(registry.matches('/work/Model.a', 1000)).toBe(true);
   });
});
