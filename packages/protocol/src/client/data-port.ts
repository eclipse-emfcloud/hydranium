/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import type { Event, MessageConnection } from 'vscode-jsonrpc';

/**
 * The one thing a host has to supply for the data head: a live JSON-RPC
 * connection to the data server, plus the identity and failure sink that go
 * with it.
 *
 * "Port" in the hexagonal sense — the host implements it, `DataSession`
 * consumes it, and nothing on either side of the boundary imports the other.
 *
 * **This deliberately does NOT wrap the protocol methods.** `createRpcProxy`
 * already takes a promise of a connection and produces the whole typed
 * `DataServerProtocol` surface, so wrapping it would re-derive the framework's
 * pass-throughs in a second place and lose the `as const satisfies keyof`
 * method allowlists, which cannot drift. Everything a form or a tree actually
 * does — the wire contract, the open/watch/update/close sequence, `baseVersion`
 * conflict handling, echo filtering by `sourceClientId` — is host-invariant and
 * lives above this interface. What varies between hosts is exactly the four
 * members below.
 *
 * **Why the transport hop and not merely the protocol.** In a Theia frontend
 * the client *is* the RPC endpoint and holds a `MessageConnection` directly. In
 * a VS Code webview the client is a browser sandbox with no `net`, no reach into
 * the extension host's connection, and only structured-clone `postMessage`. So
 * the port abstracts *establishing* the connection, which lets a webview
 * implementation ride the extension↔webview hop (see
 * `createPostMessageTransport`) while a Theia one opens a channel — and
 * lets both hand back the same `MessageConnection` the RPC machinery expects.
 *
 * Two constraints on an implementation:
 *
 * - **A webview implementation must import `vscode-jsonrpc/browser`**, not the
 *   package root. vscode-jsonrpc 9's root ships no runtime abstraction layer
 *   and throws `No runtime abstraction layer installed` on the first message.
 * - **Return a connection that is already `listen()`ing.** The proxy queues
 *   calls on the promise but never calls `listen` itself.
 */
export interface DataPort {
   /**
    * Stable identity of this client on the data server, passed as `clientId`
    * on every document request.
    *
    * It has to be stable for the session because it is the echo key: an
    * inbound `onDocumentUpdated` carries the originating mutation's
    * `clientId` as `sourceClientId`, and a client that cannot recognise its
    * own echo treats its own write as a concurrent third-party one. It also
    * has to be distinct per client, since it keys the server's per-
    * `(uri, clientId)` watch bucket.
    *
    * Avoid the three values the framework itself uses as sentinels —
    * `'language-client'`, `'unknown'` and `'revert-on-close'`.
    */
   readonly clientId: string;

   /**
    * Open the transport and hand back a listening `MessageConnection`.
    *
    * Called at most once per connection generation. A rejection is a
    * transport-construction failure and is reported through
    * {@link reportError} by the consumer; it must leave the port reusable, so
    * that a later generation can retry.
    */
   connect(): Promise<MessageConnection>;

   /**
    * Surface a failure to the user in whatever way the host does that — a
    * notification, an output channel, a status entry.
    *
    * It exists because the alternative is worse in both directions: this tier
    * cannot import a host's UI, and swallowing the error makes a dead
    * connection look like an empty model. `context` names what was being
    * attempted, not where in the code it happened.
    */
   reportError(error: unknown, context: string): void;

   /**
    * Fires when the host tears the transport down and the current connection
    * is no longer usable — a language-server restart being the case that
    * forces this to exist, since a restarted server binds new ephemeral ports
    * and nothing re-discovers them.
    *
    * `DataSession` drops its connection generation on this event and
    * builds a fresh one on the next request.
    *
    * A local `Event`, deliberately: nothing here crosses a structured-clone
    * boundary, so the `Disposable` an `Event` hands back is safe even though a
    * `Disposable` on the *wire* would not be.
    */
   readonly onDispose: Event<void>;
}
