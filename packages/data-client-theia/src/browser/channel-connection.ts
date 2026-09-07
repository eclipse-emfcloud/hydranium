/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { type Channel, DisposableCollection, Emitter, type Event, type MessageProvider } from '@theia/core';
import { type ServiceConnectionProvider } from '@theia/core/lib/browser';
import { Deferred } from '@theia/core/lib/common/promise-util';
import {
   AbstractMessageReader,
   AbstractMessageWriter,
   createMessageConnection,
   type DataCallback,
   type Disposable,
   type Logger,
   type Message,
   type MessageConnection,
   type MessageReader,
   type MessageWriter
   // The `/browser` subpath, not the package root: `createMessageConnection`'s
   // message queue needs a vscode-jsonrpc runtime abstraction layer, and only the
   // `/node` and `/browser` entrypoints install one. The root resolves to the
   // RAL-less common API, which throws 'No runtime abstraction layer installed'
   // on the first message. This is frontend code, so `/browser`.
} from 'vscode-jsonrpc/browser';

/**
 * A `vscode-jsonrpc` {@link MessageReader} that reads JSON-RPC messages off a
 * Theia {@link Channel}. Each Theia channel message carries exactly one
 * JSON-RPC message (the channel does its own length framing); the reader
 * decodes the bytes and fires the parsed message.
 */
class ChannelMessageReader extends AbstractMessageReader implements MessageReader {
   protected readonly onMessageEmitter = new Emitter<Message>();
   protected readonly toDispose = new DisposableCollection();

   constructor(protected readonly channel: Channel) {
      super();
      this.toDispose.push(this.onMessageEmitter);
      this.toDispose.push(channel.onMessage(provider => this.handleMessage(provider)));
      this.toDispose.push(channel.onClose(() => this.fireClose()));
   }

   protected handleMessage(provider: MessageProvider): void {
      const buffer = provider().readBytes();
      const message = JSON.parse(new TextDecoder().decode(buffer)) as Message;
      this.onMessageEmitter.fire(message);
   }

   listen(callback: DataCallback): Disposable {
      return this.onMessageEmitter.event(callback);
   }

   override dispose(): void {
      super.dispose();
      this.toDispose.dispose();
   }
}

/**
 * A `vscode-jsonrpc` {@link MessageWriter} that writes JSON-RPC messages onto a
 * Theia {@link Channel} — one channel message per JSON-RPC message, the dual of
 * {@link ChannelMessageReader}. Uses `TextEncoder` (not node `Buffer`) so the
 * writer is browser-native, since the frontend constructs the connection.
 */
class ChannelMessageWriter extends AbstractMessageWriter implements MessageWriter {
   protected readonly toDispose: Disposable;

   constructor(protected readonly channel: Channel) {
      super();
      this.toDispose = channel.onClose(() => this.fireClose());
   }

   write(message: Message): Promise<void> {
      const writeBuffer = this.channel.getWriteBuffer();
      writeBuffer.writeBytes(new TextEncoder().encode(JSON.stringify(message)));
      writeBuffer.commit();
      return Promise.resolve();
   }

   end(): void {
      this.dispose();
   }

   override dispose(): void {
      super.dispose();
      this.toDispose.dispose();
   }
}

/**
 * Build a `vscode-jsonrpc` {@link MessageConnection} on top of a Theia
 * {@link Channel}. This is the browser-side transport for the data-server
 * head: the frontend obtains a channel to the backend forwarder (via
 * `connectionProvider.listen`), wraps it here, and drives the typed
 * `createRpcProxy` over the returned connection — so the frontend
 * speaks the same vscode-jsonrpc protocol the model-server speaks, with the
 * backend relaying bytes between the two.
 *
 * Mirrors `@eclipse-glsp/theia-integration`'s `createChannelConnection`, but
 * lives here so the data-server head carries no GLSP dependency.
 */
export function createChannelConnection(channel: Channel, logger?: Logger): MessageConnection {
   const reader = new ChannelMessageReader(channel);
   const writer = new ChannelMessageWriter(channel);
   return createMessageConnection(reader, writer, logger);
}

/** Options for {@link openChannelConnection}. */
export interface OpenChannelConnectionOptions {
   /**
    * Resolves when it is safe to open the channel. The handler holds back the
    * `connectionProvider.listen` call until this settles — e.g. pass
    * `whenWorkspaceOpen` so the backend forwarder isn't asked for the
    * model-server port before a workspace (and therefore the LSP launch that
    * publishes the port) exists.
    */
   whenReady?: Promise<void>;
   /** Optional `vscode-jsonrpc` logger threaded into the connection. */
   logger?: Logger;
   /**
    * Re-establish the connection whenever the live one is lost, by RE-OPENING
    * the channel on `path` — not merely by rebuilding over a channel Theia hands
    * back.
    *
    * **Default `true`, and the default is the point.** Re-opening is the only
    * thing that recovers a restarted language server. Theia replays a `listen`
    * handler solely from `ServiceConnectionProvider.handleChannelCreated`, i.e.
    * when the MAIN frontend-backend channel is (re)created — a page reload, a
    * dropped socket, a backend restart. A language-server restart closes just the
    * multiplexed sub-channel for this service path while the main channel stays
    * open, so no replacement channel ever arrives on its own and a handle that
    * only waits for one holds a connection to the dead process forever: its
    * requests neither answer nor reject.
    *
    * **Why on by default, where the older rebuild-on-a-fresh-channel behaviour
    * was opt-in.** That one had a working alternative to weigh against — the
    * existing connection was fine, and opting in only decided whether to swap to
    * a fresher one, so leaving a consumer's readiness gate (and the progress UI it
    * drives) undisturbed was worth more. A CLOSED channel offers no such choice:
    * the alternative to re-opening is a permanently dead handle. Re-running a
    * readiness gate against a live replacement is what a restarted server should
    * cost.
    *
    * Turn it off for a consumer that treats transport loss as terminal and tears
    * itself down instead. Off means build-once: every channel after the first is
    * ignored and {@link ChannelConnectionHandle.onDidLoseConnection} never fires.
    */
   reconnect?: boolean;

   /**
    * Delay before the re-open following each CONSECUTIVE connection loss, in ms;
    * the last entry repeats once the schedule is exhausted. Defaults to
    * {@link DEFAULT_RECONNECT_DELAYS}.
    *
    * A delay rather than an immediate re-open, for two independent reasons.
    * Theia's `ChannelMultiplexer.handleClose` fires the close emitter BEFORE it
    * deletes the id from `openChannels`, so a re-open issued from inside the
    * close listener can still see the id as open — and `open()` throws
    * "Another channel with the id '<id>' is already open" then, which
    * `ServiceConnectionProvider.listen` neither catches nor reports: the handler
    * is simply never invoked, and the consumer hangs rather than failing. And a
    * server that is flapping would otherwise be re-opened against at whatever
    * rate it can close a channel, which is what the escalation is for.
    *
    * The escalation resets once a connection has survived
    * {@link RECONNECT_ESCALATION_RESET_MS}, so an hour-long session with
    * occasional restarts does not converge on the longest delay.
    */
   reconnectDelays?: readonly number[];
}

/**
 * Default {@link OpenChannelConnectionOptions.reconnectDelays}.
 *
 * The first entry only has to outlast the synchronous close dispatch, so it is
 * short: the backend forwarder, not this delay, is what absorbs a server that is
 * still down. `AbstractSocketForwardingConnectionHandler` re-runs its port command per
 * connection and retries it indefinitely, so a channel re-opened while the
 * server is restarting parks in `findPort` and connects when the replacement
 * publishes its new port. The later entries exist for the case that machinery
 * cannot absorb — a server that accepts a socket and then dies again.
 */
export const DEFAULT_RECONNECT_DELAYS: readonly number[] = [250, 500, 1_000, 2_000, 4_000, 8_000];

/** How long a connection must survive before the reconnect escalation resets. */
export const RECONNECT_ESCALATION_RESET_MS = 30_000;

/**
 * A live channel connection plus the two things a bare
 * `Promise<MessageConnection>` cannot express: that the connection can be
 * REPLACED, and that it can be released.
 */
export interface ChannelConnectionHandle {
   /**
    * The current connection. Read it per use rather than caching it: after a
    * reconnect this returns a NEW promise, and a cached one resolves to the
    * dead connection forever. The same reasoning makes
    * `AbstractDataServiceFrontend` rebuild its proxy rather than hold one.
    */
   readonly current: Promise<MessageConnection>;

   /**
    * Fires when the live connection is gone and a replacement is on the way.
    * {@link current} has ALREADY been repointed at the replacement (still
    * unresolved) by the time listeners run, so a listener re-derives from
    * `current` and whatever it queues waits for the new channel instead of being
    * addressed at the dead one.
    *
    * **This is the event a consumer wants, not {@link onDidReconnect}.** Anything
    * derived from a connection — an `createRpcProxy`, a readiness gate, a
    * `DataSession` generation — is dead from this moment, and a consumer that
    * waits for the replacement to be live instead keeps sending into the dead one
    * for the whole gap. A `DataPort` implementation translates this into the
    * port's own `onDispose`, which is what makes `DataSession` drop its
    * generation.
    *
    * Never fires when {@link OpenChannelConnectionOptions.reconnect} is off.
    */
   readonly onDidLoseConnection: Event<void>;

   /**
    * Fires with each connection built AFTER the first, once it is live. For a
    * consumer that needs the connection object itself; for rebuilding what was
    * derived from the previous one, use {@link onDidLoseConnection} instead —
    * it fires at the start of the gap rather than at its end.
    *
    * Never fires when {@link OpenChannelConnectionOptions.reconnect} is off.
    */
   readonly onDidReconnect: Event<MessageConnection>;

   /**
    * Dispose the live connection and stop tracking the channel. Idempotent.
    *
    * Without it, a frontend being torn down leaves its connection and its
    * inbound handler bindings attached — a leak that accumulates per cycle in
    * tests and in a reloading workbench.
    */
   dispose(): void;
}

/**
 * Open a Theia channel to a backend forwarder and wrap it as the
 * `vscode-jsonrpc` {@link MessageConnection} the data-server proxy speaks over.
 *
 * Awaits `options.whenReady` (if given), then registers the channel handler via
 * `connectionProvider.listen` and keeps a live connection to `path` for as long
 * as the handle is undisposed — re-opening the channel whenever the current one
 * closes, which {@link OpenChannelConnectionOptions.reconnect} governs. Callers
 * build their `createRpcProxy` / `bindRpcMethods` over
 * {@link ChannelConnectionHandle.current}, which queues outbound calls and
 * inbound bindings until the channel is live.
 *
 * **The `reconnect` argument to Theia's `listen` is deliberately `false`**, in
 * both modes. Passing `true` there registers the handler for replay from
 * `handleChannelCreated`, and this handle then has two independent re-openers for
 * one path: Theia's replay when the main frontend-backend channel is recreated,
 * and the close-driven re-open below — which also fires then, because
 * `ChannelMultiplexer.onUnderlyingChannelClose` closes every sub-channel. Two
 * `open()` calls for one id means the loser throws "Another channel with the id
 * '<id>' is already open" inside a promise `listen` neither awaits nor reports,
 * so the consumer's request is left unsettled: a hang with a clean log, not an
 * error. Owning the re-open here means owning it exclusively.
 */
export function openChannelConnection(
   connectionProvider: ServiceConnectionProvider,
   path: string,
   options: OpenChannelConnectionOptions = {}
): ChannelConnectionHandle {
   const reconnect = options.reconnect ?? true;
   const reconnectDelays = options.reconnectDelays ?? DEFAULT_RECONNECT_DELAYS;
   const reconnectEmitter = new Emitter<MessageConnection>();
   const loseEmitter = new Emitter<void>();
   let deferred = new Deferred<MessageConnection>();
   let live: MessageConnection | undefined;
   let generation = 0;
   let disposed = false;
   /** Set from the close that repointed `deferred`, cleared by the accept that resolves it. */
   let awaitingReplacement = false;
   /** Consecutive losses, indexing `reconnectDelays`. */
   let losses = 0;
   /** When the live connection was built, for the escalation reset. `0` before the first. */
   let liveSince = 0;
   let reopenTimer: ReturnType<typeof setTimeout> | undefined;
   // Own synchronous flag, deliberately NOT `deferred.state`. Theia's
   // `Deferred` sets `state` inside a `.then()` on its own promise, so it is
   // still `'unresolved'` for a microtask after `resolve()` returns. Guarding on
   // it means two channels arriving in the SAME synchronous turn both pass the
   // guard: the second connection gets built and starts listening, the
   // first-wins `resolve` keeps the promise pointed at the first, and the second
   // leaks — attached to a channel, reachable by nobody, never disposed. A test
   // that only checks which connection the promise resolves with cannot see
   // that; it takes counting the connections built per channel.
   let built = false;

   const scheduleReopen = (): void => {
      if (liveSince > 0 && Date.now() - liveSince >= RECONNECT_ESCALATION_RESET_MS) {
         losses = 0;
      }
      const delay = reconnectDelays[Math.min(losses, reconnectDelays.length - 1)];
      losses++;
      reopenTimer = setTimeout(() => {
         reopenTimer = undefined;
         // `awaitingReplacement` is the guard against re-opening a path that
         // already has a channel: a second `open()` for one id is the "already
         // open" throw, and its symptom is a hang rather than an error.
         if (disposed || !awaitingReplacement) {
            return;
         }
         requestChannel();
      }, delay);
   };

   /**
    * The live connection's channel closed. Retire the generation and arm the
    * replacement, in that order — a listener on `onDidLoseConnection` must
    * already see `current` pointing at the replacement.
    */
   const handleChannelClosed = (): void => {
      if (disposed || awaitingReplacement) {
         return;
      }
      // Dispose rather than merely drop. vscode-jsonrpc rejects pending
      // responses from `dispose`, never from a reader-side close — so a
      // connection left undisposed keeps every in-flight request unsettled
      // forever, which is the failure this whole path exists to end.
      live?.dispose();
      live = undefined;
      deferred = new Deferred<MessageConnection>();
      awaitingReplacement = true;
      loseEmitter.fire(undefined);
      scheduleReopen();
   };

   const acceptChannel = (channel: Channel): void => {
      if (disposed) {
         return;
      }
      if (built && !awaitingReplacement) {
         // Unsolicited: a channel arrived while one is already live and no close
         // asked for a replacement. Exactly one channel is outstanding at a time
         // here, so this is either the build-once case (`reconnect` off) or a
         // handler re-fire, and adopting it would leave the previous connection
         // listening on its own channel, reachable by nobody and never disposed.
         // The close-driven path is the only way a second generation is built.
         return;
      }
      const connection = createChannelConnection(channel, options.logger);
      connection.listen();
      live = connection;
      built = true;
      awaitingReplacement = false;
      generation++;
      liveSince = Date.now();
      if (reconnect) {
         // Registered AFTER `createChannelConnection`, so the connection's own
         // reader and writer see the close first and `connection.onClose` still
         // fires for whoever is listening to it. Disposing before they run would
         // put the connection in `Disposed`, from which vscode-jsonrpc
         // deliberately emits no close event at all.
         const acceptedGeneration = generation;
         channel.onClose(() => {
            if (acceptedGeneration === generation) {
               handleChannelClosed();
            }
         });
      }
      deferred.resolve(connection);
      if (generation > 1) {
         reconnectEmitter.fire(connection);
      }
   };

   /** Register the channel handler for one open attempt on `path`. */
   function requestChannel(): void {
      connectionProvider.listen(path, (_path, channel) => acceptChannel(channel), false);
   }

   const start = async (): Promise<void> => {
      await options.whenReady;
      if (disposed) {
         return;
      }
      requestChannel();
   };
   start();

   return {
      get current(): Promise<MessageConnection> {
         return deferred.promise;
      },
      onDidLoseConnection: loseEmitter.event,
      onDidReconnect: reconnectEmitter.event,
      dispose(): void {
         if (disposed) {
            return;
         }
         disposed = true;
         if (reopenTimer !== undefined) {
            clearTimeout(reopenTimer);
            reopenTimer = undefined;
         }
         live?.dispose();
         live = undefined;
         loseEmitter.dispose();
         reconnectEmitter.dispose();
      }
   };
}
