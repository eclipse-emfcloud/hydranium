/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { Emitter, type Disposable, type Event, type Message, type MessageReader, type MessageWriter } from 'vscode-jsonrpc';
import type { PostMessageChannel } from './post-message-transport';

/**
 * The framed side of a relay: the reader/writer pair over whatever transport the
 * host actually holds — a TCP socket to the data-server, a child process' stdio,
 * a websocket.
 *
 * Structurally the same pair `PostMessageTransport` exposes, and
 * deliberately so: either can stand on either side of a relay. What differs is
 * only who owns the framing, which is why this tier never needs to know.
 */
export interface RelayTransport {
   readonly reader: MessageReader;
   readonly writer: MessageWriter;
   /** Release the transport. Called when the relay is disposed. */
   dispose?(): void;
}

/** Options for {@link relayToPostMessageChannel}. */
export interface MessageRelayOptions {
   /**
    * Surface a failure the way the host does. Same contract as
    * `DataPort.reportError`: `context` names what was being attempted.
    *
    * A relay has no other way to report — it sits between two transports and
    * owns neither, so a swallowed error here presents as a form that never
    * populates.
    */
   readonly reportError?: (error: unknown, context: string) => void;
}

/** A live relay. Dispose to tear both directions down. */
export interface MessageRelay extends Disposable {
   /**
    * Resolves `true` once messages are flowing in both directions, `false` if
    * opening the framed transport failed or the relay was disposed first.
    *
    * It resolves rather than rejects on failure so that a caller which never
    * awaits it cannot produce an unhandled rejection; the error itself goes to
    * {@link MessageRelayOptions.reportError}. Tests await it to get a
    * deterministic "wiring is done" edge instead of polling.
    */
   readonly wired: Promise<boolean>;

   /**
    * Fires when the framed side goes away — the data-server exiting, the socket
    * erroring, a language-server restart taking its ports with it.
    *
    * **The relay cannot propagate this to the clone hop itself**, and the host
    * has to. {@link PostMessageChannel} is deliberately an input-only contract:
    * it offers `onClose` for observing the pipe but no `close()` for ending it,
    * because a webview's pipe belongs to the webview's lifecycle, not to
    * whoever relays over it. So a framed-side death is invisible to the far
    * end, whose pending requests would otherwise hang forever with no rejection
    * — the far side's `MessageConnection` sees an open pipe and no answer. On
    * this event a host disposes the webview, reloads it, or sends its own
    * "connection lost" notification; doing nothing is the one wrong choice.
    */
   readonly onClose: Event<void>;
}

/**
 * Pump JSON-RPC messages between a framed transport and a structured-clone
 * {@link PostMessageChannel}, decoding neither.
 *
 * This is the extension-host half of the hop whose webview half is
 * `createPostMessageTransport`. A webview has no `net`, so the data-server
 * socket can only be held by the extension host; the host therefore has to move
 * whole messages between a Content-Length-framed socket and a pipe that carries
 * objects. Both sides speak the same JSON-RPC, so this moves messages and adds
 * no semantics — there is no re-proxy in between, and `createRpcProxy` on the far
 * side is unaware the relay exists.
 *
 * **No `MessageConnection` is built here, and that is what keeps the module
 * browser-neutral.** A relay is not a JSON-RPC endpoint: it has no requests of
 * its own, so it needs no message queue, hence no vscode-jsonrpc runtime
 * abstraction layer. `reader.listen` / `writer.write` are enough. The caller
 * imports the entrypoint that frames its own transport (`vscode-jsonrpc/node`
 * for a socket) and the RAL that comes with it; this tier stays neutral and is
 * gated so by `npm run check:neutral`. Contrast
 * `@hydranium/data-client-theia`'s `SocketChannelForwarder`, which does build a
 * connection only to borrow its `onClose`, and pays a Theia dependency for the
 * byte coding this shape does not need.
 *
 * **The race this exists to close.** `openTransport` is asynchronous — a real
 * host discovers a port first, then connects — while the clone pipe is usable
 * immediately. `PostMessageChannel.onMessage` is a plain emitter with no replay,
 * so a message sent during the connect window is dropped outright.
 *
 * It is not enough that a disciplined client awaits its own connection before
 * sending: a host builds the far-side connection and hands it back *without*
 * waiting for the relay, so `DataSession`'s very first call — the readiness
 * handshake — is already in flight while the socket is still opening. Dropping
 * that first request presents as a client hanging forever on connect against a
 * perfectly healthy server.
 *
 * So the subscription is taken **synchronously, before the first await**, and
 * buffers; the hand-off then swaps listeners and replays within one turn of the
 * event loop, which is what makes it impossible for a message to be both
 * buffered and forwarded, or to arrive between the two. Replay is FIFO because
 * order is load-bearing — a `getModelDocument` that overtook its own
 * `openModelDocument` would answer against an unopened document.
 * `@hydranium/client-theia`'s `AbstractSocketForwardingConnectionHandler` carries the
 * same fix for the Theia channel transport.
 */
export function relayToPostMessageChannel(
   channel: PostMessageChannel,
   openTransport: () => Promise<RelayTransport>,
   options: MessageRelayOptions = {}
): MessageRelay {
   const closeEmitter = new Emitter<void>();
   const subscriptions: Disposable[] = [];
   let transport: RelayTransport | undefined;
   let disposed = false;

   // Taken before the first await, so nothing the far side sends during the
   // connect window is lost. See the race note above.
   const buffered: Message[] = [];
   let bufferSubscription: Disposable | undefined = channel.onMessage(message => buffered.push(message));

   const closeFramedSide = (): void => {
      if (disposed) {
         return;
      }
      closeEmitter.fire();
   };

   const wired = (async (): Promise<boolean> => {
      let opened: RelayTransport;
      try {
         opened = await openTransport();
      } catch (error: unknown) {
         bufferSubscription?.dispose();
         bufferSubscription = undefined;
         buffered.length = 0;
         options.reportError?.(error, 'opening the transport to relay');
         closeFramedSide();
         return false;
      }

      if (disposed) {
         // Disposed while connecting: the transport is ours now, so it is ours
         // to release, or the socket outlives the relay that owns it.
         opened.dispose?.();
         return false;
      }
      transport = opened;

      // Synchronous hand-off: drop the buffering listener, wire both
      // directions, then replay. No await in between, so the event loop cannot
      // interleave a message into the gap.
      bufferSubscription?.dispose();
      bufferSubscription = undefined;

      subscriptions.push(
         opened.reader.listen(message => channel.post(message)),
         opened.reader.onClose(() => closeFramedSide()),
         opened.reader.onError(error => {
            options.reportError?.(error, 'reading from the relayed transport');
            closeFramedSide();
         }),
         channel.onMessage(message => {
            void opened.writer.write(message).catch((error: unknown) => {
               options.reportError?.(error, 'writing to the relayed transport');
            });
         })
      );

      const onChannelClose = channel.onClose?.(() => dispose());
      if (onChannelClose) {
         subscriptions.push(onChannelClose);
      }

      for (const message of buffered) {
         void opened.writer.write(message).catch((error: unknown) => {
            options.reportError?.(error, 'replaying a buffered message to the relayed transport');
         });
      }
      buffered.length = 0;

      return true;
   })();

   function dispose(): void {
      if (disposed) {
         return;
      }
      disposed = true;
      bufferSubscription?.dispose();
      bufferSubscription = undefined;
      buffered.length = 0;
      for (const subscription of subscriptions) {
         subscription.dispose();
      }
      subscriptions.length = 0;
      transport?.dispose?.();
      transport = undefined;
      closeEmitter.dispose();
   }

   return {
      wired,
      onClose: closeEmitter.event,
      dispose
   };
}
