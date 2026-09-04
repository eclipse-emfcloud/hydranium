/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import type { PostMessageChannel } from '@hydranium/protocol';
import { Emitter, type Disposable, type Event, type Message } from 'vscode-jsonrpc';

/**
 * One end of a simulated webview boundary: a {@link PostMessageChannel} whose
 * `post` puts every message through `structuredClone`.
 *
 * Shared by the two suites that cross this boundary — the clone-hop suite, where
 * both ends are clone pipes, and the relay suite, where one end is a real TCP
 * socket — so the load-bearing line (the `structuredClone` call) has exactly one
 * definition. Duplicating it would let one copy weaken without the other.
 *
 * `structuredClone` is the boundary's real algorithm, not an approximation of
 * it: anything carrying behaviour (a `Disposable` instance, a `URI`, an
 * `Emitter`, a function) throws `DataCloneError` here rather than arriving
 * degraded, so a payload that merely *looks* like plain data fails loudly.
 */
export class ClonePipeEnd implements PostMessageChannel {
   protected readonly inbound = new Emitter<Message>();
   protected readonly closed = new Emitter<void>();
   /** The far end, set once both halves exist. */
   protected peer?: ClonePipeEnd;

   constructor(readonly crossed: Message[]) {}

   /** Build a connected pair sharing one traffic log. */
   static pair(crossed: Message[]): [ClonePipeEnd, ClonePipeEnd] {
      const left = new ClonePipeEnd(crossed);
      const right = new ClonePipeEnd(crossed);
      left.peer = right;
      right.peer = left;
      return [left, right];
   }

   post(message: Message): void {
      const cloned = structuredClone(message);
      this.crossed.push(cloned);
      // Asynchronously, like a real postMessage: delivering synchronously would
      // hide any ordering assumption the RPC layer makes about re-entrancy.
      queueMicrotask(() => this.peer?.inbound.fire(cloned));
   }

   onMessage(listener: (message: Message) => void): Disposable {
      return this.inbound.event(listener);
   }

   onClose(listener: () => void): Disposable {
      return this.closed.event(listener);
   }

   readonly onDidClose: Event<void> = this.closed.event;

   /** Fire the close both a reader and a writer over this end listen for. */
   fireClose(): void {
      this.closed.fire();
   }

   dispose(): void {
      this.inbound.dispose();
      this.closed.dispose();
   }
}
