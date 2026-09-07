/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { type Tracer } from '@hydranium/protocol';
import { URI, UriUtils } from '@hydranium/langium';
import { NodeFileSystemProvider } from '@hydranium/langium/node';
import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import * as fsp from 'node:fs/promises';
import { type WritableFileSystemProvider } from '../documents/ast-document-manager.js';
import { type SelfSaveRegistry } from '../documents/self-save-registry.js';
import { type LogNameOptions } from '../langium/diagnostics/logger.js';
import { serverSharedFactory, type ServerSharedServicesMinimal } from '../langium/shared-services.js';
import { serveVirtualDocument } from '../langium/workspace/virtual-document.js';

/**
 * Node-based default {@link WritableFileSystemProvider}. Extends Langium's
 * {@link NodeFileSystemProvider} with an async {@link writeFile} that
 * creates parent directories on demand, replaces the target indivisibly unless
 * that would break a hard link, and registers the resulting mtime with the
 * {@link SelfSaveRegistry} bound at `services.workspace.SelfSaveRegistry` — so
 * consumers can suppress the `didChangeWatchedFiles` echo for their own writes.
 *
 * Server-only (`@hydranium/core/node`): pulls `node:fs`. The portable `.`
 * entry binds `DefaultEmptyFileSystemProvider` by default, so a Node host
 * must rebind this slot — through `context.fileSystemProvider` or directly — to
 * get real disk I/O.
 */
export class DefaultFileSystemProvider extends NodeFileSystemProvider implements WritableFileSystemProvider {
   readonly selfSaveRegistry: SelfSaveRegistry;
   protected readonly tracer: Tracer;

   constructor(
      protected readonly services: ServerSharedServicesMinimal,
      options: LogNameOptions = {}
   ) {
      super();
      this.selfSaveRegistry = services.workspace.SelfSaveRegistry;
      this.tracer = services.Tracer.for(options.logName ?? this.constructor.name).trace('instantiated');
   }

   // Serve virtual documents from the registered document before touching disk
   // (a virtual URI has no `fsPath` backing); delegate everything else to Node.
   override readFile(uri: URI): Promise<string> {
      const served = serveVirtualDocument(this.services, uri);
      return served !== undefined ? Promise.resolve(served) : super.readFile(uri);
   }

   override readFileSync(uri: URI): string {
      return serveVirtualDocument(this.services, uri) ?? super.readFileSync(uri);
   }

   /**
    * Write `content` to `uri` via a staging file and a `rename` — or, onto a
    * destination carrying more than one hard link, in place — then register the
    * resulting mtime with the {@link SelfSaveRegistry}.
    *
    * The rename is what makes the replacement indivisible: a concurrent reader
    * observes either the previous complete file or the new one. An in-place
    * overwrite cannot offer that, because the target is truncated before the
    * first byte lands, so a reader in that window gets a short or empty file —
    * and a model file that fails to parse is worse than one holding a previous
    * good revision. It does NOT serialise writers: two writers still race, and
    * the loser's content is replaced wholesale rather than interleaved.
    *
    * The destination is the RESOLVED path, via {@link realpath}: a `rename`
    * onto a symlink replaces the link itself with a regular file and leaves the
    * file it pointed at holding the previous revision, where an in-place write
    * would have followed the link. A URI that resolves to nothing is the create
    * case and stages beside its own path — which includes a DANGLING link,
    * matching {@link realpath}, whose `undefined` there is the same "absent"
    * answer the document-identity policy acts on.
    *
    * Three constraints on the staging file. It is a sibling of the RESOLVED
    * DESTINATION and not of `uri` — `rename` is only indivisible within one
    * filesystem, and a link can point across one. Its name carries the pid and
    * a random component, so two writers cannot select the same path and destroy
    * each other's staging copy. And it ends in a suffix no grammar claims, so a
    * workspace scan crossing the window cannot mistake it for a document.
    *
    * Replacing a file carries its permission bits over, and the staging file is
    * created no wider than them so the pending content is never briefly more
    * readable than what it replaces. Ownership, extended attributes and ACLs are
    * NOT carried over, so a target relying on any of them must not be written
    * through here: an owner cannot be restored by a process that does not own
    * it, and Node exposes no API to read the other two, so copying them would
    * mean shelling out.
    *
    * A destination with more than one hard link is written IN PLACE instead,
    * keeping the inode. Renaming over such a path gives it a NEW inode, so
    * every other name silently keeps the previous revision — the same stale-read
    * outcome the staging file exists to prevent, and it happens on every write
    * rather than only under contention. Keeping the inode preserves all its
    * names, plus the mode, owner, extended attributes and ACLs that hang off it,
    * for free; what it gives up is indivisibility, so that one write CAN be read
    * torn by a concurrent reader. Breaking a link is certain where tearing is
    * only possible, which is what settles the trade.
    */
   async writeFile(uri: URI, content: string): Promise<void> {
      await fsp.mkdir(UriUtils.dirname(uri).fsPath, { recursive: true });
      const destination = this.realpath(uri)?.fsPath ?? uri.fsPath;
      const replaced = await replacedFile(destination);
      if (replaced !== undefined && replaced.links > 1) {
         // Keeping the inode is the only way this write reaches the other names.
         await fsp.writeFile(destination, content);
      } else {
         const staging = `${destination}.${process.pid}.${randomUUID()}.tmp`;
         try {
            const mode = replaced?.mode;
            await fsp.writeFile(staging, content, { mode });
            if (mode !== undefined) {
               // `open` masks its mode argument with the umask, so the create
               // above can only under-permit; an explicit chmod is what makes
               // the carried mode exact.
               await fsp.chmod(staging, mode);
            }
            await renameOverOpenReaders(staging, destination);
         } catch (err: unknown) {
            // A failed write must not leave the staging file behind for the next
            // workspace scan or a later `--force` cleanup to trip over.
            await fsp.rm(staging, { force: true });
            throw err;
         }
      }
      const mtimeMs = await this.mtimeMs(uri);
      if (mtimeMs !== undefined) {
         this.selfSaveRegistry.register(uri.fsPath, mtimeMs);
      }
   }

   async mtimeMs(uri: URI): Promise<number | undefined> {
      try {
         const stat = await fsp.stat(uri.fsPath);
         return stat.mtimeMs;
      } catch {
         // Missing file / stat failure — caller treats as "unknown".
         return undefined;
      }
   }

   /**
    * Real on-disk identity of `uri` via `fs.realpathSync` — symlinks collapsed,
    * `..`/`.` walked, case-folded on case-insensitive filesystems. A non-`file:`
    * URI cannot be statted, so it passes through unchanged (treated as present).
    * A resolution failure (missing / unreadable) returns `undefined` — the
    * filesystem's "absent" signal the document-identity policy depends on.
    *
    * Uncached on purpose: `realpathSync` is a syscall, but the kernel caches the
    * dentry/inode lookups it walks, so repeated resolution of a live path is
    * cheap. A userspace cache would add a staleness hazard (a re-pointed symlink
    * resolving to its old target with no invalidation) for no measured gain.
    */
   realpath(uri: URI): URI | undefined {
      if (uri.scheme !== 'file') {
         return uri;
      }
      try {
         return URI.file(realpathSync(uri.fsPath));
      } catch {
         return undefined;
      }
   }
}

/**
 * What a write has to know about the regular file at `path` before replacing
 * it: the permission bits to carry over, and how many names share its inode.
 * Both come off one stat, so neither costs a syscall the other does not.
 */
interface ReplacedFile {
   /** Permission bits, masked to the mode a `chmod` takes. */
   readonly mode: number;
   /** `nlink` — above 1, a rename would strand every other name. */
   readonly links: number;
}

/**
 * Facts about the regular file `path` replaces, or `undefined` when there is
 * nothing to replace — the path is absent (a create, which takes the process
 * default mode and has no other name), or is not a regular file (a directory,
 * where the write is about to fail anyway).
 */
async function replacedFile(path: string): Promise<ReplacedFile | undefined> {
   try {
      const stat = await fsp.stat(path);
      return stat.isFile() ? { mode: stat.mode & 0o777, links: stat.nlink } : undefined;
   } catch {
      return undefined;
   }
}

/**
 * Errno values a rename reports on Windows when another handle holds the
 * destination open. POSIX renames are unaffected by open handles, so this
 * cannot fire there and the retry below costs nothing.
 */
const RENAME_CONTENTION_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);

/**
 * `rename` the staged content over `destination`, retrying while Windows
 * reports the destination as held open.
 *
 * The staging file exists so a reader never sees a half-written file, and on
 * Windows the very presence of that reader is what makes the replacing rename
 * fail — so the indivisible write breaks under exactly the contention it was
 * built for, and it breaks intermittently, which is worse than never working.
 * A reader's handle is released in milliseconds, so waiting turns a spurious
 * failure into a slightly later success.
 *
 * BOUNDED, not open-ended: a genuine permission fault raises the same errno and
 * is distinguishable from contention only by never clearing, so an unbounded
 * wait would convert a hard error into a hang. Exhausting the budget rethrows
 * the last failure, leaving the caller's cleanup and error contract unchanged.
 */
async function renameOverOpenReaders(staging: string, destination: string): Promise<void> {
   const deadline = Date.now() + 2_000;
   for (let attempt = 0; ; attempt++) {
      try {
         await fsp.rename(staging, destination);
         return;
      } catch (err: unknown) {
         const code = err instanceof Error && 'code' in err ? String((err as NodeJS.ErrnoException).code) : undefined;
         if (code === undefined || !RENAME_CONTENTION_CODES.has(code) || Date.now() >= deadline) {
            throw err;
         }
         // Backs off to keep a long contention window from spinning, capped so
         // a late attempt still lands promptly once the handle is released.
         await new Promise(resolve => setTimeout(resolve, Math.min(2 ** attempt, 50)));
      }
   }
}

/**
 * Module fragment that binds the writable Node {@link DefaultFileSystemProvider},
 * spread into the services context on a Node host.
 *
 * The framework counterpart to Langium's `NodeFileSystem` (`langium/node`): same
 * role, but supplies the *writable* provider (`writeFile` + `mtimeMs`) the
 * framework slot requires. Langium's fragment cannot stand in for it — its
 * provider carries no `writeFile`, so the slot silently falls back to
 * `DefaultEmptyFileSystemProvider` and the host gets no-op writes and a
 * throwing `readFile` instead of disk access.
 */
export const NodeFileSystem = {
   fileSystemProvider: serverSharedFactory(services => new DefaultFileSystemProvider(services))
};
