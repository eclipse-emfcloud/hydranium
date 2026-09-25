/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

// Theia's real file service pulls DOM globals unavailable under Vitest's node
// environment, so the base class is a stand-in recording what reaches its
// `update`, which runs Theia's modified-since check.
const theia = vi.hoisted(() => ({
   /** The arguments of each call that reached the base `update`. */
   delegated: [] as unknown[][]
}));

vi.mock('@theia/filesystem/lib/browser/file-service', () => ({
   FileService: class FileService {
      async update(...args: unknown[]): Promise<{ encoding: string }> {
         theia.delegated.push(args);
         return { encoding: 'utf8' };
      }
   }
}));

import URI from '@theia/core/lib/common/uri';
import { ETAG_DISABLED } from '@theia/filesystem/lib/common/files';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HydraniumFileService } from '../../src/browser/hydranium-file-service';

const FILE = new URI('file:///workspace/a.domain');
const CHANGES = [{ text: 'XY' }];
/** What an editor's save passes: the version it last read. */
const READ = { mtime: 1_000, etag: 'read', readEncoding: 'utf8' };

describe('HydraniumFileService.update', () => {
   beforeEach(() => {
      theia.delegated.length = 0;
   });

   it("hands Theia's check an etag no file can match, so the mtime alone decides", async () => {
      await new HydraniumFileService().update(FILE, CHANGES, READ);

      expect(theia.delegated).toHaveLength(1);
      const [resource, changes, options] = theia.delegated[0];
      expect([resource, changes]).toEqual([FILE, CHANGES]);
      expect(options).toEqual({ ...READ, etag: expect.any(String) });
      // Theia's etag is the mtime and the size in lower-case base 29 and 31.
      expect((options as typeof READ).etag).not.toMatch(/^[0-9a-z]*$/);
   });

   it('passes a save that disables the check on as it is, as Theia does', async () => {
      const overwrite = { ...READ, etag: ETAG_DISABLED };

      await new HydraniumFileService().update(FILE, CHANGES, overwrite);

      expect(theia.delegated).toEqual([[FILE, CHANGES, overwrite]]);
   });
});
