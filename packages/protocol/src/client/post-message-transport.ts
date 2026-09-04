/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import {
   AbstractMessageReader,
   AbstractMessageWriter,
   Emitter,
   type DataCallback,
   type Disposable,
   type Message,
   type MessageReader,
   type MessageWriter
} from 'vscode-jsonrpc';

/**
 * A `postMessage`-shaped pipe: fire-and-forget, structured-clone-only, no
 * framing and no bytes.
 *
 * This is the shape every extension↔webview hop reduces to, and the reason the
 * data head needs a port at all. A webview has no `net`, no reach into the
 * extension host's connection, and nothing but structured clone — so a
 * transport built on it can carry plain data and nothing else.
 *
 * Deliberately minimal, and deliberately not typed against any host's messaging
 * library — a host adapter satisfies it in a few lines over whatever messenger
 * it already has, so a diagram and a form can share one hop, one lifecycle and
 * one dispose rather than opening a second channel for the form.
 */
export interface PostMessageChannel {
   /**
    * Hand one JSON-RPC message to the other side. Fire-and-forget: delivery
    * failures surface through {@link onClose}, never as a rejection, because
    * `postMessage` has no completion to report.
    */
   post(message: Message): void;

   /** Register for messages arriving from the other side. */
   onMessage(listener: (message: Message) => void): Disposable;

   /**
    * Register for the pipe going away — the webview being disposed, the
    * extension deactivating. Optional: a channel with no observable end simply
    * never fires close, and the reader/writer then rely on their owner's
    * dispose instead.
    */
   onClose?(listener: () => void): Disposable;
}

/**
 * A reader/writer pair over a {@link PostMessageChannel}, ready to be handed to
 * `createMessageConnection`.
 *
 * The connection is NOT built here, and that omission is the point:
 * `createMessageConnection`'s message queue needs a vscode-jsonrpc runtime
 * abstraction layer, and only the `/node` and `/browser` entrypoints install
 * one. vscode-jsonrpc 9's package ROOT resolves to the RAL-less common API and
 * throws `No runtime abstraction layer installed` on the first message. Only
 * the host knows which side it is on, so the host imports the matching entry
 * (`/browser` in a webview, `/node` in an extension host) and builds the
 * connection there.
 *
 * Keeping the factory out of this module is also what lets the module stay
 * browser-neutral: it touches only `AbstractMessageReader` /
 * `AbstractMessageWriter` / `Emitter`, none of which need a RAL.
 */
export interface PostMessageTransport {
   readonly reader: MessageReader;
   readonly writer: MessageWriter;
   /** Release the channel subscriptions. */
   dispose(): void;
}

/**
 * A `MessageReader` over a {@link PostMessageChannel}.
 *
 * Structured clone moves objects, so there is nothing to frame and nothing to
 * decode — the message arrives as the message.
 */
class PostMessageReader extends AbstractMessageReader implements MessageReader {
   protected readonly messageEmitter = new Emitter<Message>();
   protected readonly subscriptions: Disposable[] = [];

   constructor(channel: PostMessageChannel) {
      super();
      this.subscriptions.push(channel.onMessage(message => this.messageEmitter.fire(message)));
      const onClose = channel.onClose?.(() => this.fireClose());
      if (onClose) {
         this.subscriptions.push(onClose);
      }
   }

   listen(callback: DataCallback): Disposable {
      return this.messageEmitter.event(callback);
   }

   override dispose(): void {
      super.dispose();
      for (const subscription of this.subscriptions) {
         subscription.dispose();
      }
      this.subscriptions.length = 0;
      this.messageEmitter.dispose();
   }
}

/** The dual of {@link PostMessageReader} — one `post` per JSON-RPC message. */
class PostMessageWriter extends AbstractMessageWriter implements MessageWriter {
   protected readonly subscriptions: Disposable[] = [];

   constructor(protected readonly channel: PostMessageChannel) {
      super();
      const onClose = channel.onClose?.(() => this.fireClose());
      if (onClose) {
         this.subscriptions.push(onClose);
      }
   }

   write(message: Message): Promise<void> {
      this.channel.post(message);
      // `postMessage` reports no completion, so the resolved promise means
      // "handed over", not "delivered". vscode-jsonrpc only needs the former.
      return Promise.resolve();
   }

   end(): void {
      this.dispose();
   }

   override dispose(): void {
      super.dispose();
      for (const subscription of this.subscriptions) {
         subscription.dispose();
      }
      this.subscriptions.length = 0;
   }
}

/**
 * Build the reader/writer pair for `channel`.
 *
 * What this buys, and why `DataPort` is shaped the way it is:
 * `createRpcProxy` runs **unchanged** over the result. The typed surface, the
 * `DATA_*_PROTOCOL_METHODS` allowlists and the whole open → watch → update →
 * close sequence are identical in a webview and in a Node extension host,
 * because only the `MessageConnection` the port hands back differs. Terminating
 * JSON-RPC in the extension host and declaring one request type per data-head
 * method is the wrong trade: it hand-maintains a per-method mapping and
 * discards the `as const satisfies keyof` allowlists, which cannot drift.
 */
export function createPostMessageTransport(channel: PostMessageChannel): PostMessageTransport {
   const reader = new PostMessageReader(channel);
   const writer = new PostMessageWriter(channel);
   return {
      reader,
      writer,
      dispose(): void {
         reader.dispose();
         writer.dispose();
      }
   };
}
