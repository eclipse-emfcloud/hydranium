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
 * a `vscode-messenger` hop, typically GLSP's own, so a diagram and a data
 * webview share one lifecycle and one dispose.
 */

import { relayToPostMessageChannel, type MessageRelay, type RelayTransport, type ResolvedMessage } from '@hydranium/protocol';
import * as net from 'node:net';
import type { Disposable } from 'vscode-jsonrpc';
// `/node` because the extension host is Node and holds the socket. The webview
// imports `/browser`; the package root installs no runtime abstraction layer.
import { SocketMessageReader, SocketMessageWriter } from 'vscode-jsonrpc/node';
import { createExtensionSideChannel, type MessengerLike } from '../messenger-channel';

/** Connect to a head's socket and present it as a relay's framed side. */
export function openSocketTransport(port: number, host = '127.0.0.1'): Promise<RelayTransport> {
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

/** What {@link connectDataServer} needs from the host. */
export interface DataServerConnectionOptions<TParticipant> {
   /**
    * The extension-side messenger, typically `GlspVscodeConnector.messenger`.
    * It must be constructed with `ignoreHiddenViews: false`, or a hidden
    * webview misses every message the data-server sends it.
    */
   readonly messenger: MessengerLike<TParticipant>;
   /** The registered webview this connection serves. */
   readonly webview: TParticipant;
   /**
    * Resolve the data-server's listening port. Called once per connection
    * generation, so a restarted server is re-discovered rather than cached —
    * the language server binds a fresh ephemeral port each start.
    */
   readonly findPort: () => Promise<number>;
   /** Observe the webview going away, so the relay releases with it. */
   readonly onWebviewDisposed?: (listener: () => void) => Disposable;
   /**
    * Surface a relay failure. `reported` is a complete sentence plus the
    * identity needed to render it in another language — the extension host holds
    * the locale, so it renders and the relay does not.
    */
   readonly reportError?: (error: unknown, reported: ResolvedMessage) => void;
}

/**
 * Wire one webview to the data head.
 *
 * The returned relay's `onClose` is the host's ONLY notice that the framed side
 * died — a `PostMessageChannel` has no `close()`, so a dead data-server is
 * invisible to the webview, whose pending requests would otherwise hang with no
 * rejection. Tell the webview, whose `WebviewDataPort.connectionLost` rejects
 * them, or dispose the webview; doing nothing is the one wrong choice.
 */
export function connectDataServer<TParticipant>(options: DataServerConnectionOptions<TParticipant>): MessageRelay {
   const channel = createExtensionSideChannel(options.messenger, options.webview, options.onWebviewDisposed);
   return relayToPostMessageChannel(channel, async () => openSocketTransport(await options.findPort()), {
      reportError: options.reportError
   });
}
