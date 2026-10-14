/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import type { PostMessageChannel } from '@hydranium/protocol';
import type { Disposable, Message } from 'vscode-jsonrpc';

/**
 * A notification type as `vscode-messenger` defines it: a method name, with the
 * payload type carried only in the generic parameter.
 *
 * Restated rather than imported: `vscode-messenger-common`'s
 * `NotificationType<P>` is `{ method: string }` with `P` phantom, and the import
 * would pin the adopter's messenger copy, which GLSP's VS Code integration
 * chooses.
 */
export interface NotificationTypeLike {
   readonly method: string;
}

/**
 * The one method both ends of the hop share: hand a message to a participant.
 *
 * `TParticipant` stays generic because the two ends address different things,
 * the extension side a registered webview and the webview side
 * `HOST_EXTENSION`.
 */
export interface MessengerSendLike<TParticipant> {
   sendNotification(type: NotificationTypeLike, receiver: TParticipant, params?: Message): void;
}

/**
 * The two methods the channel needs from the **extension-side** messenger.
 *
 * Two methods rather than the class, so any messenger with them fits, GLSP's
 * included, without pinning a `vscode-messenger` copy.
 */
export interface MessengerLike<TParticipant> extends MessengerSendLike<TParticipant> {
   onNotification(
      type: NotificationTypeLike,
      handler: (params: Message, sender: TParticipant) => void,
      options?: { sender?: TParticipant }
   ): Disposable;
}

/**
 * The **webview-side** messenger, which differs from the extension side in
 * every point the channel depends on:
 *
 * - **`onNotification` returns the messenger itself**, not a `Disposable`, and
 *   there is no unregister API, so a registration lasts as long as the webview.
 *   {@link createMessengerChannel} therefore stops delivering through a flag.
 * - **There is no `sender` option**: a webview has one peer.
 * - **`start()` must be called** before anything arrives, since it attaches the
 *   `window` listener. It is absent here because the channel does not call it;
 *   the webview's bootstrap does.
 *
 * A separate interface rather than a wider {@link MessengerLike}: one shape for
 * both ends would promise a webview an unregisterable handler and a sender
 * filter it cannot honour.
 */
export interface WebviewMessengerLike<TParticipant> extends MessengerSendLike<TParticipant> {
   onNotification(type: NotificationTypeLike, handler: (params: Message, sender: TParticipant) => void): unknown;
}

/**
 * The data head's two notification types, one per direction.
 *
 * `vscode-messenger` addresses a notification to its receiver, so one method
 * for both directions would also deliver correctly. Two keep the direction
 * readable on the wire and in a messenger trace, and keep a delivery that
 * routes by method alone, such as `BROADCAST`, from reaching the sender's own
 * handler.
 */
export const DATA_TO_WEBVIEW: NotificationTypeLike = { method: 'hydranium/data/toWebview' };
export const DATA_TO_EXTENSION: NotificationTypeLike = { method: 'hydranium/data/toExtension' };

/**
 * Options for {@link createMessengerChannel}.
 *
 * Generic over the registration type as well as the participant, because the two
 * sides disagree on what `onNotification` hands back: a `Disposable` on the
 * extension side, the messenger itself on the webview side. The type parameter
 * keeps {@link releaseRegistration} typed; probing an `unknown` for a `dispose`
 * method would dispose the whole webview messenger if it ever gained one.
 */
export interface MessengerChannelOptions<TParticipant, TRegistration> {
   readonly messenger: {
      sendNotification(type: NotificationTypeLike, receiver: TParticipant, params?: Message): void;
      onNotification(
         type: NotificationTypeLike,
         handler: (params: Message, sender: TParticipant) => void,
         options?: { sender?: TParticipant }
      ): TRegistration;
   };
   /** Where this side's outbound messages are addressed. */
   readonly receiver: TParticipant;
   /** The notification type this side SENDS on. */
   readonly outbound: NotificationTypeLike;
   /** The notification type this side LISTENS on. */
   readonly inbound: NotificationTypeLike;
   /**
    * Accept inbound notifications only from this participant. Supply it
    * whenever the messenger is shared, as GLSP's is with every diagram
    * webview, so a second webview cannot inject traffic into this connection.
    *
    * Extension side only: the webview-side messenger ignores it.
    */
   readonly sender?: TParticipant;
   /**
    * Observe the hop going away, the webview being disposed. Passed through to
    * {@link PostMessageChannel.onClose}, whose reader and writer use it to fire
    * their own close.
    */
   readonly onClose?: (listener: () => void) => Disposable;
   /**
    * Release what `onNotification` returned, where the messenger hands back
    * something releasable: on the extension side, whose registrations would
    * otherwise accumulate on a hop that outlives every webview on it.
    */
   readonly releaseRegistration?: (registration: TRegistration) => void;
}

/**
 * Present a messenger as a {@link PostMessageChannel}, so the data head's
 * transport rides a host's existing notification hop.
 *
 * `createPostMessageTransport` turns the channel into a reader and writer,
 * `relayToPostMessageChannel` pumps the extension host's socket onto it from
 * the other side, and everything above, `createRpcProxy` and `DataSession`
 * included, is host-invariant. Sharing GLSP's `Messenger` rather than opening a
 * second hop gives a diagram and a data webview one lifecycle and one dispose.
 *
 * **`onMessage`'s `Disposable` means "stop delivering", not necessarily
 * "unregister".** The webview-side messenger cannot unregister, so a flag keeps
 * the promise on both sides. Where unregistering is possible,
 * {@link MessengerChannelOptions.releaseRegistration} does it too, or every
 * disposed webview would leave a handler on a shared hop.
 */
export function createMessengerChannel<TParticipant, TRegistration>(
   options: MessengerChannelOptions<TParticipant, TRegistration>
): PostMessageChannel {
   const { messenger, receiver, outbound, inbound, sender, onClose, releaseRegistration } = options;
   return {
      post(message: Message): void {
         messenger.sendNotification(outbound, receiver, message);
      },
      onMessage(listener: (message: Message) => void): Disposable {
         let delivering = true;
         const registration = messenger.onNotification(
            inbound,
            message => {
               if (delivering) {
                  listener(message);
               }
            },
            sender ? { sender } : undefined
         );
         return {
            dispose: () => {
               delivering = false;
               releaseRegistration?.(registration);
            }
         };
      },
      ...(onClose ? { onClose } : {})
   };
}

/**
 * The extension host's end: posts toward the webview, listens for what the
 * webview sends.
 */
export function createExtensionSideChannel<TParticipant>(
   messenger: MessengerLike<TParticipant>,
   webview: TParticipant,
   onClose?: (listener: () => void) => Disposable
): PostMessageChannel {
   return createMessengerChannel<TParticipant, Disposable>({
      messenger,
      receiver: webview,
      outbound: DATA_TO_WEBVIEW,
      inbound: DATA_TO_EXTENSION,
      // Only this webview's traffic, since the hop is shared.
      sender: webview,
      onClose,
      // This side can unregister, and must: the hop outlives every webview on it.
      releaseRegistration: registration => registration.dispose()
   });
}

/**
 * The webview's end: the mirror image, addressed at the extension host.
 *
 * Two preconditions the webview's bootstrap owns, both of which present as "no
 * data ever arrives" when missed:
 *
 * - **Read the channel through `WebviewDataPort`**, or build its connection
 *   with `createMessageConnection` from `vscode-jsonrpc/browser`: the package
 *   root installs no runtime abstraction layer and throws on the first
 *   message.
 * - **Call the messenger's own `start()`**, which attaches the `window`
 *   listener.
 *
 * No `sender` filter: a webview has one peer.
 */
export function createWebviewSideChannel<TParticipant>(
   messenger: WebviewMessengerLike<TParticipant>,
   hostExtension: TParticipant,
   onClose?: (listener: () => void) => Disposable
): PostMessageChannel {
   return createMessengerChannel<TParticipant, unknown>({
      messenger,
      receiver: hostExtension,
      outbound: DATA_TO_EXTENSION,
      inbound: DATA_TO_WEBVIEW,
      onClose
   });
}
