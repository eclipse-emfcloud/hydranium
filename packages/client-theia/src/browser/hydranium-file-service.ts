/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import type URI from '@theia/core/lib/common/uri';
import { injectable } from '@theia/core/shared/inversify';
import { FileService, type UpdateTextFileOptions } from '@theia/filesystem/lib/browser/file-service';
import { ETAG_DISABLED } from '@theia/filesystem/lib/common/files';

/**
 * Theia's `FileService`, refusing an incremental save once the file has
 * changed since the editor read it.
 *
 * Theia's own check, which `write` and `update` share, passes a file whose
 * mtime moved on when its size still matches the etag the editor read. That
 * is safe for `write`, which replaces the file with the whole text, but
 * `update` applies the editor's pending edits to the file as it is, so after a
 * same-size change, the server saving those very edits included, it applies
 * them a second time. Here `update` hands that check the etag with a `!`
 * appended, which no file's etag can match: Theia writes an etag as the mtime
 * in base 29 followed by the size in base 31, digits and lower-case letters
 * only. An advanced mtime is then enough for Theia to refuse with its
 * `FILE_MODIFIED_SINCE`. The editor's save then falls back to `write` with the
 * whole text, which Theia checks as before: it writes when the size is
 * unchanged, and asks the user otherwise. A same-size change by another
 * process is therefore overwritten by that write rather than merged with the
 * editor's edits. `write` is left as it is.
 *
 * It is the safety net behind `EditorDiskSync`, which acts only when the
 * file holds the editor's buffer: a file holding some of the edits, as when a
 * save participant ordered ahead of Theia's first one edits before its first
 * await, is left to this check.
 *
 * A write within the file system's mtime resolution of the read goes unseen,
 * as it does for Theia's own check. A file whose mtime moves while its text
 * stays the same costs a whole-text write rather than the edits.
 *
 * Bound by `bindEditorDiskSync`.
 */
@injectable()
export class HydraniumFileService extends FileService {
   override update(
      resource: URI,
      changes: Parameters<FileService['update']>[1],
      options: UpdateTextFileOptions
   ): ReturnType<FileService['update']> {
      const strict =
         typeof options.etag === 'string' && options.etag !== ETAG_DISABLED ? { ...options, etag: `${options.etag}!` } : options;
      return super.update(resource, changes, strict);
   }
}
