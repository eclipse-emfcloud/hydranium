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
import { DefaultSelfSaveRegistry } from '../../../src/langium/workspace/self-save-registry.js';

/**
 * Exposes the entry map's size. Eviction has no public observable —
 * `isRegistered` recomputes the expiry comparison, so it answers `false` for a
 * retained stale entry exactly as it does for a deleted one.
 */
class ProbeRegistry extends DefaultSelfSaveRegistry {
   get entryCount(): number {
      return this.entries.size;
   }
}

describe('DefaultSelfSaveRegistry', () => {
   it('matches a self-write with the same mtime within the TTL', () => {
      const clock = makeFakeClock();
      const registry = new DefaultSelfSaveRegistry({ Clock: clock }, { ttlMs: 1000 });
      registry.register('/a.a', 1000);

      clock.advance(999);
      expect(registry.isRegistered('/a.a', 1000)).toBe(true);
   });

   it('expires an entry once the TTL elapses', () => {
      const clock = makeFakeClock();
      const registry = new DefaultSelfSaveRegistry({ Clock: clock }, { ttlMs: 1000 });
      registry.register('/a.a', 1000);

      clock.advance(1001);
      expect(registry.isRegistered('/a.a', 1000)).toBe(false);
   });

   it('drops an expired entry on the next register, including one nothing queried', () => {
      const clock = makeFakeClock();
      const registry = new ProbeRegistry({ Clock: clock }, { ttlMs: 1000 });
      registry.register('/stale.a', 1000);
      expect(registry.entryCount).toBe(1);

      clock.advance(1001);
      // A write to a DIFFERENT path. `/stale.a` is never queried, so an
      // eviction driven from the query path could not reach it — which is the
      // unbounded-growth hole this closes, not merely where the delete lives.
      registry.register('/fresh.a', 2000);

      // The map size, not a second `isRegistered` call: the expiry branch
      // recomputes the TTL comparison on every call, so `false` is produced
      // whether or not the delete ran.
      expect(registry.entryCount).toBe(1);
      expect(registry.isRegistered('/fresh.a', 2000)).toBe(true);
   });

   it('leaves the registry untouched when a query finds an expired entry', () => {
      const clock = makeFakeClock();
      const registry = new ProbeRegistry({ Clock: clock }, { ttlMs: 1000 });
      registry.register('/a.a', 1000);

      clock.advance(1001);
      expect(registry.isRegistered('/a.a', 1000)).toBe(false);
      // The query is a query. Retaining the entry is the observable that
      // separates this from the previous implementation, which deleted here.
      expect(registry.entryCount).toBe(1);
   });

   it('treats an entry aged exactly to the TTL as still eligible', () => {
      const clock = makeFakeClock();
      const registry = new DefaultSelfSaveRegistry({ Clock: clock }, { ttlMs: 1000 });
      registry.register('/a.a', 1000);

      // Separates the strict `>` from `>=`, which would expire it here.
      clock.advance(1000);
      expect(registry.isRegistered('/a.a', 1000)).toBe(true);
   });

   it('ages an entry by elapsed time, whichever way the wall clock jumps', () => {
      const clock = makeFakeClock();
      const registry = new DefaultSelfSaveRegistry({ Clock: clock }, { ttlMs: 1000 });
      registry.register('/a.a', 1000);
      registry.register('/b.a', 2000);

      clock.jumpWallClock(3_600_000);
      expect(registry.isRegistered('/a.a', 1000)).toBe(true);

      clock.jumpWallClock(-7_200_000);
      clock.advance(1001);
      expect(registry.isRegistered('/b.a', 2000)).toBe(false);
   });

   it('does not match a different mtime (a foreign write to the same path)', () => {
      const clock = makeFakeClock();
      const registry = new DefaultSelfSaveRegistry({ Clock: clock });
      registry.register('/a.a', 1000);

      expect(registry.isRegistered('/a.a', 2000)).toBe(false);
   });

   it('does not match an unknown path', () => {
      expect(new DefaultSelfSaveRegistry({ Clock: makeFakeClock() }).isRegistered('/missing.a', 1000)).toBe(false);
   });

   it('defaults the TTL to 30s when no option is given', () => {
      const clock = makeFakeClock();
      const registry = new DefaultSelfSaveRegistry({ Clock: clock });
      registry.register('/a.a', 1000);

      clock.advance(29_999);
      expect(registry.isRegistered('/a.a', 1000)).toBe(true);
      clock.advance(2);
      expect(registry.isRegistered('/a.a', 1000)).toBe(false);
   });
});

describe('DefaultSelfSaveRegistry path casing', () => {
   const realPlatform = process.platform;
   const asPlatform = (platform: string): void => {
      Object.defineProperty(process, 'platform', { value: platform, configurable: true });
   };
   afterEach(() => asPlatform(realPlatform));

   it('suppresses the echo when the watcher reports a different casing, on a case-insensitive host', () => {
      asPlatform('win32');
      const registry = new DefaultSelfSaveRegistry({ Clock: makeFakeClock() });
      registry.register('C:\\Work\\Model.a', 1000);
      expect(registry.isRegistered('c:\\work\\model.a', 1000)).toBe(true);
   });

   it('keeps two casings distinct on a case-sensitive host, where they are two files', () => {
      asPlatform('linux');
      const registry = new DefaultSelfSaveRegistry({ Clock: makeFakeClock() });
      registry.register('/work/Model.a', 1000);
      expect(registry.isRegistered('/work/model.a', 1000)).toBe(false);
      // The registered spelling still matches, so the guard has not simply
      // disabled suppression.
      expect(registry.isRegistered('/work/Model.a', 1000)).toBe(true);
   });
});
