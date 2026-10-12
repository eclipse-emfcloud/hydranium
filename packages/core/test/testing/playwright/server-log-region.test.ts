/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readServerLogRegion } from '../../../src/testing/playwright/server-log-region.js';

describe('readServerLogRegion', () => {
   let dir: string;
   beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'server-log-region-'));
   });
   afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
   });

   it('reads from where the previous read stopped, so each line is read once', () => {
      const file = join(dir, 'a.log');
      writeFileSync(file, '[Info  - 10:00:00.000] started\n');
      expect(readServerLogRegion(file)).toBe('[Info  - 10:00:00.000] started\n');

      appendFileSync(file, '[Warn  - 10:00:00.001] declined\n');
      expect(readServerLogRegion(file)).toBe('[Warn  - 10:00:00.001] declined\n');
   });

   it('leaves a line still being written to the next read', () => {
      const file = join(dir, 'a.log');
      writeFileSync(file, '[Info  - 10:00:00.000] started\n[Warn  - 10:00');
      expect(readServerLogRegion(file)).toBe('[Info  - 10:00:00.000] started\n');

      appendFileSync(file, ':00.001] declined\n');
      expect(readServerLogRegion(file)).toBe('[Warn  - 10:00:00.001] declined\n');
   });

   it('reads nothing from a log that does not exist', () => {
      expect(readServerLogRegion(join(dir, 'missing.log'))).toBe('');
   });
});
