/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { AbstractMessageReader, AbstractMessageWriter, Emitter, Message, type Disposable, type NotificationMessage } from 'vscode-jsonrpc';
import type { PostMessageChannel, RelayTransport } from '../../src/client';

/** A notification, the cheapest {@link Message} carrying a distinguishable payload. */
export function notification(method: string, value?: unknown): NotificationMessage {
   return value === undefined ? { jsonrpc: '2.0', method } : { jsonrpc: '2.0', method, params: { value } };
}

/** Method names in arrival order, for assertions about ORDER rather than membership. */
export function methodsOf(messages: readonly Message[]): string[] {
   return messages.map(message => (Message.isNotification(message) ? message.method : `<${message.jsonrpc}>`));
}

/**
 * One end of a simulated webview boundary: a {@link PostMessageChannel} whose
 * `post` puts every message through `structuredClone`.
 *
 * `structuredClone` is the boundary's real algorithm rather than a stand-in for
 * it, so anything carrying behaviour — a `Disposable`, an `Emitter`, a function —
 * throws `DataCloneError` here instead of arriving degraded.
 */
export class ClonePipeEnd implements PostMessageChannel {
   protected readonly inbound = new Emitter<Message>();
   protected readonly closed = new Emitter<void>();
   protected peer?: ClonePipeEnd;

   constructor(readonly posted: Message[] = []) {}

   /** A connected pair sharing one traffic log. */
   static pair(posted: Message[] = []): [ClonePipeEnd, ClonePipeEnd] {
      const left = new ClonePipeEnd(posted);
      const right = new ClonePipeEnd(posted);
      left.peer = right;
      right.peer = left;
      return [left, right];
   }

   post(message: Message): void {
      const cloned = structuredClone(message);
      this.posted.push(cloned);
      // Asynchronously, like a real `postMessage`: synchronous delivery would
      // hide any re-entrancy assumption the tier above makes.
      queueMicrotask(() => this.peer?.inbound.fire(cloned));
   }

   onMessage(listener: (message: Message) => void): Disposable {
      return this.inbound.event(listener);
   }

   onClose(listener: () => void): Disposable {
      return this.closed.event(listener);
   }

   /** Fire the close a reader and a writer over this end both listen for. */
   fireClose(): void {
      this.closed.fire();
   }

   /** Deliver inbound without a peer, for the single-ended cases. */
   deliver(message: Message): void {
      this.inbound.fire(message);
   }

   dispose(): void {
      this.inbound.dispose();
      this.closed.dispose();
   }
}

/** A reader whose stream, close and error a test drives directly. */
export class DrivableReader extends AbstractMessageReader {
   protected readonly inbound = new Emitter<Message>();

   listen(callback: (message: Message) => void): Disposable {
      return this.inbound.event(callback);
   }

   /** Emit a message, as a framed transport delivering one would. */
   emit(message: Message): void {
      this.inbound.fire(message);
   }

   raiseClose(): void {
      this.fireClose();
   }

   raiseError(error: Error): void {
      this.fireError(error);
   }

   override dispose(): void {
      super.dispose();
      this.inbound.dispose();
   }
}

/** A writer that records, or rejects once {@link RecordingWriter.failWith} is set. */
export class RecordingWriter extends AbstractMessageWriter {
   readonly written: Message[] = [];
   failWith?: Error;

   write(message: Message): Promise<void> {
      if (this.failWith) {
         return Promise.reject(this.failWith);
      }
      this.written.push(message);
      return Promise.resolve();
   }

   end(): void {}
}

/**
 * A {@link RelayTransport} standing in for the framed side.
 *
 * Recording is what makes arrival ORDER assertable: a replay of buffered
 * messages is observable only as a sequence, and asserting that each message
 * merely arrived is satisfied by any ordering.
 */
export class RecordingTransport implements RelayTransport {
   readonly reader = new DrivableReader();
   readonly writer = new RecordingWriter();
   disposals = 0;

   dispose(): void {
      this.disposals += 1;
      this.reader.dispose();
   }
}
