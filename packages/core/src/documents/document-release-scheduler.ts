/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { type CanonicalUri, type Clock, type Stopwatch } from '@hydranium/protocol';
import { type Disposable } from 'vscode-languageserver';

/** What an open of a document whose release is deferred means for it, as {@link DocumentReleaseScheduler.resolveOpen} decides. */
export type DeferredReleaseOpenDecision =
   /** The opener was lost from the document within its grace: it keeps the unsaved text. */
   | 'keep'
   /** Any other opener: the document is released first, and opens as a first open does. */
   | 'release'
   /** No release was deferred. */
   | 'none';

/**
 * Decides when the store releases a document no client holds: at once, or,
 * when its last client's connection was lost, once a grace has passed, so a
 * client that reconnects in time finds its unsaved text.
 */
export interface DocumentReleaseScheduler {
   /** How long a deferred release waits; `0` releases at once. */
   readonly graceMs: number;
   /** `clientId` closed `key` because its connection was lost. */
   recordLoss(key: CanonicalUri, clientId: string): void;
   /** No client holds `key` after a loss: run `release` once the grace has passed, or now when there is none. */
   defer(key: CanonicalUri, release: () => void): void;
   isDeferred(key: CanonicalUri): boolean;
   /** `clientId` opens `key`; a deferred release ends either way. */
   resolveOpen(key: CanonicalUri, clientId: string): DeferredReleaseOpenDecision;
   /** End a deferred release of `key` without running it. */
   cancel(key: CanonicalUri): void;
   /** `key` was released: drop the losses recorded for it. */
   clearLosses(key: CanonicalUri): void;
}

export class DefaultDocumentReleaseScheduler implements DocumentReleaseScheduler {
   protected readonly deferred = new Map<CanonicalUri, Disposable>();
   /**
    * Per document, the clients whose close of it was caused by a lost
    * connection and that have not opened it again, each with a stopwatch
    * started at its loss. Every such client counts, not only the last to
    * close: one connection's sessions all end lost together, and any of them
    * may reopen first. A stopwatch rather than a `now()` reading, because a
    * wall-clock step would otherwise expire a claim early or revive one past
    * its grace, against a grace timer that the step leaves alone.
    */
   protected readonly lostClients = new Map<CanonicalUri, Map<string, Stopwatch>>();

   constructor(
      protected readonly clock: Clock,
      readonly graceMs: number
   ) {}

   recordLoss(key: CanonicalUri, clientId: string): void {
      let lost = this.lostClients.get(key);
      if (!lost) {
         lost = new Map();
         this.lostClients.set(key, lost);
      }
      lost.set(clientId, this.clock.stopwatch());
   }

   defer(key: CanonicalUri, release: () => void): void {
      this.cancel(key);
      if (this.graceMs <= 0) {
         release();
         return;
      }
      this.deferred.set(
         key,
         this.clock.setTimer(() => {
            this.deferred.delete(key);
            release();
         }, this.graceMs)
      );
   }

   isDeferred(key: CanonicalUri): boolean {
      return this.deferred.has(key);
   }

   /**
    * A claim past its grace counts as any other client's: without the limit,
    * a client that returns late inherits the unsaved text of a holder lost
    * after it. Cancelling for every open instead hands a lost client's unsaved
    * text to whoever opens next, with nothing marking it unsaved.
    */
   resolveOpen(key: CanonicalUri, clientId: string): DeferredReleaseOpenDecision {
      const lost = this.lostClients.get(key);
      for (const [lostId, sinceLoss] of lost ?? []) {
         if (sinceLoss.elapsedMs >= this.graceMs) {
            lost?.delete(lostId);
         }
      }
      const returning = lost?.delete(clientId) ?? false;
      if (lost?.size === 0) {
         this.lostClients.delete(key);
      }
      if (!this.deferred.has(key)) {
         return 'none';
      }
      this.cancel(key);
      return returning ? 'keep' : 'release';
   }

   cancel(key: CanonicalUri): void {
      this.deferred.get(key)?.dispose();
      this.deferred.delete(key);
   }

   clearLosses(key: CanonicalUri): void {
      this.lostClients.delete(key);
   }
}
