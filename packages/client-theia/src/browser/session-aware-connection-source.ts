/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { WebSocketConnectionSource } from '@theia/core/lib/browser/messaging/ws-connection-source';
import { Disposable, DisposableCollection } from '@theia/core/lib/common/disposable';
import { type Event } from '@theia/core/lib/common/event';
import { type AbstractChannel, ForwardingChannel } from '@theia/core/lib/common/message-rpc/channel';
import { Uint8ArrayReadBuffer, Uint8ArrayWriteBuffer } from '@theia/core/lib/common/message-rpc/uint8-array-message-buffer';
import { ConnectionManagementMessages } from '@theia/core/lib/common/messaging/connection-management';
import { injectable, type interfaces } from '@theia/core/shared/inversify';
import { SocketWriteBuffer } from '@theia/core/lib/common/messaging/socket-write-buffer';
import { type ConnectionResilienceOptions } from '../common/connection-resilience-options';
import {
   type ConnectionBufferOverflow,
   createFramedSocketWriteBuffer,
   FramedSocketWriteBuffer,
   supportsConnectionResilience,
   warnConnectionResilienceUnavailable
} from '../common/framed-socket-write-buffer';

/**
 * Sends a message only once the server has confirmed the session, and only
 * behind anything already queued.
 *
 * Theia sends straight away when `socket.connected` is true and buffers
 * otherwise. The gap is that reconnecting sets that flag immediately, while the
 * session is only confirmed a round trip later. A message produced in that
 * window either jumps ahead of older messages still waiting in the buffer, or,
 * if nothing was waiting, goes out on a socket whose channel the server has not
 * attached yet and is discarded by a peer with no listener for it.
 *
 * Losing one or reordering them is equally unrecoverable for anything that
 * applies messages by position. Theia's plugin host keeps a line-indexed copy of
 * every open document, so a single late or missing edit leaves that copy wrong
 * for good, and the next edit past its end fails.
 *
 * The server side needs no equivalent: it adopts its socket and flushes in one
 * synchronous step, so it has no window of this kind.
 */
@injectable()
export class SessionAwareConnectionSource extends WebSocketConnectionSource {
   /**
    * Whether the server has confirmed, on the socket in use right now, that it
    * still holds this frontend's session. A connected socket is not enough:
    * until the handshake is answered the server has not attached its channel to
    * this socket, and a message sent meanwhile reaches a peer with no listener
    * for it and is discarded without a trace.
    */
   protected sessionResumed = false;
   protected sessionListenersAttached = false;

   /**
    * Every connect starts a socket the server has not confirmed yet, including
    * the reconnects socket.io performs on its own. Resetting here rather than on
    * disconnect also covers a connect that follows no clean disconnect event.
    */
   protected override handleSocketConnected(): void {
      this.trackSessionState();
      this.sessionResumed = false;
      super.handleSocketConnected();
   }

   /**
    * Watches the connection handshake for its outcome.
    *
    * Attached once, to the socket socket.io reuses across reconnects, and before
    * the base class adds its own per-negotiation listeners — so this has already
    * recorded the outcome by the time the base class reacts to it by flushing.
    */
   protected trackSessionState(): void {
      if (this.sessionListenersAttached) {
         return;
      }
      this.sessionListenersAttached = true;
      this.socket.on(ConnectionManagementMessages.INITIAL_CONNECT, () => {
         this.sessionResumed = true;
      });
      this.socket.on(ConnectionManagementMessages.RECONNECT, (hasConnection: boolean) => {
         this.sessionResumed = hasConnection;
      });
   }

   /** Whether a message may go out now, as opposed to waiting in the buffer. */
   protected get canSend(): boolean {
      return this.socket.connected && this.sessionResumed;
   }

   protected override createChannel(): AbstractChannel {
      const toDispose = new DisposableCollection();
      const messageHandler = (data: ArrayBuffer | Uint8Array): void => {
         this.onIncomingMessageActivityEmitter.fire();
         if (this.currentChannel) {
            // socket.io hands binary over as ArrayBuffer in the browser.
            const buffer = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
            this.currentChannel.onMessageEmitter.fire(() => new Uint8ArrayReadBuffer(buffer));
         }
      };
      this.socket.on('message', messageHandler);
      toDispose.push(Disposable.create(() => this.socket.off('message', messageHandler)));

      return new ForwardingChannel(
         'any',
         () => toDispose.dispose(),
         () => {
            const result = new Uint8ArrayWriteBuffer();
            // Says only whether the session can carry a message; the buffer decides whether it may
            // go ahead of anything already waiting.
            result.onCommit(buffer => this.framedBuffer.sendOrQueue(this.canSend ? this.socket : undefined, buffer));
            return result;
         }
      );
   }

   /** Fires when the buffer runs out of room, so an adopter can say so rather than just stopping. */
   get onBufferOverflow(): Event<ConnectionBufferOverflow> {
      return this.framedBuffer.onOverflow;
   }

   /**
    * The write buffer Theia injected into the base class.
    *
    * Reached through a structural view rather than as `this.writeBuffer`,
    * because that member is `private` in Theia 1.70 and only became `protected`
    * in 1.71 — and this package compiles against the whole range. The view
    * asserts nothing the versions disagree about: the field is there in both,
    * holding whatever `SocketWriteBuffer` is bound, and the check below is what
    * establishes it is ours.
    */
   protected get framedBuffer(): FramedSocketWriteBuffer {
      const buffer = (this as unknown as { readonly writeBuffer: SocketWriteBuffer }).writeBuffer;
      if (!(buffer instanceof FramedSocketWriteBuffer)) {
         throw new Error('SessionAwareConnectionSource requires FramedSocketWriteBuffer to be bound');
      }
      return buffer;
   }
}

/**
 * Replaces the frontend pieces that decide how outgoing messages survive a
 * reconnect. Every one of them rebinds something Theia's
 * `messagingFrontendModule` already bound, so this belongs in a module loaded
 * into the same container.
 *
 * It must be a `frontendPreload` module rather than a normal frontend module:
 * Theia's preloader resolves `WebSocketConnectionSource` (and with it the write
 * buffer) while loading i18n and OS settings, which happens before any frontend
 * module is loaded. A rebind there would come too late — the instances would
 * already exist. All `frontendPreload` modules, by contrast, are loaded before
 * the preloader constructs anything.
 *
 * Does nothing but warn on a Theia too old to expose the buffer binding, so the
 * package keeps one supported range rather than splitting its floor for this
 * feature. Returns whether the hardening was installed, for an adopter that
 * wants to branch on it.
 */
export function bindConnectionResilience(
   isBound: interfaces.IsBound,
   rebind: interfaces.Rebind,
   options: ConnectionResilienceOptions = {}
): boolean {
   if (!supportsConnectionResilience(isBound)) {
      warnConnectionResilienceUnavailable('frontend');
      return false;
   }
   // Scopes are kept as Theia declares them: one buffer per connection source, one shared socket owner.
   rebind(SocketWriteBuffer).toDynamicValue(() => createFramedSocketWriteBuffer(options.bufferBytes));
   rebind(WebSocketConnectionSource).to(SessionAwareConnectionSource).inSingletonScope();
   return true;
}
