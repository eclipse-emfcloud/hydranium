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
import { asModelVersion, type ModelVersion, type TextVersion } from './model-service/base-version';

/*
 * Every error here is a typed error: a caller reacts to it, so it has a class,
 * a JSON-RPC code and an `is*` guard, and an English message. A typed error
 * also carries a message identity where the framework can write an end-user
 * sentence that needs no context. A URI may stay in that sentence; a client id
 * or a raw version stays out of it, worded or left to `data`.
 *
 * An error nothing reacts to does not belong here: it stays a plain `Error`, or
 * a named subclass without a code, at its throw site, since a code and a guard
 * are public API that no caller would use.
 */

/**
 * The catalogue declaration behind {@link ConflictError}'s sentence. It words
 * the version mismatch rather than stating it: the two numbers mean nothing to
 * an end user, and they stay in {@link ConflictErrorData}.
 *
 * Its English must keep containing {@link CONFLICT_ERROR_MESSAGE_MARKER}: the
 * marker is tier 3 of {@link isConflictError}'s ladder, and it matches on text.
 * That tier only ever works untranslated, which is why it is the last resort
 * behind the numeric code rather than the primary check.
 */
export const STALE_BASE_VERSION_UPDATE = defineMessage(
   'hydranium/protocol/stale-base-version-update',
   'The edit to {uri} was not applied: it was made to an older version of the document.'
);

/**
 * Every JSON-RPC error code the framework raises, from any package, keyed by
 * the error it identifies.
 *
 * The framework reserves the block 42000 to 42999 for these, and an adopter's
 * own codes stay outside it: after an RPC a guard matches on the code alone, so
 * an adopter's error carrying one of these reads as the framework's. A new code
 * takes the next unused number in the block, whichever package raises it, and
 * is declared here, where tests hold every code distinct and inside the block.
 * The block sits clear of the range JSON-RPC 2.0 reserves for itself, -32768
 * to -32000.
 */
export const HYDRANIUM_ERROR_CODES = {
   conflict: 42001,
   noActiveProfile: 42002,
   referenceSettleTimeout: 42003,
   sessionClosed: 42004,
   documentNotOpen: 42005,
   duplicateClientId: 42006,
   reservedClientId: 42007
} as const;

/**
 * JSON-RPC error code for {@link ConflictError}.
 *
 * The code is the load-bearing identifier across realm boundaries —
 * `code` is a first-class field on the JSON-RPC error envelope and
 * survives wire reconstruction; the custom `Error` subclass name does
 * not.
 */
export const CONFLICT_ERROR_CODE = HYDRANIUM_ERROR_CODES.conflict;

/** Structured payload carried in {@link ConflictError.data}. */
export interface ConflictErrorData extends HydraniumMessageData {
   readonly uri: string;
   /** The base version the caller authored against. */
   readonly baseVersion: ModelVersion;
   /** The server's current text-document version at the time of the throw. */
   readonly actualVersion: TextVersion;
}

/**
 * Thrown by a client session's `update` / `save` when the caller-
 * supplied base version no longer matches the server's current text-
 * document version for the same URI — i.e. the snapshot the caller
 * authored against has been superseded by an intervening edit.
 *
 * Extends vscode-jsonrpc's {@link ResponseError} so the typed
 * {@link ConflictErrorData} payload rides on the standard JSON-RPC
 * error envelope (`code`, `message`, `data`) — all three fields are
 * preserved by RPC reconstruction. `createRpcProxy` revives it into
 * this class on the receiving side; a path that does not leaves a
 * plain `ResponseError`, readable through `err.data` only.
 *
 * Detection is driven by the required `baseVersion` field of every write
 * request; a caller with no meaningful base version passes
 * `'any'` and gets no gating.
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
   constructor(uri: string, baseVersion: ModelVersion, actualVersion: TextVersion) {
      // The identity rides alongside the typed payload rather than replacing
      // it: `isConflictError`'s name check is surface an adopter may bind, so
      // adding the identity widens the payload rather than reshaping it.
      super(CONFLICT_ERROR_CODE, STALE_BASE_VERSION_UPDATE.format({ uri }), {
         uri,
         baseVersion,
         actualVersion,
         ...messageData(STALE_BASE_VERSION_UPDATE, { uri })
      });
      this.name = 'ConflictError';
      // ResponseError's constructor calls `Object.setPrototypeOf(this,
      // ResponseError.prototype)` to keep its own prototype chain intact across
      // transpilation targets; that resets us to ResponseError, hiding the
      // ConflictError-specific getters. Restore the prototype here so
      // `err.uri` / `.baseVersion` / `.actualVersion` resolve through this
      // class.
      Object.setPrototypeOf(this, ConflictError.prototype);
   }

   get uri(): string {
      return this.data!.uri;
   }

   /**
    * The base version the caller authored against.
    *
    * Must not be renamed to `expected`, nor its sibling to `actual`: a test
    * reporter reads an error carrying both as an assertion failure, and
    * vitest's formatter then ASSIGNS to them, which throws on an accessor and
    * replaces the real failure with a `TypeError`.
    */
   get baseVersion(): ModelVersion {
      return this.data!.baseVersion;
   }

   /** The server's version at the time of the throw. Not `actual` — see {@link baseVersion}. */
   get actualVersion(): TextVersion {
      return this.data!.actualVersion;
   }
}

/**
 * JSON-RPC code for {@link SessionClosedError}, beside {@link CONFLICT_ERROR_CODE}
 * and for the same reason: the code survives reconstruction, the class does not.
 */
export const SESSION_CLOSED_ERROR_CODE = HYDRANIUM_ERROR_CODES.sessionClosed;
/** JSON-RPC code for {@link DocumentNotOpenError}. */
export const DOCUMENT_NOT_OPEN_ERROR_CODE = HYDRANIUM_ERROR_CODES.documentNotOpen;
/** JSON-RPC code for {@link DuplicateClientIdError}. */
export const DUPLICATE_CLIENT_ID_ERROR_CODE = HYDRANIUM_ERROR_CODES.duplicateClientId;
/** JSON-RPC code for {@link ReservedClientIdError}. */
export const RESERVED_CLIENT_ID_ERROR_CODE = HYDRANIUM_ERROR_CODES.reservedClientId;

/**
 * The catalogue declaration behind {@link SessionClosedError}'s default
 * sentence. It names no client id: the sentence can reach an end user, and the
 * id stays in {@link SessionClosedErrorData.clientId} for whoever needs it.
 */
export const SESSION_CLOSED = defineMessage('hydranium/protocol/session-closed', 'The editing session has ended.');

/** Structured payload carried in {@link SessionClosedError.data}. */
export interface SessionClosedErrorData extends HydraniumMessageData {
   readonly clientId: string;
}

/**
 * Thrown by every call on a client session after it ended, and by an open that
 * was still in flight when its session ended: by the server for its sessions,
 * and by a client-side `DataSession` once disposed, so a caller handles both
 * the same way. A caller recognises it with {@link isSessionClosedError}, never
 * by its sentence.
 */
export class SessionClosedError extends ResponseError<SessionClosedErrorData> {
   /**
    * `message` replaces the default English, for a caller that knows more than
    * that the session is gone. The identity stays {@link SESSION_CLOSED}'s, so a
    * translating renderer renders the catalogue sentence in its place.
    */
   constructor(clientId: string, message = SESSION_CLOSED.format()) {
      super(SESSION_CLOSED_ERROR_CODE, message, { clientId, ...messageData(SESSION_CLOSED) });
      this.name = 'SessionClosedError';
      // `ResponseError` resets the prototype to its own; see `ConflictError`.
      Object.setPrototypeOf(this, SessionClosedError.prototype);
   }

   get clientId(): string {
      return this.data!.clientId;
   }
}

/**
 * The catalogue declaration behind {@link DocumentNotOpenError}'s sentence. The
 * client id stays in {@link DocumentNotOpenErrorData.clientId}.
 */
export const DOCUMENT_NOT_OPEN = defineMessage(
   'hydranium/protocol/document-not-open',
   'The document {uri} is not open in this editing session.'
);

/** Structured payload carried in {@link DocumentNotOpenError.data}. */
export interface DocumentNotOpenErrorData extends HydraniumMessageData {
   readonly uri: string;
   readonly clientId: string;
}

/**
 * Thrown when a client session writes a document it does not have open.
 *
 * A session writes only what it has open, so this is the answer both to a write
 * that never opened and to one whose open was closed underneath it — by the
 * session itself, or by the document being deleted.
 */
export class DocumentNotOpenError extends ResponseError<DocumentNotOpenErrorData> {
   constructor(uri: string, clientId: string) {
      super(DOCUMENT_NOT_OPEN_ERROR_CODE, DOCUMENT_NOT_OPEN.format({ uri }), {
         uri,
         clientId,
         ...messageData(DOCUMENT_NOT_OPEN, { uri })
      });
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
 * The catalogue declaration behind {@link DuplicateClientIdError}'s sentence.
 * The client id stays in {@link DuplicateClientIdErrorData.clientId}.
 */
export const DUPLICATE_CLIENT_ID = defineMessage(
   'hydranium/protocol/duplicate-client-id',
   'Could not start an editing session: its identifier is still in use by another editor.'
);

/** Structured payload carried in {@link DuplicateClientIdError.data}. */
export interface DuplicateClientIdErrorData extends HydraniumMessageData {
   readonly clientId: string;
}

/**
 * Thrown when a client session is started under an id that is already live in
 * the process. The id frees up once its holder ends or closes its last
 * document, so a caller may retry.
 *
 * Ids are unique process-wide because the id is also the author label on every
 * version and the key a client recognises its own echoes by; two participants
 * sharing one would each take the other's writes for their own.
 */
export class DuplicateClientIdError extends ResponseError<DuplicateClientIdErrorData> {
   constructor(clientId: string) {
      super(DUPLICATE_CLIENT_ID_ERROR_CODE, DUPLICATE_CLIENT_ID.format(), { clientId, ...messageData(DUPLICATE_CLIENT_ID) });
      this.name = 'DuplicateClientIdError';
      Object.setPrototypeOf(this, DuplicateClientIdError.prototype);
   }

   get clientId(): string {
      return this.data!.clientId;
   }
}

/**
 * Thrown when a client session is started under an id the framework reserves
 * for one of its own participants. A reserved id never frees up, so a caller
 * that retries on {@link DuplicateClientIdError} stops on this one.
 *
 * It carries no message identity: a host that picks a reserved id has a bug,
 * and no sentence addressed to an end user is true for it.
 */
export class ReservedClientIdError extends ResponseError<{ readonly clientId: string }> {
   constructor(clientId: string) {
      super(RESERVED_CLIENT_ID_ERROR_CODE, `Client id ${clientId} is reserved for a framework participant`, { clientId });
      this.name = 'ReservedClientIdError';
      Object.setPrototypeOf(this, ReservedClientIdError.prototype);
   }

   get clientId(): string {
      return this.data!.clientId;
   }
}

/**
 * Rebuilds one typed error from the `data` that crossed the wire, or
 * `undefined` when `data` lacks the fields the class reads.
 */
type ProtocolErrorReviver = (data: Readonly<Record<string, unknown>>) => ResponseError<unknown> | undefined;

/** One entry per typed error class, keyed by its code; a class without one reaches a caller as a plain `ResponseError`. */
const PROTOCOL_ERROR_REVIVERS: ReadonlyMap<number, ProtocolErrorReviver> = new Map<number, ProtocolErrorReviver>([
   [
      CONFLICT_ERROR_CODE,
      ({ uri, baseVersion, actualVersion }) =>
         typeof uri === 'string' && typeof baseVersion === 'number' && typeof actualVersion === 'number'
            ? new ConflictError(uri, asModelVersion(baseVersion), actualVersion)
            : undefined
   ],
   [SESSION_CLOSED_ERROR_CODE, ({ clientId }) => (typeof clientId === 'string' ? new SessionClosedError(clientId) : undefined)],
   [
      DOCUMENT_NOT_OPEN_ERROR_CODE,
      ({ uri, clientId }) => (typeof uri === 'string' && typeof clientId === 'string' ? new DocumentNotOpenError(uri, clientId) : undefined)
   ],
   [DUPLICATE_CLIENT_ID_ERROR_CODE, ({ clientId }) => (typeof clientId === 'string' ? new DuplicateClientIdError(clientId) : undefined)],
   [RESERVED_CLIENT_ID_ERROR_CODE, ({ clientId }) => (typeof clientId === 'string' ? new ReservedClientIdError(clientId) : undefined)]
]);

/**
 * Whether `error` is a `ResponseError` from any copy of `vscode-jsonrpc`. An
 * install holds several copies, and `instanceof` recognises only its own. An
 * error that merely carries an integer `code` has no `toJson`, and is not one.
 */
export function isResponseError(error: unknown): error is ResponseError<unknown> {
   return (
      error instanceof Error && 'code' in error && Number.isInteger(error.code) && 'toJson' in error && typeof error.toJson === 'function'
   );
}

/**
 * `error` as an instance of the typed error class its code names, with its
 * message, data and stack kept, or `error` itself when its code names none or
 * its data lacks the fields that class reads.
 * An RPC reconstructs every rejection as a plain `ResponseError`, which has
 * none of the class getters.
 */
export function reviveProtocolError(error: unknown): unknown {
   if (!isResponseError(error) || error.data === null || typeof error.data !== 'object') {
      return error;
   }
   const revived = PROTOCOL_ERROR_REVIVERS.get(error.code)?.({ ...error.data });
   if (!revived) {
      return error;
   }
   return Object.assign(revived, { message: error.message, data: error.data, stack: error.stack });
}

/**
 * Whether `error` is a {@link SessionClosedError}: by name in-process, by code
 * when it arrives as a plain `ResponseError`, through a path that does not
 * {@link reviveProtocolError revive} it.
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

/** Whether `error` is a {@link ReservedClientIdError}; see {@link isSessionClosedError}. */
export function isReservedClientIdError(error: unknown): error is ReservedClientIdError {
   return hasErrorIdentity(error, 'ReservedClientIdError', RESERVED_CLIENT_ID_ERROR_CODE);
}

function hasErrorIdentity(error: unknown, name: string, code: number): boolean {
   return error instanceof Error && (error.name === name || (error as Partial<ResponseError<unknown>>).code === code);
}

/** Marker substring present in every {@link ConflictError} message, used by
 *  {@link isConflictError} as a fallback when a transport re-wraps the error
 *  and drops the JSON-RPC code. */
const CONFLICT_ERROR_MESSAGE_MARKER = ': it was made to an older version of the document';

/**
 * Type guard for {@link ConflictError}. Detection ladder:
 *
 *  1. `error.name === 'ConflictError'` — direct in-process throw, no
 *     RPC round-trip.
 *  2. `(error as ResponseError).code === CONFLICT_ERROR_CODE` — the
 *     canonical wire-side check; the JSON-RPC `code` field is preserved
 *     across reconstruction, so any adopter catching after an RPC call
 *     hits this branch.
 *  3. `error.message` contains the marker {@link STALE_BASE_VERSION_UPDATE}'s
 *     English carries — fallback for transports that re-wrap the message
 *     and drop the code (rare).
 *
 * `instanceof ConflictError` alone returns `false` on a rejection that was
 * not {@link reviveProtocolError revived}, so callers do not use it.
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
