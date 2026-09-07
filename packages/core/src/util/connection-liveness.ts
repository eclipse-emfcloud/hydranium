/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * Phrases `vscode-jsonrpc` uses when a call loses its connection. Matched on the
 * message because the condition surfaces in two different shapes:
 *
 * - a **throw** from `throwIfClosedOrDisposed` (`Connection is disposed.` /
 *   `Connection is closed.`), a `ConnectionError` raised synchronously by
 *   `sendRequest` / `sendNotification` and by `RemoteConsole.send`;
 * - a **rejection** of an already-issued request (`Pending response rejected
 *   since connection got disposed`), a `ResponseError` produced when the
 *   pending-response map is drained on teardown.
 *
 * Both are typed, but they are different error classes carrying codes from
 * different enums, so no single code check covers both. Kept
 * lowercase-normalised and anchored on `connection` so an unrelated "disposed"
 * message cannot match.
 */
const CONNECTION_GONE_PATTERNS = [/connection is disposed/, /connection is closed/, /connection got disposed/, /connection got closed/];

/**
 * Whether `err` means "the peer is gone", as opposed to a genuine failure of
 * the operation.
 *
 * The distinction is a **log-severity** one, and it matters because the two are
 * indistinguishable at the call site otherwise. Pushing an edit to a language
 * client that has already disconnected is a no-op, not a fault — it happens on
 * every ordinary shutdown, and reporting it at `error` turns routine teardown
 * into something that looks like it needs investigation. A real `applyEdit`
 * failure (the client refused, the request malformed) still deserves `error`.
 *
 * Callers that only need to *survive* a dead connection rather than classify it
 * should just catch — see `LspLogger.emit`, whose fallback path does exactly
 * that, since a logger has nowhere to report a logging failure anyway.
 */
export function isConnectionGoneError(err: unknown): boolean {
   const message = err instanceof Error ? err.message : String(err);
   const normalized = message.toLowerCase();
   return CONNECTION_GONE_PATTERNS.some(pattern => pattern.test(normalized));
}
