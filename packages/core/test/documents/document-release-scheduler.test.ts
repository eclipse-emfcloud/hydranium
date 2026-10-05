/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { type CanonicalUri } from '@hydranium/protocol';
import { makeFakeClock } from '@hydranium/protocol/testing';
import { describe, expect, it } from 'vitest';
import { DefaultDocumentReleaseScheduler } from '../../src/documents/document-release-scheduler.js';

const KEY = 'file:///a.x' as CanonicalUri;

describe('DefaultDocumentReleaseScheduler', () => {
   it('releases at once with no grace', () => {
      const scheduler = new DefaultDocumentReleaseScheduler(makeFakeClock(), 0);
      let released = 0;
      scheduler.defer(KEY, () => released++);
      expect(released).toBe(1);
      expect(scheduler.isDeferred(KEY)).toBe(false);
   });

   it('releases once the grace has passed', () => {
      const clock = makeFakeClock();
      const scheduler = new DefaultDocumentReleaseScheduler(clock, 100);
      let released = 0;
      scheduler.defer(KEY, () => released++);
      expect(scheduler.isDeferred(KEY)).toBe(true);
      clock.advance(99);
      expect(released).toBe(0);
      clock.advance(1);
      expect(released).toBe(1);
      expect(scheduler.isDeferred(KEY)).toBe(false);
   });

   it('replaces a deferral of the same document rather than running both', () => {
      const clock = makeFakeClock();
      const scheduler = new DefaultDocumentReleaseScheduler(clock, 100);
      let released = 0;
      scheduler.defer(KEY, () => released++);
      scheduler.defer(KEY, () => released++);
      clock.advance(100);
      expect(released).toBe(1);
   });

   it('keeps the text for a client lost within its grace, and never releases', () => {
      const clock = makeFakeClock();
      const scheduler = new DefaultDocumentReleaseScheduler(clock, 100);
      let released = 0;
      scheduler.recordLoss(KEY, 'lost');
      scheduler.defer(KEY, () => released++);
      clock.advance(50);
      expect(scheduler.resolveOpen(KEY, 'lost')).toBe('keep');
      clock.advance(100);
      expect(released).toBe(0);
      expect(clock.pendingTimers()).toBe(0);
   });

   it('has any other opener release first', () => {
      const scheduler = new DefaultDocumentReleaseScheduler(makeFakeClock(), 100);
      scheduler.recordLoss(KEY, 'lost');
      scheduler.defer(KEY, () => undefined);
      expect(scheduler.resolveOpen(KEY, 'other')).toBe('release');
      expect(scheduler.isDeferred(KEY)).toBe(false);
   });

   it('treats a lost client returning after its own grace as any other', () => {
      const clock = makeFakeClock();
      const scheduler = new DefaultDocumentReleaseScheduler(clock, 100);
      scheduler.recordLoss(KEY, 'early');
      clock.advance(80);
      scheduler.recordLoss(KEY, 'late');
      scheduler.defer(KEY, () => undefined);
      clock.advance(30);
      expect(scheduler.resolveOpen(KEY, 'early')).toBe('release');
   });

   it('answers none with nothing deferred, and drops what clearLosses and cancel end', () => {
      const clock = makeFakeClock();
      const scheduler = new DefaultDocumentReleaseScheduler(clock, 100);
      expect(scheduler.resolveOpen(KEY, 'any')).toBe('none');
      let released = 0;
      scheduler.recordLoss(KEY, 'lost');
      scheduler.clearLosses(KEY);
      scheduler.defer(KEY, () => released++);
      expect(scheduler.resolveOpen(KEY, 'lost')).toBe('release');
      scheduler.defer(KEY, () => released++);
      scheduler.cancel(KEY);
      clock.advance(200);
      expect(released).toBe(0);
   });
});
