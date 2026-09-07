/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { type Clock } from '@hydranium/protocol';
import { isCaseInsensitiveFileSystem } from '../util/environment.js';
import { type ServerSharedServicesMinimal } from '../langium/shared-services.js';

/** Default eligibility window for a self-save entry. */
const DEFAULT_TTL_MS = 30_000;

export interface SelfSaveRegistryOptions {
   /** How long a self-save entry stays eligible to match a watcher event. Default {@link DEFAULT_TTL_MS}. */
   ttlMs?: number;
}

/**
 * Tracks `mtime` of files written by the server itself so the echo
 * `didChangeWatchedFiles` event from the OS file watcher can be suppressed,
 * avoiding redundant rebuilds after each save. Entries are matched by mtime
 * (not by a time window) and expire after a TTL.
 */
export class SelfSaveRegistry {
   protected readonly entries = new Map<string, { mtimeMs: number; registeredAt: number }>();
   /**
    * Read time through the shared {@link Clock} rather than `Date.now()`: the
    * TTL gates whether an incoming watcher event still counts as a self-save
    * echo, so tests advance a fake clock to exercise expiry without a real
    * wait. Wall-clock `now()` is correct here — entries are compared against a
    * file's `mtime`.
    */
   protected readonly clock: Clock;
   protected readonly ttlMs: number;

   constructor(services: Pick<ServerSharedServicesMinimal, 'Clock'>, options: SelfSaveRegistryOptions = {}) {
      this.clock = services.Clock;
      this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
   }

   /**
    * Key a path the way the host filesystem compares it.
    *
    * Registering and matching happen on different paths for the same file: the
    * write path comes from the server, the echo from the OS watcher, and on a
    * case-insensitive filesystem those two can disagree in case for one file.
    * A raw key then misses the suppression and the server's own write is
    * rebuilt as a foreign change.
    *
    * Folded ONLY where the filesystem folds. On Linux two paths differing in
    * case are two files, and collapsing them would suppress a real change to
    * the other one — a correctness bug traded for an optimisation.
    */
   protected key(fsPath: string): string {
      return isCaseInsensitiveFileSystem() ? fsPath.toLowerCase() : fsPath;
   }

   /** Record a self-write. Key by `fsPath` (not URI string) to avoid URI-form mismatches. */
   register(fsPath: string, mtimeMs: number): void {
      this.entries.set(this.key(fsPath), { mtimeMs, registeredAt: this.clock.now() });
   }

   /** True if `mtimeMs` matches a recent self-write. Evicts stale entries. Not consumed on match. */
   matches(fsPath: string, mtimeMs: number): boolean {
      const key = this.key(fsPath);
      const entry = this.entries.get(key);
      if (!entry) {
         return false;
      }
      if (this.clock.now() - entry.registeredAt > this.ttlMs) {
         this.entries.delete(key);
         return false;
      }
      // Accept mtime equality (some filesystems have 1-second precision).
      return entry.mtimeMs === mtimeMs;
   }
}
