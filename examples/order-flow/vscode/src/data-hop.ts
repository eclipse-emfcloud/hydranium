/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * The extension host's end of the data head.
 *
 * A webview has no `net`, so the extension host holds the socket to the
 * data-server and moves whole JSON-RPC messages between it and the webview over
 * GLSP's own `Messenger` — one hop shared with the diagram, so both share a
 * lifecycle and a dispose rather than opening a second channel for the form.
 *
 * Every piece below the host is framework or shared-client code:
 * `relayToPostMessageChannel` pumps the socket onto the channel,
 * `createExtensionSideChannel` presents the `Messenger` as that channel, and the
 * webview's `createRpcProxy` / `DataSession` are unaware any of it exists.
 * What is left here is only what needs `vscode` and `net`.
 */

import type { GlspVscodeConnector } from '@eclipse-glsp/vscode-integration';
// The MODULE, not the client barrel, and this one is load-bearing at RUNTIME
// rather than merely tidy. The barrel re-exports the `.process` diagram
// definition, whose `@eclipse-glsp/client` graph reaches `.css` files; Node
// cannot `require` a stylesheet, so importing the barrel from anything the
// EXTENSION HOST loads kills activation outright with
// `Unexpected token '.'` — the first character of a CSS selector, reported with
// no hint that a stylesheet is involved. Measured, not guessed: the throw comes
// from `@eclipse-glsp/client/css/autocomplete-palette.css`.
import { createExtensionSideChannel, type MessengerLike } from '@hydranium/example-order-flow-client/lib/data/order-flow-messenger-channel';
import { relayToPostMessageChannel, type MessageRelay, type RelayTransport } from '@hydranium/protocol';
import * as net from 'node:net';
import type { Disposable } from 'vscode-jsonrpc';
// `/node` because the extension host is Node and holds the socket. The webview
// imports `/browser`; the package root installs no runtime abstraction layer.
import { SocketMessageReader, SocketMessageWriter } from 'vscode-jsonrpc/node';

/**
 * The real `Messenger` type, taken from the connector's getter rather than by
 * importing `vscode-messenger`.
 *
 * Deriving it here means the example declares no dependency it reaches only
 * transitively, and — more usefully — it makes the assertion below load-bearing:
 * it is checked against whatever `@eclipse-glsp/vscode-integration` actually
 * exposes, so a GLSP bump that changes the messenger's shape breaks the build
 * here instead of at runtime in a webview.
 */
export type GlspMessenger = GlspVscodeConnector['messenger'];

/** The participant type that messenger addresses — a registered webview, or the host. */
export type GlspParticipant = Parameters<GlspMessenger['sendNotification']>[1];

/**
 * Compile-time proof that the real `Messenger` satisfies the shared client's
 * structural {@link MessengerLike}.
 *
 * `MessengerLike` restates `vscode-messenger`'s two methods instead of importing
 * them, which is what keeps the shared client host-neutral and its test double
 * faithful — but a restatement is only as good as a check against the original,
 * and this line is that check. Without it the claim rests on having read
 * `messenger.d.ts`. It costs nothing at runtime: an unused type-level identity
 * function.
 */
const _messengerConformsToMessengerLike: (messenger: GlspMessenger) => MessengerLike<GlspParticipant> = messenger => messenger;
void _messengerConformsToMessengerLike;

/** Connect to the data-server's socket and present it as a relay's framed side. */
export function openDataServerTransport(port: number, host = '127.0.0.1'): Promise<RelayTransport> {
   return new Promise<RelayTransport>((resolve, reject) => {
      const socket = net.createConnection({ port, host });
      socket.once('error', reject);
      socket.once('connect', () => {
         // Drop the construction-time handler so a later socket error goes to
         // the relay's reader rather than rejecting an already-settled promise.
         socket.removeAllListeners('error');
         resolve({
            reader: new SocketMessageReader(socket),
            writer: new SocketMessageWriter(socket),
            dispose: () => socket.destroy()
         });
      });
   });
}

/** What {@link connectDataHead} needs from the host. */
export interface DataHeadConnectionOptions {
   /** GLSP's messenger, shared with the diagram. */
   readonly messenger: GlspMessenger;
   /** The registered webview this connection serves. */
   readonly webview: GlspParticipant;
   /**
    * Resolve the data-server's listening port. Called once per connection
    * generation, so a restarted server is re-discovered rather than cached —
    * the language server binds a fresh ephemeral port each start.
    */
   readonly findPort: () => Promise<number>;
   /** Observe the webview going away, so the relay releases with it. */
   readonly onWebviewDisposed?: (listener: () => void) => Disposable;
   readonly reportError?: (error: unknown, context: string) => void;
}

/**
 * Wire one webview to the data head.
 *
 * The returned relay's `onClose` is the host's ONLY notice that the framed side
 * died — a `PostMessageChannel` has no `close()`, so a dead data-server is
 * invisible to the webview, whose pending requests would otherwise hang with no
 * rejection. Dispose or reload the webview on that event; doing nothing is the
 * one wrong choice.
 */
export function connectDataHead(options: DataHeadConnectionOptions): MessageRelay {
   const channel = createExtensionSideChannel(options.messenger, options.webview, options.onWebviewDisposed);
   return relayToPostMessageChannel(channel, async () => openDataServerTransport(await options.findPort()), {
      reportError: options.reportError
   });
}
