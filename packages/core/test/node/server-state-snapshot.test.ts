/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { performance } from 'node:perf_hooks';
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';
import { formatServerState } from '../../src/node/server-state-snapshot.js';

describe('formatServerState', () => {
   let nowSpy: MockInstance<typeof performance.now>;
   let cpuSpy: MockInstance<typeof process.cpuUsage>;
   let eluSpy: MockInstance<typeof performance.eventLoopUtilization>;

   beforeEach(() => {
      nowSpy = vi.spyOn(performance, 'now');
      cpuSpy = vi.spyOn(process, 'cpuUsage');
      eluSpy = vi.spyOn(performance, 'eventLoopUtilization');
   });
   afterEach(() => {
      nowSpy.mockRestore();
      cpuSpy.mockRestore();
      eluSpy.mockRestore();
   });

   it('reports cumulative-since-start on the first call, then since-last-snapshot deltas', () => {
      // The delta sample is module-level and never reset, so this must stay the
      // first formatServerState call in the file: with no prior sample, cpu/loop
      // are reported as cumulative rather than as a delta.
      nowSpy.mockReturnValue(1000);
      cpuSpy.mockReturnValue({ user: 0, system: 0 });
      eluSpy.mockReturnValue({ idle: 0, active: 0, utilization: 0 });
      const first = formatServerState();
      expect(first).toContain('cumulative since process start');
      expect(first).not.toContain('since last snapshot');

      // Second call: +200ms wall, +100ms user CPU (values are microseconds), 150ms active / 50ms idle loop.
      nowSpy.mockReturnValue(1200);
      cpuSpy.mockReturnValue({ user: 100_000, system: 0 });
      eluSpy.mockReturnValue({ idle: 50, active: 150, utilization: 0.75 });
      const second = formatServerState();
      expect(second).toContain('user 100ms, system 0ms in last 200ms (50%)'); // (100+0)/200 = 50%
      expect(second).toContain('utilization 75% (active 150ms / idle 50ms since last snapshot)'); // 150/(150+50)
   });

   it('omits the open-documents section when no list is passed', () => {
      nowSpy.mockReturnValue(1000);
      cpuSpy.mockReturnValue({ user: 0, system: 0 });
      eluSpy.mockReturnValue({ idle: 0, active: 0, utilization: 0 });
      expect(formatServerState()).not.toContain('held by a client');
   });

   it('lists each open document with the client ids holding it', () => {
      nowSpy.mockReturnValue(1000);
      cpuSpy.mockReturnValue({ user: 0, system: 0 });
      eluSpy.mockReturnValue({ idle: 0, active: 0, utilization: 0 });
      const snapshot = formatServerState(undefined, undefined, {
         openDocuments: [
            { uri: 'file:///a.x', clients: ['language-client'] },
            { uri: 'file:///x.other', clients: ['form-editor', 'language-client'] }
         ]
      });
      expect(snapshot).toContain('open      2 document(s) held by a client');
      expect(snapshot).toContain('file:///a.x [language-client]');
      expect(snapshot).toContain('file:///x.other [form-editor, language-client]');
   });

   it('renders an empty open-documents list as a zero count (still emitted — absence of pins is signal)', () => {
      nowSpy.mockReturnValue(1000);
      cpuSpy.mockReturnValue({ user: 0, system: 0 });
      eluSpy.mockReturnValue({ idle: 0, active: 0, utilization: 0 });
      expect(formatServerState(undefined, undefined, { openDocuments: [] })).toContain('open      0 document(s) held by a client');
   });

   it('caps the per-document list at the default and reports the elided remainder', () => {
      nowSpy.mockReturnValue(1000);
      cpuSpy.mockReturnValue({ user: 0, system: 0 });
      eluSpy.mockReturnValue({ idle: 0, active: 0, utilization: 0 });
      const openDocuments = Array.from({ length: 30 }, (_, index) => ({ uri: `file:///doc-${index}.x`, clients: ['language-client'] }));
      const snapshot = formatServerState(undefined, undefined, { openDocuments });
      expect(snapshot).toContain('open      30 document(s)');
      expect(snapshot).toContain('file:///doc-24.x'); // last entry listed under DEFAULT_OPEN_DOCUMENTS_LIST_CAP
      expect(snapshot).not.toContain('file:///doc-25.x'); // first elided entry
      expect(snapshot).toContain('… and 5 more');
   });

   it('honours a caller-provided openDocumentsListCap', () => {
      nowSpy.mockReturnValue(1000);
      cpuSpy.mockReturnValue({ user: 0, system: 0 });
      eluSpy.mockReturnValue({ idle: 0, active: 0, utilization: 0 });
      const openDocuments = Array.from({ length: 4 }, (_, index) => ({ uri: `file:///doc-${index}.x`, clients: ['language-client'] }));
      const snapshot = formatServerState(undefined, undefined, { openDocuments, openDocumentsListCap: 2 });
      expect(snapshot).toContain('file:///doc-1.x');
      expect(snapshot).not.toContain('file:///doc-2.x');
      expect(snapshot).toContain('… and 2 more');
   });
});
