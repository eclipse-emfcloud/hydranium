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
   RAL,
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
    * `postMessage` has no completion to report. A value the pipe refuses may
    * throw, and the writer turns that into a rejected write and a writer error.
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
 * `AbstractMessageWriter` / `Emitter`, none of which need a RAL, and the RAL's
 * timer, which {@link createMessagePortTransport} reads only once a message
 * arrives, by when the host that built the connection has installed one in
 * the same copy of `vscode-jsonrpc`.
 */
export interface PostMessageTransport {
   readonly reader: MessageReader;
   readonly writer: MessageWriter;
   /**
    * Release the channel subscriptions. A {@link createMessagePortTransport}
    * transport also signals its end to the other side.
    */
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
   protected errorCount = 0;

   constructor(protected readonly channel: PostMessageChannel) {
      super();
      const onClose = channel.onClose?.(() => this.fireClose());
      if (onClose) {
         this.subscriptions.push(onClose);
      }
   }

   write(message: Message): Promise<void> {
      try {
         this.channel.post(message);
      } catch (error: unknown) {
         // `postMessage` throws synchronously on a value structured clone
         // refuses. Thrown on, it would escape from the caller's
         // `sendNotification` rather than reject it, and the connection would
         // never see a write error.
         this.errorCount++;
         this.fireError(error, message, this.errorCount);
         return Promise.reject(error);
      }
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

/**
 * A `MessagePort` the host transferred into or out of a worker, described
 * structurally.
 *
 * This package compiles without the DOM lib, so `MessagePort` has no name here
 * and the contract has to be spelled out.
 *
 * **The member set admits a `MessagePort` and REJECTS a `Worker` or the worker
 * global**, both of which would otherwise fit a `postMessage` pipe. Only a port
 * needs starting, so `start` is what tells the three apart, and naming it here
 * turns "never bind a head to the global" into a compile error at the call
 * site. A head on the global receives every other head's traffic.
 *
 * **That compile error happens at the ADOPTER, not here.** This package
 * resolves neither `MessagePort` nor `Worker` as a type, so nothing here can
 * demonstrate the rejection; a host compiling its worker against
 * `lib.webworker` (or a page against `lib.dom`) is where the names resolve and
 * the guard bites. Measured there: passing the worker global fails with
 * `Property 'start' is missing in type 'DedicatedWorkerGlobalScope'`.
 */
export interface TransferredMessagePort {
   postMessage(message: unknown): void;
   addEventListener(type: 'message', listener: (event: unknown) => void, options?: unknown): void;
   removeEventListener(type: 'message', listener: (event: unknown) => void, options?: unknown): void;
   start(): void;
}

/**
 * The value {@link createMessagePortTransport} posts in place of a JSON-RPC
 * message to say its end is going away. A string, so no JSON-RPC message can
 * be mistaken for it.
 */
const MESSAGE_PORT_CLOSE_SIGNAL = 'hydranium/message-port-closed';

/**
 * A {@link PostMessageChannel} over a {@link TransferredMessagePort}, whose
 * {@link close} posts {@link MESSAGE_PORT_CLOSE_SIGNAL}.
 *
 * **A port reports nothing when its peer goes away**: Chromium ships no `close`
 * event on `MessagePort`, Firefox and WebKit have not committed to one, and
 * `messageerror` fires only for a message that cannot be deserialized. So the
 * end is signalled in band.
 *
 * The port is never `close()`d. A later transport can still be built on it, at
 * both ends, and whether messages posted just before a `close()` are delivered
 * is not something the platform settles.
 */
class MessagePortChannel implements PostMessageChannel {
   protected readonly messageEmitter = new Emitter<Message>();
   protected readonly closeEmitter = new Emitter<void>();
   /** Set once either end has signalled; this end then delivers nothing more and never signals again. */
   protected closed = false;
   /** Set when the peer's signal has arrived and its close waits on {@link backlog}. */
   protected closePending = false;
   /** Messages handed to the connection that its queue may not have dispatched yet. */
   protected backlog = 0;
   // A `MessageEvent`, which the listener's type cannot name without the DOM lib.
   protected readonly listener = (event: unknown): void => this.receive((event as { readonly data: unknown }).data);

   constructor(protected readonly port: TransferredMessagePort) {
      port.addEventListener('message', this.listener);
   }

   post(message: Message): void {
      if (!this.closed) {
         this.port.postMessage(message);
      }
   }

   onMessage(listener: (message: Message) => void): Disposable {
      return this.messageEmitter.event(listener);
   }

   onClose(listener: () => void): Disposable {
      return this.closeEmitter.event(listener);
   }

   /** Signal this end's close to the peer, once, after everything posted before it. */
   close(): void {
      if (this.closed) {
         return;
      }
      this.end();
      this.port.postMessage(MESSAGE_PORT_CLOSE_SIGNAL);
   }

   protected end(): void {
      this.closed = true;
      this.port.removeEventListener('message', this.listener);
   }

   /**
    * Deliver one inbound value, or take the peer's signal.
    *
    * **The close waits until the connection has dispatched every message that
    * came before it.** Firing it at once is safe under `vscode-jsonrpc`'s
    * browser runtime, which drains the connection's queue on microtasks before
    * the signal's own task runs. Under its Node runtime the queue gives out one
    * message per `setImmediate` turn, so a close fired at once would overtake a
    * `closeSession` still queued, and end that session as lost. So each
    * delivered message is counted down on the same RAL timer, one per turn,
    * scheduled after the connection's own, and the close fires when the count
    * reaches zero: under either runtime, after the last dispatch.
    */
   protected receive(data: unknown): void {
      if (this.closed) {
         return;
      }
      if (data === MESSAGE_PORT_CLOSE_SIGNAL) {
         this.end();
         this.closePending = true;
         if (this.backlog === 0) {
            this.closeEmitter.fire();
         }
         return;
      }
      this.messageEmitter.fire(data as Message);
      this.backlog++;
      if (this.backlog === 1) {
         this.countDownBacklog();
      }
   }

   // Mirrors the connection's queue at its default of one message per turn. A
   // connection built with a `maxParallelism`, or with a `messageStrategy` that
   // defers `next`, can hold messages longer than this counts, and its close
   // can then overtake them.
   protected countDownBacklog(): void {
      RAL().timer.setImmediate(() => {
         this.backlog--;
         if (this.backlog > 0) {
            this.countDownBacklog();
         } else if (this.closePending) {
            this.closeEmitter.fire();
         }
      });
   }
}

/**
 * A {@link PostMessageWriter} whose dispose, which a `MessageConnection`'s
 * `dispose` and `end` both reach, signals this end's close to the peer.
 */
class MessagePortWriter extends PostMessageWriter {
   constructor(protected override readonly channel: MessagePortChannel) {
      super(channel);
   }

   override dispose(): void {
      this.channel.close();
      super.dispose();
   }
}

/**
 * Build the reader/writer pair for a head's `MessagePort`, at either end.
 *
 * Disposing the writer (which the connection's own `dispose` does) posts a
 * close signal after everything it wrote, and the other end's reader and writer
 * then fire close, so a head tears down on its client's dispose as it does on a
 * socket's close. For a connection at its default parallelism and message
 * strategy, the close fires only once that end's connection has dispatched
 * every message sent before the signal, under either `vscode-jsonrpc` runtime,
 * so a `closeSession` sent just before the dispose still ends its session as
 * closed. Nothing reports a page or a worker that dies, because the port
 * cannot.
 *
 * **The transport and the connection must come from the same copy of
 * `vscode-jsonrpc`.** The close is scheduled through the runtime abstraction
 * layer of the copy this package imports. If the host builds its connection
 * from another copy, that layer was never installed: the first message it
 * delivers throws, and the peer's close never fires.
 *
 * **Both ends must use this.** A plain `BrowserMessageReader` peer hands the
 * signal to its connection as a message it does not understand, and its own
 * dispose posts nothing, so this end never learns that it went.
 *
 * Starts the port, because a listener added with `addEventListener` does not.
 * From then on a message that arrives before the connection listens is dropped,
 * so listen in the same task.
 */
export function createMessagePortTransport(port: TransferredMessagePort): PostMessageTransport {
   const channel = new MessagePortChannel(port);
   const reader = new PostMessageReader(channel);
   const writer = new MessagePortWriter(channel);
   port.start();
   return {
      reader,
      writer,
      dispose(): void {
         reader.dispose();
         writer.dispose();
      }
   };
}
