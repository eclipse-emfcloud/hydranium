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
import { Range, type TextDocumentsConfiguration, type TextEdit, uinteger } from 'vscode-languageserver';
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
   /**
    * Record what the client answered. Only the first call counts; a refusal of
    * an addressed push is logged; an answer that arrives after the client
    * reopened the URI changes nothing.
    */
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
   /** The client's buffer is the synced text, so its ranges apply as sent. */
   | { readonly kind: 'direct' };

/**
 * The store's model of what the LSP language client holds for each URI it
 * opened: the text, the version it declared and the version a push moved it
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
    * The client opened `key` under `clientUri` holding `text`. `firstOpen`,
    * the store's first open of `key`: that text becomes the diff baseline;
    * otherwise there is none, since a buffer opened from disk can lag the
    * synced text, and a push of other text is a full replace. Either replaces
    * what was tracked for `clientUri` before the open. A no-op when this URI
    * is already open.
    */
   addOpen(key: CanonicalUri, clientUri: LanguageClientUri, version: number, text: string, firstOpen: boolean): void;
   /** The version the client last declared for `key` under `clientUri`; `undefined` when it never opened it there. */
   declaredVersion(key: CanonicalUri, clientUri: LanguageClientUri): number | undefined;
   /**
    * Take `version` as the client's newest for `clientUri`, and classify its
    * change against `document`, the synced document. The caller has already
    * dropped a stale change. After a `direct` or `divergent` verdict the caller
    * commits the change and reports the synced text through
    * {@link LanguageClientShadow.setLanguageClientText}: a `direct` change advances what
    * the client was last heard to hold only through that call, and without it
    * the next change is rebuilt against a stale text.
    */
   acceptChange(
      key: CanonicalUri,
      clientUri: LanguageClientUri,
      version: number,
      document: TextDocument,
      changes: TextDocumentContentChangeEvent[]
   ): LanguageClientChangeVerdict;
   /** The client holds `text` with nothing in flight. */
   setLanguageClientText(clientUri: LanguageClientUri, text: string): void;
   /** The client closed `clientUri`; what it held there is forgotten. */
   removeOpen(key: CanonicalUri, clientUri: LanguageClientUri): void;
   /** Whether the client has `key` open: under `clientUri` when given, else under any URI. */
   isOpen(key: CanonicalUri, clientUri?: LanguageClientUri): boolean;
   /** Forget every URI the client holds `key` under. */
   removeAllOpens(key: CanonicalUri): void;
   /**
    * The URIs a push of `key` goes to: each open of it, none when the client
    * has not opened it. A client applies a push to a closed file by opening
    * it, and an open racing its own push leaves no text to diff against.
    */
   pushTargets(key: CanonicalUri): LanguageClientUri[];
   /**
    * Diff `text` against what the client holds under `clientUri` and queue the
    * push for echo correlation, which has to precede the RPC because an echo
    * can arrive before its response. `undefined` when there is nothing to send,
    * which includes a `clientUri` the client no longer has open: a close can
    * land while the push to another of its URIs is in flight.
    */
   preparePush(key: CanonicalUri, clientUri: LanguageClientUri, text: string): PreparedLanguageClientPush | undefined;
   /**
    * Drop the diff baseline and the pushes in flight under `clientUri`; its
    * next push is a full replace, or nothing when the client was last heard to
    * hold that text. What the client was last heard to hold stays, and its
    * changes are still rebuilt against it.
    */
   invalidateLanguageClientText(clientUri: LanguageClientUri): void;
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
   /** The diff baseline: the text the client holds once every push in flight has landed. */
   protected readonly baselines = new Map<LanguageClientUri, string>();
   /**
    * What the client was last heard to hold: the text of its open, advanced
    * through every change since. Each change's ranges address the text the
    * previous one left, so changes are rebuilt against this; the diff baseline
    * moves ahead at a push and does not hold it. A push compares against it
    * for equality only: a line-keyed diff keyed to it splices a buffer the
    * client may have moved past.
    */
   protected readonly heardTexts = new Map<LanguageClientUri, string>();
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
      // Dropped: a seed set before the open names no buffer, and a line diff
      // against it splices text the client does not hold.
      this.invalidateLanguageClientText(clientUri);
      this.heardTexts.set(clientUri, text);
      if (firstOpen) {
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
    * Reconstruct the client's resulting buffer against what it was last heard
    * to hold, which its ranges address whatever was pushed meanwhile.
    *
    * The client applies pushes in order, so the first echo belongs to the
    * oldest entry. Matching against every pending hash, not only the oldest,
    * recognises an echo a newer push already superseded, and consumes
    * everything older too. A reconstruction matching none means the client's
    * buffer went somewhere we did not send it, and the queue drops.
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
      // The synced text stands in only for a URI with nothing recorded, which
      // has nothing in flight either.
      const heard = this.heardTexts.get(clientUri) ?? document.getText();
      const pending = this.pending.get(clientUri);
      if (!pending?.length && heard === document.getText()) {
         // The ranges apply to the synced text as sent, and the caller's
         // setLanguageClientText records the result. Were it rebuilt here too, every
         // keystroke would copy the whole text a second time and rescan its lines.
         return { kind: 'direct' };
      }
      const probe = this.configuration.create(clientUri, document.languageId, 0, heard);
      const reconstructed = this.configuration.update(probe, changes, 0).getText();
      this.heardTexts.set(clientUri, reconstructed);
      if (pending?.length) {
         const matchIndex = pending.findIndex(push => push.afterHash === textHash(reconstructed));
         if (matchIndex >= 0) {
            pending.splice(0, matchIndex + 1);
            return { kind: 'echo' };
         }
         this.pending.delete(clientUri);
      }
      return heard === document.getText() ? { kind: 'direct' } : { kind: 'divergent', text: reconstructed };
   }

   setLanguageClientText(clientUri: LanguageClientUri, text: string): void {
      this.baselines.set(clientUri, text);
      this.heardTexts.set(clientUri, text);
      this.pending.delete(clientUri);
   }

   removeOpen(key: CanonicalUri, clientUri: LanguageClientUri): void {
      const uris = this.opens.get(key);
      if (uris?.delete(clientUri)) {
         this.invalidateLanguageClientText(clientUri);
         this.heardTexts.delete(clientUri);
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
         this.invalidateLanguageClientText(clientUri);
         this.heardTexts.delete(clientUri);
      }
      this.opens.delete(key);
   }

   pushTargets(key: CanonicalUri): LanguageClientUri[] {
      return [...(this.opens.get(key)?.keys() ?? [])];
   }

   preparePush(key: CanonicalUri, clientUri: LanguageClientUri, text: string): PreparedLanguageClientPush | undefined {
      // Captured now: a reopen while the push is in flight replaces the state.
      const state = this.opens.get(key)?.get(clientUri);
      if (state === undefined) {
         return undefined;
      }
      const edits = this.computeEdits(clientUri, text);
      if (edits.length === 0) {
         return undefined;
      }
      this.recordPendingPush(clientUri, text);
      // Gating a full replace turns a stale-by-one version into a refused
      // update for no safety gain, and refuses the retry after a rejection.
      const version = isFullReplace(edits) ? null : Math.max(state.declaredVersion, state.pushedVersion ?? state.declaredVersion);
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
                        `Language client refused applyEdit addressed at version ${version} (it last declared version ${state.declaredVersion})`
                     );
               }
               // A reopen while the push was in flight reset what is tracked for the new buffer.
               if (this.opens.get(key)?.get(clientUri) === state) {
                  this.settle(clientUri, version, state, outcome);
               }
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
         this.invalidateLanguageClientText(clientUri);
      } else if (version !== null && state) {
         // A client steps once per applied edit that changes its buffer. Left
         // to the echo, a push sent next is refused at the old version.
         state.pushedVersion = version + 1;
      }
   }

   invalidateLanguageClientText(clientUri: LanguageClientUri): void {
      this.baselines.delete(clientUri);
      this.pending.delete(clientUri);
   }

   /**
    * The edits that bring the client from its baseline to `text`, moving the
    * baseline to `text`. A full replace without a baseline, none when the
    * client was last heard to hold exactly `text` (pushing it anyway dirties
    * the buffer and adds an undo step), and otherwise a line diff, verified by
    * applying it: a diff that does not reproduce `text` falls back to a full
    * replace rather than corrupting the client.
    */
   protected computeEdits(clientUri: LanguageClientUri, text: string): TextEdit[] {
      const old = this.baselines.get(clientUri);
      if (old === text) {
         return [];
      }
      this.baselines.set(clientUri, text);
      const fullReplace: TextEdit = { range: FULL_RANGE, newText: text };
      if (old === undefined) {
         return this.heardTexts.get(clientUri) === text ? [] : [fullReplace];
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
   protected recordPendingPush(clientUri: LanguageClientUri, text: string): void {
      let queue = this.pending.get(clientUri);
      if (!queue) {
         queue = [];
         this.pending.set(clientUri, queue);
      }
      queue.push({ afterHash: textHash(text) });
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
