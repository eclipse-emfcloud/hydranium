/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { diffLines } from 'diff';
import { Range, type TextEdit, uinteger } from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';

/**
 * The minimum surface the shadow needs from a `HydraniumTextDocuments`:
 * a `create` method that materialises a fresh text document via the
 * configured `TextDocumentsConfiguration`. Declared as a narrow
 * structural interface so the manager satisfies it without an explicit
 * import (sidestepping the circular `HydraniumTextDocuments → shadow → manager`
 * dependency) and so tests can stub it with a minimal object literal.
 */
export interface ShadowDocumentSource {
   create(uri: string, languageId: string, version: number, content: string): TextDocument;
}

/** The range every full-document replace emitted here carries. */
const FULL_RANGE = Range.create(0, 0, uinteger.MAX_VALUE, uinteger.MAX_VALUE);

/**
 * Whether `edits` is the single full-document replace {@link LanguageClientTextShadow.computeEdits}
 * emits when it has no usable baseline.
 *
 * The distinction matters at the `workspace/applyEdit` egress: a full replace is
 * position-INDEPENDENT and therefore lands correctly on any client buffer, while
 * a line-keyed diff only lands correctly on the exact text it was diffed
 * against. Only the latter needs a client-version gate.
 */
export function isFullReplace(edits: readonly TextEdit[]): boolean {
   if (edits.length !== 1) {
      return false;
   }
   const { start, end } = edits[0].range;
   return start.line === FULL_RANGE.start.line && start.character === FULL_RANGE.start.character && end.line === FULL_RANGE.end.line;
}

/**
 * Tracks the text content the language client (typically Monaco) is believed to
 * currently hold so outgoing `workspace/applyEdit` requests can ship minimal
 * diffs instead of full-document replaces.
 *
 * Why it matters: a full-range replace on a moderately-sized YAML or DSL source
 * forces Monaco to re-tokenise the entire document (observed multi-second hangs
 * on large diagrams), whereas line-level diffs usually reduce that to a handful
 * of small edits.
 *
 * Update points the caller is responsible for:
 *  - {@link computeEdits} after each outgoing server→client sync (updates the shadow optimistically).
 *  - {@link set} when the server receives a `didChange` from the language client (the client now
 *    holds that text; we shouldn't resend it).
 *  - {@link setOpenedText} when the client opens a document the server did not baseline for it —
 *    an equality-only baseline, since that text is a snapshot rather than a tracked one.
 *  - {@link invalidate} when the client rejects an edit (`applied=false`) or a doc is closed —
 *    the shadow is now stale and the next sync must fall back to a full replace.
 */
export class LanguageClientTextShadow {
   protected shadow = new Map<string, string>();

   /**
    * Per URI, the text the client declared it opened the document with, held
    * only until a real baseline exists. Consulted by {@link computeEdits} when
    * there is no shadow, and dropped on {@link invalidate}: a snapshot that
    * outlived what the client holds would let the equality check skip an edit
    * the client still needs.
    */
   protected opened = new Map<string, string>();

   /**
    * @param onFallback invoked when {@link computeEdits} falls back to a full-range replace due to
    *    apply-verify mismatch. Useful for logging regressions.
    * @param documents the {@link ShadowDocumentSource} used to materialise the throwaway probe
    *    document in {@link computeEdits}. In production this is the owning
    *    `HydraniumTextDocuments` (whose `create` threads through its configured
    *    `TextDocumentsConfiguration`); tests pass a minimal stub. Routing
    *    through the manager rather than `TextDocument.create` directly avoids the
    *    `instanceof FullTextDocument` gate in the bare LSP `TextDocument.update`,
    *    keeping the verifier honest for adopters with a custom text-document type.
    */
   constructor(
      protected onFallback: (uri: string, reason: string) => void,
      protected documents: ShadowDocumentSource
   ) {}

   /** Record the text the language client is known to hold (e.g. after a `didChange` echo). */
   set(uri: string, text: string): void {
      this.shadow.set(uri, text);
   }

   /**
    * Record the buffer the language client declared at `didOpen`, for a URI
    * with no baseline yet.
    *
    * Deliberately NOT a {@link set}: this text is only ever compared for
    * EQUALITY, never diffed against. A line-keyed diff is position-dependent,
    * so keying one to a `didOpen` snapshot the client may have moved past
    * splices its buffer — the failure {@link computeEdits}'s full-replace
    * fallback exists to avoid.
    */
   setOpenedText(uri: string, text: string): void {
      this.opened.set(uri, text);
   }

   /**
    * The text the language client is believed to hold, or `undefined` when
    * there is no baseline (first sync, or after an {@link invalidate}).
    *
    * Read at the `workspace/applyEdit` egress BEFORE {@link computeEdits},
    * which overwrites it: a push's minimal edits are keyed to this text, so an
    * echo of that push carries ranges addressing it and nothing else. Losing
    * it is what makes an incremental echo unreconstructable, and applying such
    * an echo to the already-advanced synced text duplicates every inserted
    * line.
    */
   get(uri: string): string | undefined {
      return this.shadow.get(uri);
   }

   /** Forget the shadow for a URI; next {@link computeEdits} falls back to a full-document replace. */
   invalidate(uri: string): void {
      this.shadow.delete(uri);
      // Drops the opened snapshot too, and this is the only place that has to:
      // `computeEdits` clears it whenever it consults it, so the sole way it can
      // outlive what the client holds is surviving under a live shadow until that
      // shadow is dropped here.
      this.opened.delete(uri);
   }

   /**
    * Return the minimal LSP {@link TextEdit}s required to bring the language client's content from
    * the tracked shadow to `newText`. Updates the shadow to `newText` so subsequent calls diff
    * against it.
    *
    *  - Empty array when the shadow already equals `newText` (caller should skip the RPC),
    *    or when there is no shadow and the client opened the document with exactly `newText`
    *    (see {@link setOpenedText}) — pushing it anyway dirties the client's buffer on open.
    *  - Full-range replace when there is no shadow (first sync or post-{@link invalidate}).
    *  - Line-level diff otherwise. Before returning, we locally reconstruct `newText` by applying
    *    the diff to `old`; if that doesn't match, we fall back to a full-range replace and notify
    *    the fallback callback. This catches any algorithmic regression in {@link diffToEdits}
    *    without risking client corruption.
    */
   computeEdits(uri: string, newText: string): TextEdit[] {
      const old = this.shadow.get(uri);
      if (old === newText) {
         return [];
      }
      this.shadow.set(uri, newText);
      const fullReplace: TextEdit = { range: FULL_RANGE, newText };
      if (old === undefined) {
         // The opened snapshot has served its purpose either way: the shadow above
         // is now the baseline, so leaving it would only risk a later stale match.
         const openedText = this.opened.get(uri);
         this.opened.delete(uri);
         return openedText === newText ? [] : [fullReplace];
      }
      const edits = diffToEdits(old, newText);
      const verifyDoc = this.documents.create(uri, 'plaintext', 0, old);
      if (TextDocument.applyEdits(verifyDoc, edits) !== newText) {
         this.onFallback(uri, 'apply-verify-mismatch');
         return [fullReplace];
      }
      return edits;
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
