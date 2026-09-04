/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * A `vscode-messenger` stand-in that routes by (notification type, receiver),
 * presented to each side through the API that side really has.
 *
 * **The two ends are DIFFERENT classes upstream, and a double that models them
 * as one hides it.** `vscode-messenger`'s extension-side `Messenger` and
 * `vscode-messenger-webview`'s differ as follows, read from the installed
 * sources of each:
 *
 * | | extension side | webview side |
 * | --- | --- | --- |
 * | `onNotification` returns | `vscode.Disposable` | the messenger itself |
 * | `sender` filter option | yes | absent |
 * | handlers per method | many | ONE — a `Map`, so a second registration wins |
 *
 * So {@link FakeMessengerHub.asExtension} and {@link FakeMessengerHub.asWebview}
 * are deliberately asymmetric. A symmetric double hands the webview side an
 * unregister API and a sender filter it does not have, which is the difference
 * between "the adapter works" and "the adapter works against a double we wrote
 * to agree with it".
 *
 * **Only the first two rows are load-bearing, and that is measured.** The
 * `Disposable` return is: a single interface covering both sides does not
 * compile against the real webview class, which is what makes the asymmetry
 * checkable rather than a matter of opinion. The one-handler-per-method row is
 * NOT — flipping this double to allow many handlers per method leaves every
 * suite green, because a superseded generation's reader is already inert (the
 * channel's per-subscription forwarding flag), so a surviving stale handler has
 * nothing to deliver to. The row is modelled anyway because a faithful double is
 * right regardless of whether today's code happens to depend on it; it is just
 * not evidence of anything.
 *
 * What no double proves is the real classes' delivery semantics across a process
 * boundary — that needs an IDE launch. The compile-time conformance assertions
 * live in `examples/order-flow/vscode`, which is the only package that declares
 * both messenger packages.
 */

import type { MessengerLike, NotificationTypeLike, WebviewMessengerLike } from '../../src/data/order-flow-messenger-channel';
import type { Disposable, Message } from 'vscode-jsonrpc';

/** One notification as it went onto the hub. */
export interface Delivery<TParticipant> {
   readonly method: string;
   readonly receiver: TParticipant;
   readonly message: Message;
}

interface Registration<TParticipant> {
   method: string;
   owner: TParticipant;
   sender?: TParticipant;
   handler: (message: Message, sender: TParticipant) => void;
}

export class FakeMessengerHub<TParticipant> {
   /** Every notification sent through the hub, in send order. */
   readonly delivered: Delivery<TParticipant>[] = [];
   protected readonly handlers: Registration<TParticipant>[] = [];

   /**
    * The **extension-side** `Messenger` as `owner` sees it: registrations are
    * disposable and can be filtered by sender.
    */
   asExtension(owner: TParticipant): MessengerLike<TParticipant> {
      return {
         sendNotification: (type, receiver, params) => this.send(owner, type, receiver, params),
         onNotification: (type, handler, options): Disposable => {
            const registration: Registration<TParticipant> = { method: type.method, owner, sender: options?.sender, handler };
            this.handlers.push(registration);
            return { dispose: () => this.remove(registration) };
         }
      };
   }

   /**
    * The **webview-side** `Messenger` as `owner` sees it: no `sender` parameter
    * to honour, ONE handler per method, and a return of the messenger itself so
    * there is nothing to dispose.
    *
    * The object is built once and closes over itself, so `===` identity holds
    * across calls exactly as it does for the real class returning `this`.
    */
   asWebview(owner: TParticipant): WebviewMessengerLike<TParticipant> {
      const messenger: WebviewMessengerLike<TParticipant> = {
         sendNotification: (type, receiver, params) => this.send(owner, type, receiver, params),
         onNotification: (type, handler): unknown => {
            const existing = this.handlers.find(registration => registration.owner === owner && registration.method === type.method);
            if (existing) {
               this.remove(existing);
            }
            this.handlers.push({ method: type.method, owner, handler });
            return messenger;
         }
      };
      return messenger;
   }

   /** How many handlers the hub holds — the leak a shared hop must not accumulate. */
   get registrationCount(): number {
      return this.handlers.length;
   }

   protected send(owner: TParticipant, type: NotificationTypeLike, receiver: TParticipant, params?: Message): void {
      if (!params) {
         return;
      }
      this.delivered.push({ method: type.method, receiver, message: params });
      // A copy, because a handler may register or release during delivery — the
      // reconnect path does exactly that, and mutating the array under the loop
      // would skip a handler or visit one twice.
      for (const registration of [...this.handlers]) {
         const addressed = registration.owner === receiver;
         const senderAllowed = registration.sender === undefined || registration.sender === owner;
         if (registration.method === type.method && addressed && senderAllowed) {
            registration.handler(params, owner);
         }
      }
   }

   protected remove(registration: Registration<TParticipant>): void {
      const at = this.handlers.indexOf(registration);
      if (at >= 0) {
         this.handlers.splice(at, 1);
      }
   }
}
