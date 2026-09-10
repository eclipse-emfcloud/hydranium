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
 * avoiding redundant rebuilds after each save.
 */
export interface SelfSaveRegistry {
   /**
    * Record a self-write, and drop any registration already past its TTL.
    *
    * Keyed by `fsPath` rather than URI string, because the two sides of a
    * suppression see different URI forms for one file.
    */
   register(fsPath: string, mtimeMs: number): void;

   /**
    * Whether `fsPath` carries a live registration at exactly `mtimeMs`.
    *
    * A registration expires after the TTL, so a write recorded longer ago than
    * that answers `false` — the caller's decision holds only while the echo it
    * suppresses could still be in flight. A query never mutates the registry.
    */
   isRegistered(fsPath: string, mtimeMs: number): boolean;
}

/**
 * Compares entries by mtime rather than by a time window, so the echo of a
 * save whose content is unchanged is still recognised.
 */
export class DefaultSelfSaveRegistry implements SelfSaveRegistry {
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

   register(fsPath: string, mtimeMs: number): void {
      this.evictExpired();
      this.entries.set(this.key(fsPath), { mtimeMs, registeredAt: this.clock.now() });
   }

   isRegistered(fsPath: string, mtimeMs: number): boolean {
      const entry = this.entries.get(this.key(fsPath));
      if (!entry || this.isExpired(entry.registeredAt)) {
         return false;
      }
      // Accept mtime equality (some filesystems have 1-second precision).
      return entry.mtimeMs === mtimeMs;
   }

   /**
    * Drop every expired registration.
    *
    * On the WRITE path, so the query stays free of side effects. Evicting from
    * the query instead reaches only the keys something happens to ask about,
    * and a path written once and never queried again is then retained for the
    * life of the process. Bounded by the paths self-written inside one TTL
    * window, so the sweep is over a handful of entries and sits behind a file
    * write either way.
    */
   protected evictExpired(): void {
      for (const [key, entry] of this.entries) {
         if (this.isExpired(entry.registeredAt)) {
            this.entries.delete(key);
         }
      }
   }

   /** Strictly greater, so an entry aged exactly to the TTL is still eligible. */
   protected isExpired(registeredAt: number): boolean {
      return this.clock.now() - registeredAt > this.ttlMs;
   }
}
