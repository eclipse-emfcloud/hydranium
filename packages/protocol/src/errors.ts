/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { ResponseError } from 'vscode-jsonrpc';
import { defineMessage, type HydraniumMessageData, messageData } from './messages/primitives';

/**
 * The catalogue declaration behind {@link ConflictError}'s sentence.
 *
 * Its English must keep containing {@link CONFLICT_ERROR_MESSAGE_MARKER}: the
 * marker is tier 3 of {@link isConflictError}'s ladder, and it matches on text.
 * That tier only ever works untranslated, which is why it is the last resort
 * behind the numeric code rather than the primary check.
 */
export const STALE_BASED_UPDATE = defineMessage(
   'hydranium/protocol/stale-based-update',
   'Stale-based update for {uri}: expected v{expectedVersion}, server is at v{actualVersion}'
);

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
export interface ConflictErrorData extends HydraniumMessageData {
   readonly uri: string;
   /** The based-on version the caller authored against. */
   readonly expectedVersion: number;
   /** The server's current text-document version at the time of the throw. */
   readonly actualVersion: number;
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
 * Detection is driven by the required `basedOn` field on
 * `TransferUpdateArgs` / `TransferSaveArgs`; a caller with no meaningful
 * based-on version passes `'anything'` and gets no gating.
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
   constructor(uri: string, expectedVersion: number, actualVersion: number) {
      const params = { uri, expectedVersion, actualVersion };
      // The identity rides alongside the typed payload rather than replacing
      // it: `isConflictError`'s name check is surface an adopter may bind, so
      // adding the identity widens the payload rather than reshaping it.
      super(CONFLICT_ERROR_CODE, STALE_BASED_UPDATE.format(params), { ...params, ...messageData(STALE_BASED_UPDATE, params) });
      this.name = 'ConflictError';
      // ResponseError's constructor calls `Object.setPrototypeOf(this,
      // ResponseError.prototype)` to keep its own prototype chain intact across
      // transpilation targets; that resets us to ResponseError, hiding the
      // ConflictError-specific getters. Restore the prototype here so
      // `err.uri` / `.expectedVersion` / `.actualVersion` resolve through this
      // class.
      Object.setPrototypeOf(this, ConflictError.prototype);
   }

   get uri(): string {
      return this.data!.uri;
   }

   /**
    * The based-on version the caller authored against.
    *
    * Must not be renamed to `expected`, nor its sibling to `actual`: a test
    * reporter reads an error carrying both as an assertion failure, and
    * vitest's formatter then ASSIGNS to them, which throws on an accessor and
    * replaces the real failure with a `TypeError`.
    */
   get expectedVersion(): number {
      return this.data!.expectedVersion;
   }

   /** The server's version at the time of the throw. Not `actual` — see {@link expectedVersion}. */
   get actualVersion(): number {
      return this.data!.actualVersion;
   }
}

/**
 * JSON-RPC code for {@link SessionClosedError}, beside {@link CONFLICT_ERROR_CODE}
 * and for the same reason: the code survives reconstruction, the class does not.
 */
export const SESSION_CLOSED_ERROR_CODE = 1004;
/** JSON-RPC code for {@link DocumentNotOpenError}. */
export const DOCUMENT_NOT_OPEN_ERROR_CODE = 1005;
/** JSON-RPC code for {@link DuplicateClientIdError}. */
export const DUPLICATE_CLIENT_ID_ERROR_CODE = 1006;

/**
 * Thrown by every call on a client session after it ended, and by an open that
 * was still in flight when its session ended.
 *
 * The message names the client id, so it is addressed to whoever composes the
 * system rather than to an end user, and carries no message identity. A client
 * recognises it after an RPC with {@link isSessionClosedError}.
 */
export class SessionClosedError extends ResponseError<{ readonly clientId: string }> {
   /** `message` replaces the default sentence, for a caller that knows more than that the session is gone. */
   constructor(clientId: string, message = `Client session ${clientId} is closed`) {
      super(SESSION_CLOSED_ERROR_CODE, message, { clientId });
      this.name = 'SessionClosedError';
      // `ResponseError` resets the prototype to its own; see `ConflictError`.
      Object.setPrototypeOf(this, SessionClosedError.prototype);
   }

   get clientId(): string {
      return this.data!.clientId;
   }
}

/**
 * Thrown when a client session writes a document it does not have open.
 *
 * A session writes only what it has open, so this is the answer both to a write
 * that never opened and to one whose open was closed underneath it — by the
 * session itself, or by the document being deleted.
 */
export class DocumentNotOpenError extends ResponseError<{ readonly uri: string; readonly clientId: string }> {
   constructor(uri: string, clientId: string) {
      super(DOCUMENT_NOT_OPEN_ERROR_CODE, `Document ${uri} is not open in client session ${clientId}`, { uri, clientId });
      this.name = 'DocumentNotOpenError';
      Object.setPrototypeOf(this, DocumentNotOpenError.prototype);
   }

   get uri(): string {
      return this.data!.uri;
   }

   get clientId(): string {
      return this.data!.clientId;
   }
}

/**
 * Thrown when a client session is started under an id that is already live in
 * the process, or that the framework reserves for itself.
 *
 * Ids are unique process-wide because the id is also the author label on every
 * version and the key a client recognises its own echoes by; two participants
 * sharing one would each take the other's writes for their own.
 */
export class DuplicateClientIdError extends ResponseError<{ readonly clientId: string }> {
   constructor(clientId: string) {
      super(DUPLICATE_CLIENT_ID_ERROR_CODE, `Client id ${clientId} is already in use`, { clientId });
      this.name = 'DuplicateClientIdError';
      Object.setPrototypeOf(this, DuplicateClientIdError.prototype);
   }

   get clientId(): string {
      return this.data!.clientId;
   }
}

/**
 * Whether `error` is a {@link SessionClosedError}: by name in-process, by code
 * after an RPC, where it arrives as a plain `ResponseError`.
 */
export function isSessionClosedError(error: unknown): error is SessionClosedError {
   return hasErrorIdentity(error, 'SessionClosedError', SESSION_CLOSED_ERROR_CODE);
}

/** Whether `error` is a {@link DocumentNotOpenError}; see {@link isSessionClosedError}. */
export function isDocumentNotOpenError(error: unknown): error is DocumentNotOpenError {
   return hasErrorIdentity(error, 'DocumentNotOpenError', DOCUMENT_NOT_OPEN_ERROR_CODE);
}

/** Whether `error` is a {@link DuplicateClientIdError}; see {@link isSessionClosedError}. */
export function isDuplicateClientIdError(error: unknown): error is DuplicateClientIdError {
   return hasErrorIdentity(error, 'DuplicateClientIdError', DUPLICATE_CLIENT_ID_ERROR_CODE);
}

function hasErrorIdentity(error: unknown, name: string, code: number): boolean {
   return error instanceof Error && (error.name === name || (error as Partial<ResponseError<unknown>>).code === code);
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
