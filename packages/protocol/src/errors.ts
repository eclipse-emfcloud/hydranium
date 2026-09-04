/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { ResponseError } from 'vscode-jsonrpc';

/**
 * Application-specific JSON-RPC error code for {@link ConflictError}.
 * Outside the reserved range (-32768 .. -32000) per JSON-RPC 2.0.
 *
 * The code is the load-bearing identifier across realm boundaries —
 * `code` is a first-class field on the JSON-RPC error envelope and
 * survives wire reconstruction; the custom `Error` subclass name does
 * not.
 */
export const CONFLICT_ERROR_CODE = 1001;

/**
 * Structured payload carried in {@link ConflictError.data}, and the only place
 * a post-RPC caller can read the version mismatch from.
 */
export interface ConflictErrorData {
   readonly uri: string;
   /** The based-on version the caller authored against. */
   readonly expected: number;
   /** The server's current text-document version at the time of the throw. */
   readonly actual: number;
}

/**
 * Thrown by `ModelService.update` / `ModelService.save` when the caller-
 * supplied based-on version no longer matches the server's current text-
 * document version for the same URI — i.e. the snapshot the caller
 * authored against has been superseded by an intervening edit.
 *
 * Extends vscode-jsonrpc's {@link ResponseError} so the typed
 * {@link ConflictErrorData} payload rides on the standard JSON-RPC
 * error envelope (`code`, `message`, `data`) — all three fields are
 * preserved by RPC reconstruction. Adopters that catch the error on
 * the receiving side of an RPC call read the version mismatch from
 * `err.data` (the instance is reconstructed as a generic
 * `ResponseError`, so subclass getters / fields do not survive).
 *
 * Detection is opt-in via the optional `baseVersion` field on
 * `TransferUpdateArgs` / `TransferSaveArgs`; callers that omit the field get
 * no gating. This mirrors LSP's `OptionalVersionedTextDocumentIdentifier`
 * posture, so headless / CLI / batch tooling with no meaningful based-on
 * version can opt out explicitly.
 *
 * Three reasonable adopter recovery strategies:
 *
 * | Strategy | Use case |
 * |---|---|
 * | Drop + refetch | Form-widget save; user can re-trigger if they still want the edit. |
 * | Refetch + replay user edit | Specific structural edits (`setField`, drag-position). Adopter responsibility. |
 * | Surface to user | Large edits, multi-step transactions. Adopter UI. |
 *
 * The framework provides the **detection**; adopters provide the **policy**.
 * No auto-retry or auto-merge ships by default.
 */
export class ConflictError extends ResponseError<ConflictErrorData> {
   constructor(uri: string, expected: number, actual: number) {
      super(CONFLICT_ERROR_CODE, `Stale-based update for ${uri}: expected v${expected}, server is at v${actual}`, {
         uri,
         expected,
         actual
      });
      this.name = 'ConflictError';
      // ResponseError's constructor calls `Object.setPrototypeOf(this,
      // ResponseError.prototype)` to keep its own prototype chain intact across
      // transpilation targets; that resets us to ResponseError, hiding the
      // ConflictError-specific getters. Restore the prototype here so
      // `err.uri` / `.expected` / `.actual` resolve through this class.
      Object.setPrototypeOf(this, ConflictError.prototype);
   }

   get uri(): string {
      return this.data!.uri;
   }

   get expected(): number {
      return this.data!.expected;
   }

   get actual(): number {
      return this.data!.actual;
   }
}

/** Marker substring present in every {@link ConflictError} message, used by
 *  {@link isConflictError} as a fallback when a transport re-wraps the error
 *  and drops the JSON-RPC code. */
const CONFLICT_ERROR_MESSAGE_MARKER = 'Stale-based update for ';

/**
 * Type guard for {@link ConflictError}. Detection ladder:
 *
 *  1. `error.name === 'ConflictError'` — direct in-process throw, no
 *     RPC round-trip.
 *  2. `(error as ResponseError).code === CONFLICT_ERROR_CODE` — the
 *     canonical wire-side check; the JSON-RPC `code` field is preserved
 *     across reconstruction, so any adopter catching after an RPC call
 *     hits this branch.
 *  3. `error.message.includes('Stale-based update for ')` — fallback
 *     for transports that re-wrap the message and drop the code (rare).
 *
 * `instanceof ConflictError` alone would silently return `false` on the
 * reconstructed shape, so callers do not use it.
 */
export function isConflictError(error: unknown): error is ConflictError {
   if (!(error instanceof Error)) {
      return false;
   }
   if (error.name === 'ConflictError') {
      return true;
   }
   const code = (error as Partial<ResponseError<unknown>>).code;
   if (code === CONFLICT_ERROR_CODE) {
      return true;
   }
   return typeof error.message === 'string' && error.message.includes(CONFLICT_ERROR_MESSAGE_MARKER);
}
