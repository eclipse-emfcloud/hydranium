/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { type CanonicalUri, type LanguageClientUri, textHash, type Tracer } from '@hydranium/protocol';
import { diffLines } from 'diff';
import {
   Range,
   TextDocumentContentChangeEvent as ContentChange,
   type TextDocumentsConfiguration,
   type TextEdit,
   uinteger
} from 'vscode-languageserver';
import { TextDocument, type TextDocumentContentChangeEvent } from 'vscode-languageserver-textdocument';

/**
 * The language client's open of a document under one URI, from its didOpen to
 * its didClose. Each URI is its own editor buffer with its own version counter,
 * so a file reached through a symlink and its real path has one of these each.
 */
export interface LanguageClientDocumentState {
   /** The version the client last declared for this URI. */
   declaredVersion: number;
   /**
    * The version an applied versioned push moved this URI to, ahead of its
    * echo. Apart from `declaredVersion`, whose staleness guard would drop that
    * echo and strand its pending push.
    */
   pushedVersion?: number;
}

/**
 * One text pushed to the language client whose echo has not come back yet.
 * Outbound pushes and inbound echoes are uncorrelated on the wire; a FIFO of
 * these per URI is the explicit correlation.
 */
export interface PendingLanguageClientPush {
   /**
    * The text the client held BEFORE this push, and therefore the text its
    * echo addresses with its ranges. A hash of the pushed text alone cannot
    * reconstruct an incremental echo: its ranges address the previous buffer,
    * and applied to the already-advanced synced text the line they insert
    * lands twice.
    *
    * `undefined` only when that buffer is unknown — the client never declared
    * one, or a rejection invalidated what was tracked. The echo is then
    * reconstructed against the synced text, which is sound only for a
    * position-independent (full-text) change.
    */
   readonly before: string | undefined;
   /** {@link textHash} of the text this push moves the client to. */
   readonly afterHash: string;
}

/** A push {@link LanguageClientShadow.preparePush} has queued, for the store to send and settle. */
export interface PreparedLanguageClientPush {
   readonly clientUri: LanguageClientUri;
   readonly edits: TextEdit[];
   /**
    * The client version the edits are addressed at, so the client refuses a
    * push its buffer has outrun; `null` for a full replace, which lands on any
    * buffer and is the caller's retry after a refusal.
    */
   readonly version: number | null;
   /** Record what the client answered. Only the first call counts; a refusal of an addressed push is logged. */
   notifyOutcome(outcome: LanguageClientPushOutcome): void;
}

/** What the client answered a {@link PreparedLanguageClientPush}. */
export type LanguageClientPushOutcome = 'applied' | 'refused' | 'failed';

/** What an incoming language-client change is, as {@link LanguageClientShadow.acceptChange} finds it. */
export type LanguageClientChangeVerdict =
   /** The client is reporting a text we pushed it. The synced document is already there. */
   | { readonly kind: 'echo' }
   /**
    * The client's buffer holds a text we did not push it — a keystroke that
    * raced a push, or an edit to a buffer the store has already been written
    * past. Its ranges address that buffer, so applied to the synced text they
    * splice the wrong lines; `text` is what it now holds, and is authoritative.
    */
   | { readonly kind: 'divergent'; readonly text: string }
   /**
    * The change carries ranges and no known text addresses them. Adopting one
    * anyway splices the document and stores an edit nobody made; dropping costs
    * at most the one keystroke the client still holds and the next push
    * contradicts.
    */
   | { readonly kind: 'unreconstructable' }
   /** The client's buffer is the synced text, so its ranges apply as sent. */
   | { readonly kind: 'direct' };

/**
 * The store's model of what the LSP language client holds for each URI it
 * opened or the store pushed to: the text, the version it declared and the version a push moved it
 * to, and the pushes it has not echoed yet. The store speaks the protocol;
 * this answers what an incoming change is and what an outgoing push sends.
 *
 * Keyed by the URI the client opened under, which differs from the store's
 * canonical key when the path does not match its real path, so one document
 * can have several.
 *
 * A push is a diff against the text the client holds rather than a full
 * replace: a full-range replace on a large source makes Monaco re-tokenise the
 * whole document, observed as multi-second hangs.
 */
export interface LanguageClientShadow {
   /**
    * The client opened `key` under `clientUri`. `firstOpen`, the store's first
    * open of `key`: its text becomes the diff baseline, unless a push already
    * waits for this URI; otherwise an equality-only baseline, since a buffer
    * opened from disk can lag the synced text. A no-op when this URI is
    * already open.
    */
   addOpen(key: CanonicalUri, clientUri: LanguageClientUri, version: number, text: string, firstOpen: boolean): void;
   /** The version the client last declared for `key` under `clientUri`; `undefined` when it never opened it there. */
   declaredVersion(key: CanonicalUri, clientUri: LanguageClientUri): number | undefined;
   /**
    * Take `version` as the client's newest for `clientUri`, and classify its
    * change against `document`, the synced document. The caller has already
    * dropped a stale change.
    */
   acceptChange(
      key: CanonicalUri,
      clientUri: LanguageClientUri,
      version: number,
      document: TextDocument,
      changes: TextDocumentContentChangeEvent[]
   ): LanguageClientChangeVerdict;
   /** The client holds `text` with nothing in flight. */
   setClientText(clientUri: LanguageClientUri, text: string): void;
   /** The client closed `clientUri`; what it held there is forgotten. */
   removeOpen(key: CanonicalUri, clientUri: LanguageClientUri): void;
   /** Whether the client has `key` open: under `clientUri` when given, else under any URI. */
   isOpen(key: CanonicalUri, clientUri?: LanguageClientUri): boolean;
   /** Forget every URI the client holds `key` under. */
   removeAllOpens(key: CanonicalUri): void;
   /** The URIs a push of `key` goes to: each open of it, else `fallback`. */
   pushTargets(key: CanonicalUri, fallback: LanguageClientUri): LanguageClientUri[];
   /**
    * Diff `text` against what the client holds under `clientUri` and queue the
    * push for echo correlation, which has to precede the RPC because an echo
    * can arrive before its response. `undefined` when there is nothing to send.
    */
   preparePush(key: CanonicalUri, clientUri: LanguageClientUri, text: string): PreparedLanguageClientPush | undefined;
   /** Forget what the client holds under `clientUri`; its next push is a full replace. */
   invalidateClientText(clientUri: LanguageClientUri): void;
}

/**
 * Upper bound on the pending pushes per URI. Echoes normally return within
 * milliseconds; a queue this deep means the client stopped echoing.
 */
const PENDING_ECHO_CAP = 32;

/** The range every full-document replace emitted here carries. */
const FULL_RANGE = Range.create(0, 0, uinteger.MAX_VALUE, uinteger.MAX_VALUE);

/**
 * Whether `edits` is the single full-document replace a push emits when it has
 * no usable baseline. A full replace is position-independent and lands on any
 * client buffer; a line-keyed diff lands only on the text it was diffed
 * against, so only the latter needs a client-version gate.
 */
export function isFullReplace(edits: readonly TextEdit[]): boolean {
   if (edits.length !== 1) {
      return false;
   }
   const { start, end } = edits[0].range;
   return start.line === FULL_RANGE.start.line && start.character === FULL_RANGE.start.character && end.line === FULL_RANGE.end.line;
}

export class DefaultLanguageClientShadow<T extends TextDocument = TextDocument> implements LanguageClientShadow {
   protected readonly opens = new Map<CanonicalUri, Map<LanguageClientUri, LanguageClientDocumentState>>();
   /** The diff baseline: the text the client is believed to hold. */
   protected readonly baselines = new Map<LanguageClientUri, string>();
   /**
    * The text the client declared at an open with no diff baseline, compared
    * for equality only. A line-keyed diff keyed to this snapshot splices a
    * buffer the client may have moved past.
    */
   protected readonly openedTexts = new Map<LanguageClientUri, string>();
   protected readonly pending = new Map<LanguageClientUri, PendingLanguageClientPush[]>();

   /**
    * @param configuration the store's text-document factories, the store's own
    *    `create` and `update`. Probes go through them rather than `TextDocument`
    *    directly, so an adopter's custom text-document type applies ranges here
    *    as it does on the synced document; the bare `TextDocument.update` also
    *    refuses a document it did not create.
    */
   constructor(
      protected readonly configuration: TextDocumentsConfiguration<T>,
      protected readonly tracer: Tracer
   ) {}

   addOpen(key: CanonicalUri, clientUri: LanguageClientUri, version: number, text: string, firstOpen: boolean): void {
      let uris = this.opens.get(key);
      if (uris?.has(clientUri)) {
         return;
      }
      if (!uris) {
         uris = new Map();
         this.opens.set(key, uris);
      }
      uris.set(clientUri, { declaredVersion: version });
      if (!firstOpen) {
         this.openedTexts.set(clientUri, text);
      } else if (!this.baselines.has(clientUri)) {
         // A push to a closed file has the client open it from disk and apply
         // afterwards, so a tracked text already names what it is about to hold.
         this.baselines.set(clientUri, text);
      }
   }

   declaredVersion(key: CanonicalUri, clientUri: LanguageClientUri): number | undefined {
      return this.opens.get(key)?.get(clientUri)?.declaredVersion;
   }

   acceptChange(
      key: CanonicalUri,
      clientUri: LanguageClientUri,
      version: number,
      document: TextDocument,
      changes: TextDocumentContentChangeEvent[]
   ): LanguageClientChangeVerdict {
      const state = this.opens.get(key)?.get(clientUri);
      if (state) {
         state.declaredVersion = version;
      }
      return this.classify(clientUri, document, changes);
   }

   /**
    * Reconstruct the client's resulting buffer against the text its ranges
    * address: the pre-push buffer of the oldest push still in flight, else
    * what the client is believed to hold.
    *
    * The client applies pushes in order and echoes each against the buffer it
    * held before that push, so the first echo belongs to the oldest entry.
    * Matching against every pending hash, not only the oldest, recognises an
    * echo a newer push already superseded, and consumes everything older too.
    * A reconstruction matching none means the client's buffer went somewhere
    * we did not send it, and the queue drops.
    *
    * Content equality is a sound echo proof because entries live only between
    * a push and its echo, and `didChange` arrives in mutation order: an undo
    * back to a previously pushed text revisits a past state, while the queue
    * holds only in-flight ones.
    */
   protected classify(
      clientUri: LanguageClientUri,
      document: TextDocument,
      changes: TextDocumentContentChangeEvent[]
   ): LanguageClientChangeVerdict {
      const queued = this.pending.get(clientUri);
      const pending = queued?.length ? queued : undefined;
      const clientText = pending?.[0].before ?? this.clientText(clientUri);
      if (pending === undefined && (clientText === undefined || clientText === document.getText())) {
         return { kind: 'direct' };
      }
      if (pending !== undefined && pending[0].before === undefined && changes.some(change => ContentChange.isIncremental(change))) {
         // A push sent to a buffer it did not know: the tracked text is now the
         // text that push moves the client to, the one text these ranges
         // provably do not address. Dropped, the next push is a full replace. A
         // full-text change reconstructs identically against any baseline.
         this.invalidateClientText(clientUri);
         return { kind: 'unreconstructable' };
      }
      const probe = this.configuration.create(clientUri, document.languageId, 0, clientText ?? document.getText());
      const reconstructed = this.configuration.update(probe, changes, 0).getText();
      if (pending !== undefined) {
         const matchIndex = pending.findIndex(push => push.afterHash === textHash(reconstructed));
         if (matchIndex >= 0) {
            pending.splice(0, matchIndex + 1);
            return { kind: 'echo' };
         }
         this.pending.delete(clientUri);
      }
      return { kind: 'divergent', text: reconstructed };
   }

   setClientText(clientUri: LanguageClientUri, text: string): void {
      this.baselines.set(clientUri, text);
      this.pending.delete(clientUri);
   }

   removeOpen(key: CanonicalUri, clientUri: LanguageClientUri): void {
      const uris = this.opens.get(key);
      if (uris?.delete(clientUri)) {
         this.invalidateClientText(clientUri);
         if (uris.size === 0) {
            this.opens.delete(key);
         }
      }
   }

   isOpen(key: CanonicalUri, clientUri?: LanguageClientUri): boolean {
      const uris = this.opens.get(key);
      return clientUri === undefined ? uris !== undefined : (uris?.has(clientUri) ?? false);
   }

   removeAllOpens(key: CanonicalUri): void {
      for (const clientUri of this.opens.get(key)?.keys() ?? []) {
         this.invalidateClientText(clientUri);
      }
      this.opens.delete(key);
   }

   pushTargets(key: CanonicalUri, fallback: LanguageClientUri): LanguageClientUri[] {
      const uris = this.opens.get(key);
      return uris && uris.size > 0 ? [...uris.keys()] : [fallback];
   }

   preparePush(key: CanonicalUri, clientUri: LanguageClientUri, text: string): PreparedLanguageClientPush | undefined {
      // Read before computing the edits, which moves the baseline: this is the
      // only text the push's echo can be reconstructed against.
      const before = this.clientText(clientUri);
      const edits = this.computeEdits(clientUri, text);
      if (edits.length === 0) {
         return undefined;
      }
      this.recordPendingPush(clientUri, before, text);
      // Captured now: a reopen while the push is in flight replaces the state.
      const state = this.opens.get(key)?.get(clientUri);
      // Gating a full replace turns a stale-by-one version into a refused
      // update for no safety gain, and refuses the retry after a rejection.
      const version =
         isFullReplace(edits) || state === undefined ? null : Math.max(state.declaredVersion, state.pushedVersion ?? state.declaredVersion);
      let settled = false;
      return {
         clientUri,
         edits,
         version,
         notifyOutcome: outcome => {
            if (!settled) {
               settled = true;
               if (outcome === 'refused' && version !== null) {
                  this.tracer
                     .with(key)
                     .warn(
                        `Language client refused applyEdit addressed at version ${version} (it last declared version ${state?.declaredVersion})`
                     );
               }
               this.settle(clientUri, version, state, outcome);
            }
         }
      };
   }

   /** What a prepared push's {@link PreparedLanguageClientPush.notifyOutcome} does. */
   protected settle(
      clientUri: LanguageClientUri,
      version: number | null,
      state: LanguageClientDocumentState | undefined,
      outcome: LanguageClientPushOutcome
   ): void {
      if (outcome !== 'applied') {
         this.invalidateClientText(clientUri);
      } else if (version !== null && state) {
         // A client steps once per applied edit that changes its buffer. Left
         // to the echo, a push sent next is refused at the old version.
         state.pushedVersion = version + 1;
      }
   }

   invalidateClientText(clientUri: LanguageClientUri): void {
      this.baselines.delete(clientUri);
      this.openedTexts.delete(clientUri);
      this.pending.delete(clientUri);
   }

   /** The text the client is believed to hold: the diff baseline, else what it declared at open. */
   protected clientText(clientUri: LanguageClientUri): string | undefined {
      return this.baselines.get(clientUri) ?? this.openedTexts.get(clientUri);
   }

   /**
    * The edits that bring the client from its baseline to `text`, moving the
    * baseline to `text`. A full replace without a baseline, none when the
    * client opened with exactly `text` (pushing it anyway dirties the buffer on
    * open), and otherwise a line diff, verified by applying it: a diff that
    * does not reproduce `text` falls back to a full replace rather than
    * corrupting the client.
    */
   protected computeEdits(clientUri: LanguageClientUri, text: string): TextEdit[] {
      const old = this.baselines.get(clientUri);
      if (old === text) {
         return [];
      }
      this.baselines.set(clientUri, text);
      const fullReplace: TextEdit = { range: FULL_RANGE, newText: text };
      if (old === undefined) {
         const openedText = this.openedTexts.get(clientUri);
         this.openedTexts.delete(clientUri);
         return openedText === text ? [] : [fullReplace];
      }
      const edits = diffToEdits(old, text);
      const probe = this.configuration.create(clientUri, 'plaintext', 0, old);
      if (TextDocument.applyEdits(probe, edits) !== text) {
         this.tracer.with(clientUri).warn('Diff apply-verify fallback (apply-verify-mismatch) — using full-document replace');
         return [fullReplace];
      }
      return edits;
   }

   /** Bounded, so an echo that never arrives cannot grow the queue without limit. */
   protected recordPendingPush(clientUri: LanguageClientUri, before: string | undefined, text: string): void {
      let queue = this.pending.get(clientUri);
      if (!queue) {
         queue = [];
         this.pending.set(clientUri, queue);
      }
      queue.push({ before, afterHash: textHash(text) });
      if (queue.length > PENDING_ECHO_CAP) {
         queue.shift();
         this.tracer.with(clientUri).debug(`Pending-echo queue exceeded ${PENDING_ECHO_CAP} entries; dropped the oldest`);
      }
   }
}

/**
 * Convert a {@link diffLines} result to a list of LSP {@link TextEdit}s keyed on line positions
 * in the *old* text. Contiguous added/removed hunks are coalesced into a single replace so the
 * client sees one edit per changed region.
 */
export function diffToEdits(oldText: string, newText: string): TextEdit[] {
   const hunks = diffLines(oldText, newText);
   const edits: TextEdit[] = [];
   let oldLine = 0;
   let i = 0;
   while (i < hunks.length) {
      const hunk = hunks[i];
      if (!hunk.added && !hunk.removed) {
         oldLine += hunk.count ?? 0;
         i++;
         continue;
      }
      // Coalesce a run of add/remove hunks into a single replace for this region.
      let removedLines = 0;
      let addedText = '';
      while (i < hunks.length && (hunks[i].added || hunks[i].removed)) {
         if (hunks[i].removed) {
            removedLines += hunks[i].count ?? 0;
         }
         if (hunks[i].added) {
            addedText += hunks[i].value;
         }
         i++;
      }
      edits.push({
         range: Range.create(oldLine, 0, oldLine + removedLines, 0),
         newText: addedText
      });
      oldLine += removedLines;
   }
   return edits;
}
