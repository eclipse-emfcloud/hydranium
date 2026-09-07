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
 * Restated structurally rather than imported. `vscode-messenger-common`'s
 * `NotificationType<P>` really is `{ method: string }` — `P` is phantom — so
 * there is nothing to gain from the import and something to lose: the example
 * would take a dependency on a package it reaches only transitively today, and
 * this module would stop being usable from a plain browser client.
 */
export interface NotificationTypeLike {
   readonly method: string;
}

/**
 * The one method both ends of the hop share: hand a message to a participant.
 *
 * `TParticipant` stays generic because the two ends address different things —
 * the extension side a registered webview, the webview side `HOST_EXTENSION` —
 * and this module has no reason to know either type.
 */
export interface MessengerSendLike<TParticipant> {
   sendNotification(type: NotificationTypeLike, receiver: TParticipant, params?: Message): void;
}

/**
 * The two methods this adapter needs from the **extension-side** messenger.
 *
 * Narrow on purpose. Depending on two methods instead of a class is what makes
 * a faithful test double possible — a fake that implements exactly this cannot
 * be unfaithful in some third method the adapter secretly uses. But narrowness
 * only protects against a method used and not declared; it does NOT make a
 * declared signature true of the real thing, which is what
 * {@link WebviewMessengerLike} exists to record.
 */
export interface MessengerLike<TParticipant> extends MessengerSendLike<TParticipant> {
   onNotification(
      type: NotificationTypeLike,
      handler: (params: Message, sender: TParticipant) => void,
      options?: { sender?: TParticipant }
   ): Disposable;
}

/**
 * The **webview-side** messenger, which is NOT the same shape — and the
 * difference is not cosmetic.
 *
 * `vscode-messenger-webview`'s `Messenger` differs from the extension-side
 * class, and every difference bears on this adapter — read from the installed
 * package's own sources rather than from its README:
 *
 * - **`onNotification` returns the messenger itself**, for chaining, not a
 *   `Disposable`. There is no unregister API at all, so a registration is
 *   permanent for the life of the webview. That is why
 *   {@link createMessengerChannel} owns a forwarding flag rather than relying
 *   on releasing the registration: the `Disposable` it hands back has to mean
 *   "stop delivering to this listener", which is the strongest promise
 *   available on this side.
 * - **There is no `sender` option.** Filtering by sender is an extension-side
 *   feature; a webview has exactly one peer, so it needs none.
 * - **`start()` must be called** before anything arrives — it is what attaches
 *   the `window` message listener. It is deliberately absent from this
 *   interface because the *adapter* does not call it (a messenger handed in
 *   already started would be wrongly rejected); the webview bootstrap owns it.
 *   See {@link createWebviewSideChannel}.
 *
 * A separate interface rather than a widening of {@link MessengerLike}, so each
 * interface stays true of its own side. One interface for both ends does not
 * hold: a compile-time assertion can only prove the side that has a real class
 * to assert against, so the other side's claim goes unchecked — and the shape it
 * would promise there, an unregisterable handler plus a sender filter, is one
 * the webview messenger cannot honour.
 */
export interface WebviewMessengerLike<TParticipant> extends MessengerSendLike<TParticipant> {
   onNotification(type: NotificationTypeLike, handler: (params: Message, sender: TParticipant) => void): unknown;
}

/**
 * The data head's two notification types, one per direction.
 *
 * **Two types rather than one, and NOT load-bearing.** `vscode-messenger`
 * addresses notifications to a *receiver*, so a side's own outbound traffic does
 * not reach its own handler even when both directions share a method name:
 * collapsing these two constants to one leaves the whole suite green, measured.
 * Separate names do not prevent self-delivery; the addressing does.
 *
 * What they do buy is real but smaller: the direction is legible on the wire and
 * in a `vscode-messenger` diagnostic trace, and any delivery path that routes by
 * method name alone rather than by receiver — `BROADCAST`, or a fan-out someone
 * adds later — stays correct by construction instead of by the addressing
 * happening to be right. Cheap insurance, not a requirement.
 */
export const ORDER_FLOW_DATA_TO_WEBVIEW: NotificationTypeLike = { method: 'orderFlow/data/toWebview' };
export const ORDER_FLOW_DATA_TO_EXTENSION: NotificationTypeLike = { method: 'orderFlow/data/toExtension' };

/**
 * Options for {@link createMessengerChannel}.
 *
 * Generic over the registration type as well as the participant, because the two
 * sides disagree on what `onNotification` hands back — a `Disposable` on the
 * extension side, the messenger itself on the webview side (see
 * {@link WebviewMessengerLike}). Carrying it in a type parameter is what lets
 * {@link releaseRegistration} be typed rather than sniffed structurally: a
 * `typeof x.dispose === 'function'` probe on an `unknown` would start disposing
 * the whole webview messenger the day upstream gives it a `dispose()`.
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
    * whenever the messenger is shared — which it is by design here, since the
    * diagram rides the same hop — so a second webview cannot inject traffic
    * into this connection.
    *
    * Extension side only: the webview-side messenger ignores it, so passing it
    * there would read as a filter that is not applied.
    */
   readonly sender?: TParticipant;
   /**
    * Observe the hop going away — the webview being disposed. Wired straight
    * through to {@link PostMessageChannel.onClose}, whose reader and writer use
    * it to fire their own close.
    */
   readonly onClose?: (listener: () => void) => Disposable;
   /**
    * Release what `onNotification` returned, when this side's messenger hands
    * back something releasable.
    *
    * Supplied by {@link createExtensionSideChannel}, whose `Messenger` returns a
    * real `Disposable` and whose registrations would otherwise accumulate on a
    * hop that outlives every panel on it. Omitted by
    * {@link createWebviewSideChannel}, which has nothing to release.
    */
   readonly releaseRegistration?: (registration: TRegistration) => void;
}

/**
 * Present a messenger as a {@link PostMessageChannel}, so the data head's
 * transport can ride a host's existing notification hop.
 *
 * This is the last VS Code-specific piece of the data path, and it is
 * deliberately this small: `createPostMessageTransport` turns the channel into a
 * reader/writer pair, `relayToPostMessageChannel` pumps the extension host's
 * socket onto the same channel shape from the other side, and everything above
 * — `createRpcProxy`, `DataSession`, the properties model — is host-invariant.
 * Sharing GLSP's own `Messenger` rather than opening a second hop means the
 * diagram and the form share one lifecycle and one dispose.
 *
 * Hand-rolled here because the framework ships Theia client packages and no
 * VS Code equivalents, so a VS Code host has to supply this adapter itself.
 *
 * **`onMessage`'s `Disposable` means "stop delivering", not necessarily
 * "unregister".** `PostMessageChannel.onMessage` promises a `Disposable`, and
 * the webview-side messenger cannot unregister a handler at all, so the
 * forwarding flag below is what makes the promise keepable on both sides. Where
 * unregistering IS possible the flag rides along with it rather than replacing
 * it — see {@link MessengerChannelOptions.releaseRegistration}, without which
 * every disposed panel would leave a handler on a hop shared with the diagram.
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
      outbound: ORDER_FLOW_DATA_TO_WEBVIEW,
      inbound: ORDER_FLOW_DATA_TO_EXTENSION,
      // Only this webview's traffic, since the hop is shared with the diagram.
      sender: webview,
      onClose,
      // This side CAN unregister, and must: the hop outlives every panel on it.
      releaseRegistration: registration => registration.dispose()
   });
}

/**
 * The webview's end: the mirror image, addressed at the extension host.
 *
 * Two preconditions the webview bootstrap owns, both of which present as "the
 * form never populates" when missed:
 *
 * - **Build the connection with `createMessageConnection` from
 *   `vscode-jsonrpc/browser`.** The package root installs no runtime
 *   abstraction layer and throws on the first message.
 * - **Call the messenger's own `start()`.** It is what attaches the `window`
 *   message listener, and nothing arrives until it has run. It is not part of
 *   {@link WebviewMessengerLike} because this adapter does not call it — see
 *   that interface for the rest of the webview messenger's asymmetries.
 *
 * No `sender` filter is passed, deliberately: a webview has one peer, and the
 * webview-side messenger has no such option to honour.
 */
export function createWebviewSideChannel<TParticipant>(
   messenger: WebviewMessengerLike<TParticipant>,
   hostExtension: TParticipant,
   onClose?: (listener: () => void) => Disposable
): PostMessageChannel {
   return createMessengerChannel<TParticipant, unknown>({
      messenger,
      receiver: hostExtension,
      outbound: ORDER_FLOW_DATA_TO_EXTENSION,
      inbound: ORDER_FLOW_DATA_TO_WEBVIEW,
      onClose
   });
}
