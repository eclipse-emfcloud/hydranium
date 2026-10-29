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
 */
export const STALE_BASE_VERSION_UPDATE = defineMessage(
   'hydranium/protocol/stale-base-version-update',
   'The edit to {uri} was not applied: it was made to an older version of the document.'
);

/**
 * {@link STALE_BASE_VERSION_UPDATE}'s counterpart for an editor's save the
 * server refused, since the editor's buffer is not the text it holds.
 */
export const STALE_BASE_VERSION_SAVE = defineMessage(
   'hydranium/protocol/stale-base-version-save',
   'The save of {uri} was not applied: it was made to an older version of the document.'
);

/**
 * Every JSON-RPC error code the framework raises, from any package, keyed by
 * the error it identifies.
 *
 * The framework reserves the block 42000 to 42999 for these, and an adopter's
 * own codes stay outside it: after an RPC the proxy revives an error by its
 * code, so an adopter's error carrying one of these can read as the
 * framework's. A new code takes the next unused number in the block, whichever
 * package raises it, and is declared here, where tests hold every code distinct
 * and inside the block.
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
   reservedClientId: 42007,
   saveFailed: 42008,
   documentSyntaxError: 42009
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
   /**
    * The document whose version moved. A write of several documents names
    * the first stale one in request order, and others may be stale too.
    */
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
 * plain `ResponseError`, readable through `err.data` only and refused
 * by {@link isConflictError}.
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
   /** `message` words what was refused: an edit, or with {@link STALE_BASE_VERSION_SAVE} a save. */
   constructor(
      uri: string,
      baseVersion: ModelVersion,
      actualVersion: TextVersion,
      message: typeof STALE_BASE_VERSION_UPDATE | typeof STALE_BASE_VERSION_SAVE = STALE_BASE_VERSION_UPDATE
   ) {
      // The identity rides alongside the typed payload rather than replacing
      // it. The getters, the guard and the reviver read the payload's fields,
      // so adding the identity widens the payload rather than reshaping it.
      super(CONFLICT_ERROR_CODE, message.format({ uri }), {
         uri,
         baseVersion,
         actualVersion,
         ...messageData(message, { uri })
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

   /** The document whose version moved, see {@link ConflictErrorData.uri}. */
   get uri(): string {
      return this.data!.uri;
   }

   /**
    * The base version the caller authored against. Not `expected`, and its
    * sibling not `actual`: a test reporter reads that pair as an assertion
    * failure and reports nothing of the real one.
    */
   get baseVersion(): ModelVersion {
      return this.data!.baseVersion;
   }

   /** The server's version at the time of the throw. Not `actual`, see {@link baseVersion}. */
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
/** JSON-RPC code for {@link SaveFailedError}. */
export const SAVE_FAILED_ERROR_CODE = HYDRANIUM_ERROR_CODES.saveFailed;
/** JSON-RPC code for {@link DocumentSyntaxError}. */
export const DOCUMENT_SYNTAX_ERROR_CODE = HYDRANIUM_ERROR_CODES.documentSyntaxError;

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
 * The catalogue declaration behind {@link SaveFailedError}'s message. Its
 * `failures` names each document with the writer's own reason, which stays as
 * written.
 */
export const SAVE_FAILED = defineMessage('hydranium/protocol/save-failed', 'Could not save {failures}.');

/** One document a save could not write, and why. */
export interface SaveFailure {
   readonly uri: string;
   readonly reason: string;
}

/** Structured payload carried in {@link SaveFailedError.data}. */
export interface SaveFailedErrorData extends HydraniumMessageData {
   readonly failures: readonly SaveFailure[];
}

/**
 * Thrown by a save that could not write one or more of its documents. A save
 * of several documents writes the others, so the files on disk can be a mix
 * until a later save succeeds.
 */
export class SaveFailedError extends ResponseError<SaveFailedErrorData> {
   constructor(failures: readonly SaveFailure[]) {
      const named = failures.map(failure => `${failure.uri} (${failure.reason})`).join(', ');
      super(SAVE_FAILED_ERROR_CODE, SAVE_FAILED.format({ failures: named }), {
         failures,
         ...messageData(SAVE_FAILED, { failures: named })
      });
      this.name = 'SaveFailedError';
      Object.setPrototypeOf(this, SaveFailedError.prototype);
   }

   get failures(): readonly SaveFailure[] {
      return this.data!.failures;
   }
}

/** The catalogue declaration behind {@link DocumentSyntaxError}'s sentence. */
export const DOCUMENT_SYNTAX_ERROR = defineMessage(
   'hydranium/protocol/document-syntax-error',
   'The edit to {uri} was not applied: the document has a syntax error. Fix it in the text first.'
);

/** Structured payload carried in {@link DocumentSyntaxError.data}. */
export interface DocumentSyntaxErrorData extends HydraniumMessageData {
   readonly uri: string;
}

/**
 * Thrown when a write would serialize a model over text that does not parse.
 * A model read from a build with lexer or parser errors lacks what the parser
 * skipped, so writing it would delete that text. A client session refuses a
 * model write while the document's last build has such errors and its text
 * is not blank, unless the write is a `restore`. A diagram refuses an edit,
 * undo or redo that would write such a document, or whose merge or collision
 * reads one. A client's write of text is not refused, since that is how the
 * text is repaired.
 */
export class DocumentSyntaxError extends ResponseError<DocumentSyntaxErrorData> {
   constructor(uri: string) {
      super(DOCUMENT_SYNTAX_ERROR_CODE, DOCUMENT_SYNTAX_ERROR.format({ uri }), { uri, ...messageData(DOCUMENT_SYNTAX_ERROR, { uri }) });
      this.name = 'DocumentSyntaxError';
      Object.setPrototypeOf(this, DocumentSyntaxError.prototype);
   }

   get uri(): string {
      return this.data!.uri;
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
      data => (hasConflictFields(data) ? new ConflictError(data.uri, asModelVersion(data.baseVersion), data.actualVersion) : undefined)
   ],
   [SESSION_CLOSED_ERROR_CODE, data => (hasClientId(data) ? new SessionClosedError(data.clientId) : undefined)],
   [DOCUMENT_NOT_OPEN_ERROR_CODE, data => (hasDocumentNotOpenFields(data) ? new DocumentNotOpenError(data.uri, data.clientId) : undefined)],
   [DUPLICATE_CLIENT_ID_ERROR_CODE, data => (hasClientId(data) ? new DuplicateClientIdError(data.clientId) : undefined)],
   [RESERVED_CLIENT_ID_ERROR_CODE, data => (hasClientId(data) ? new ReservedClientIdError(data.clientId) : undefined)],
   [SAVE_FAILED_ERROR_CODE, data => (hasSaveFailures(data) ? new SaveFailedError(data.failures) : undefined)],
   [DOCUMENT_SYNTAX_ERROR_CODE, data => (hasUri(data) ? new DocumentSyntaxError(data.uri) : undefined)]
]);

// One check per class of the fields its getters read, run by its reviver on
// `data` and by its guard on the error, through the getters.
function hasConflictFields(value: unknown): value is { uri: string; baseVersion: number; actualVersion: TextVersion } {
   return (
      isRecord(value) && typeof value.uri === 'string' && typeof value.baseVersion === 'number' && typeof value.actualVersion === 'number'
   );
}

function hasClientId(value: unknown): value is { clientId: string } {
   return isRecord(value) && typeof value.clientId === 'string';
}

function hasDocumentNotOpenFields(value: unknown): value is { uri: string; clientId: string } {
   return isRecord(value) && typeof value.uri === 'string' && typeof value.clientId === 'string';
}

function hasUri(value: unknown): value is { uri: string } {
   return isRecord(value) && typeof value.uri === 'string';
}

function hasSaveFailures(value: unknown): value is { failures: SaveFailure[] } {
   return isRecord(value) && isSaveFailureList(value.failures);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
   return typeof value === 'object' && value !== null;
}

function isSaveFailureList(value: unknown): value is SaveFailure[] {
   return (
      Array.isArray(value) &&
      value.every(
         (failure: unknown) =>
            typeof failure === 'object' &&
            failure !== null &&
            'uri' in failure &&
            typeof failure.uri === 'string' &&
            'reason' in failure &&
            typeof failure.reason === 'string'
      )
   );
}

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
 * The error the JSON text `json` describes, as `JSON.stringify(error.toJson())`
 * writes it, revived to its typed class as {@link reviveProtocolError} does, or
 * `undefined` when `json` is not a JSON-RPC error envelope. For a transport
 * that carries the error as text, such as a GLSP `RejectAction`'s `detail`.
 */
export function reviveProtocolErrorJson(json: string): ResponseError<unknown> | undefined {
   let envelope: unknown;
   try {
      envelope = JSON.parse(json);
   } catch {
      return undefined;
   }
   if (typeof envelope !== 'object' || envelope === null || !('code' in envelope) || !('message' in envelope)) {
      return undefined;
   }
   const { code, message } = envelope;
   if (typeof code !== 'number' || !Number.isInteger(code) || typeof message !== 'string') {
      return undefined;
   }
   const revived = reviveProtocolError(new ResponseError(code, message, 'data' in envelope ? envelope.data : undefined));
   return isResponseError(revived) ? revived : undefined;
}

/**
 * Mark `errorClass`'s prototype with a brand its guard checks, so every
 * instance and every subclass carries it, and nothing else does. `Symbol.for`
 * gives each copy of this package the same symbol, which `instanceof` does
 * not, so the key must stay the same across releases.
 */
function brand(errorClass: { readonly prototype: object }, name: string): symbol {
   const key = Symbol.for(`hydranium/protocol/${name}`);
   Object.defineProperty(errorClass.prototype, key, { value: true });
   return key;
}

const CONFLICT_BRAND = brand(ConflictError, 'ConflictError');
const SESSION_CLOSED_BRAND = brand(SessionClosedError, 'SessionClosedError');
const DOCUMENT_NOT_OPEN_BRAND = brand(DocumentNotOpenError, 'DocumentNotOpenError');
const DUPLICATE_CLIENT_ID_BRAND = brand(DuplicateClientIdError, 'DuplicateClientIdError');
const RESERVED_CLIENT_ID_BRAND = brand(ReservedClientIdError, 'ReservedClientIdError');
const SAVE_FAILED_BRAND = brand(SaveFailedError, 'SaveFailedError');
const DOCUMENT_SYNTAX_ERROR_BRAND = brand(DocumentSyntaxError, 'DocumentSyntaxError');

/**
 * Whether `error` is a {@link SessionClosedError} whose getters read valid
 * fields: one thrown, or one {@link reviveProtocolError revived}, from any
 * copy of this package, or a subclass. A bare `ResponseError` is not one,
 * whatever its name and fields, since it lacks the class's brand.
 * `createRpcProxy` revives every rejection, so only a caller on a connection
 * of its own needs to revive first. Each guard below works the same way.
 */
export function isSessionClosedError(error: unknown): error is SessionClosedError {
   return hasBrand(error, SESSION_CLOSED_BRAND) && hasClientId(error);
}

/** Whether `error` is a {@link DocumentNotOpenError}. See {@link isSessionClosedError}. */
export function isDocumentNotOpenError(error: unknown): error is DocumentNotOpenError {
   return hasBrand(error, DOCUMENT_NOT_OPEN_BRAND) && hasDocumentNotOpenFields(error);
}

/** Whether `error` is a {@link DuplicateClientIdError}. See {@link isSessionClosedError}. */
export function isDuplicateClientIdError(error: unknown): error is DuplicateClientIdError {
   return hasBrand(error, DUPLICATE_CLIENT_ID_BRAND) && hasClientId(error);
}

/** Whether `error` is a {@link ReservedClientIdError}. See {@link isSessionClosedError}. */
export function isReservedClientIdError(error: unknown): error is ReservedClientIdError {
   return hasBrand(error, RESERVED_CLIENT_ID_BRAND) && hasClientId(error);
}

/** Whether `error` is a {@link SaveFailedError}. See {@link isSessionClosedError}. */
export function isSaveFailedError(error: unknown): error is SaveFailedError {
   return hasBrand(error, SAVE_FAILED_BRAND) && hasSaveFailures(error);
}

/** Whether `error` is a {@link DocumentSyntaxError}. See {@link isSessionClosedError}. */
export function isDocumentSyntaxError(error: unknown): error is DocumentSyntaxError {
   return hasBrand(error, DOCUMENT_SYNTAX_ERROR_BRAND) && hasUri(error);
}

/** Whether `error` is a {@link ConflictError}. See {@link isSessionClosedError}. */
export function isConflictError(error: unknown): error is ConflictError {
   return hasBrand(error, CONFLICT_BRAND) && hasConflictFields(error);
}

/**
 * Whether `error` carries the brand `key` and the `data` record its getters
 * read, so a guard can check the fields through them. A copy whose class
 * lacks a getter fails that check, since the brand alone is public.
 */
function hasBrand(error: unknown, key: symbol): error is ResponseError<unknown> {
   return isResponseError(error) && Reflect.get(error, key) === true && isRecord(error.data);
}
