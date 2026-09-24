/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * Phrases that mean a call lost its connection. Matched on the message because
 * the condition surfaces in shapes that share no discriminator:
 *
 * - a **throw** from `throwIfClosedOrDisposed` (`Connection is disposed.` /
 *   `Connection is closed.`), a `ConnectionError` raised synchronously by
 *   `sendRequest` / `sendNotification` and by `RemoteConsole.send`;
 * - a **rejection** of an already-issued request (`Pending response rejected
 *   since connection got disposed`), a `ResponseError` produced when the
 *   pending-response map is drained on teardown;
 * - a **write into a destroyed transport** (`Cannot call write after a stream
 *   was destroyed`), Node's own error for a message the writer queued before
 *   the connection was disposed and flushed after its stream was destroyed.
 *   A notification rejects with Node's error itself, which
 *   {@link isDestroyedStreamError} catches by its code; a request rejects with
 *   a `ResponseError` that copies only the message, so the phrase is needed
 *   too.
 *
 * The typed errors come from different classes carrying codes from different
 * enums, so no single code check covers them. Kept lowercase-normalised and
 * anchored on `connection` or `stream` so an unrelated "disposed" message
 * cannot match.
 */
const CONNECTION_GONE_PATTERNS = [
   /connection is disposed/,
   /connection is closed/,
   /connection got disposed/,
   /connection got closed/,
   /after a stream was destroyed/
];

const DESTROYED_STREAM_CODE = 'ERR_STREAM_DESTROYED';

function isDestroyedStreamError(err: unknown): boolean {
   return err instanceof Error && 'code' in err && err.code === DESTROYED_STREAM_CODE;
}

/**
 * Whether `err` means "the peer is gone", as opposed to a genuine failure of
 * the operation.
 *
 * The two are indistinguishable at the call site otherwise, and callers act on
 * the answer: a gone peer is logged at `debug` or dropped, a genuine failure is
 * logged at `error` or re-raised as an unhandled rejection. Pushing an edit to
 * a language client that has already disconnected is a no-op, not a fault — it
 * happens on every ordinary shutdown — so a `false` here turns routine teardown
 * into errors that look like they need investigation. A `true` for a real
 * `applyEdit` failure (the client refused, the request malformed) hides it.
 *
 * Callers that only need to *survive* a dead connection rather than classify it
 * should just catch — see `LspLogger.emit`, whose fallback path does exactly
 * that, since a logger has nowhere to report a logging failure anyway.
 */
export function isConnectionGoneError(err: unknown): boolean {
   if (isDestroyedStreamError(err)) {
      return true;
   }
   const message = err instanceof Error ? err.message : String(err);
   const normalized = message.toLowerCase();
   return CONNECTION_GONE_PATTERNS.some(pattern => pattern.test(normalized));
}
