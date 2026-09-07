/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { snapshotFilePath } from '../../src/node/process-memory.js';

describe('snapshotFilePath', () => {
   it('composes the origin-first prefix, sanitized label and extension (no timestamp) in the given directory', () => {
      const dir = os.tmpdir();
      const result = snapshotFilePath(dir, 'my label', 'server-cpu', 'cpuprofile');
      expect(path.dirname(result)).toBe(dir);
      expect(path.basename(result)).toBe('server-cpu-my_label.cpuprofile');
   });

   it('yields the bare prefix stem (kind = filename stem) when the label is empty', () => {
      const result = snapshotFilePath(os.tmpdir(), '', 'server-cpu', 'cpuprofile');
      expect(path.basename(result)).toBe('server-cpu.cpuprofile');
   });

   it('falls back to the OS temp dir when the directory does not exist', () => {
      const result = snapshotFilePath(path.join(os.tmpdir(), 'no-such-dir-xyz-123'), 'x', 'server-heap', 'heapsnapshot');
      expect(path.dirname(result)).toBe(os.tmpdir());
   });

   it('falls back to the OS temp dir when the directory is undefined', () => {
      const result = snapshotFilePath(undefined, 'x', 'server-heap', 'heapsnapshot');
      expect(path.dirname(result)).toBe(os.tmpdir());
   });

   it('sanitizes non-word characters and truncates the label to 40 chars', () => {
      const result = snapshotFilePath(os.tmpdir(), 'a/b c:d '.repeat(20), 'server-alloc', 'heapprofile');
      const match = path.basename(result).match(/^server-alloc-(.+)\.heapprofile$/);
      expect(match).not.toBeNull();
      const label = match![1];
      expect(label.length).toBeLessThanOrEqual(40);
      expect(label).toMatch(/^[\w.-]+$/);
   });
});
