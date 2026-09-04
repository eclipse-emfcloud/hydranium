/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { type Harness } from '@hydranium/protocol/testing';
import { makeDuplexStreamPair } from '@hydranium/protocol/testing/node';
import { StreamMessageReader, StreamMessageWriter } from 'vscode-jsonrpc/node';
import { type Connection, ProposedFeatures } from 'vscode-languageserver/node';
// The node `createConnection` from `vscode-languageserver/node` is built for a
// standalone server PROCESS: it wires `process.exit()` onto the input stream's
// `end`/`close` events, onto the `exit` notification (via its watchDog), and onto
// a parent-pid liveness timer, and it calls `endProtocolConnection()` (a write)
// on stream close. In-process every one of those is fatal — destroying the
// streams at teardown trips the `close` handler, which writes into the destroyed
// stream (an uncatchable synchronous `ERR_STREAM_DESTROYED`) and/or exits the host
// test runner. The lower-level common `createConnection(connectionFactory,
// watchDog, features)` form does none of that: it lets us inject a no-op-`exit`
// WatchDog and build the connection over the in-memory streams, so teardown is the
// primitive's responsibility alone.
// (Both live on the package root, which re-exports the common server module —
// the `lib/common/server.js` deep path is unreachable under the exports-only
// package map the LSP 3.18 libs ship.)
import { createConnection, type WatchDog } from 'vscode-languageserver';
import {
   ApplyWorkspaceEditRequest,
   CompletionRequest,
   DidChangeTextDocumentNotification,
   DidOpenTextDocumentNotification,
   HoverRequest,
   InitializeRequest,
   InitializedNotification,
   PublishDiagnosticsNotification,
   SemanticTokensRequest,
   ShutdownRequest,
   createProtocolConnection,
   type ApplyWorkspaceEditParams,
   type ApplyWorkspaceEditResult,
   type CompletionList,
   type Diagnostic,
   type Hover,
   type InitializeParams,
   type InitializeResult,
   type Position,
   type ProtocolConnection,
   type PublishDiagnosticsParams,
   type SemanticTokens,
   type WorkspaceEdit
} from 'vscode-languageserver-protocol/node';

/**
 * Default wait for {@link LspServerConnection.nextDiagnostics}. Deliberately
 * much shorter than the subprocess smoke's: in-process there is no spawn and no
 * I/O, so a missing publish indicates a real wiring fault rather than slow
 * startup, and the wait only has to clear an in-memory build while still failing
 * fast instead of hanging the suite.
 */
const DEFAULT_DIAGNOSTICS_TIMEOUT_MS = 5_000;

/** Default `version` assigned to {@link LspServerConnection.openDocument} when none is supplied. */
const INITIAL_DOCUMENT_VERSION = 1;

/**
 * Options for {@link LspServerConnection.nextDiagnostics}, and for the
 * subprocess tier's identically-shaped method — one type, so the in-process and
 * spawned harnesses cannot drift into two spellings of the same discipline.
 */
export interface NextDiagnosticsOptions {
   /**
    * Index into {@link LspServerConnection.diagnostics} to search from,
    * inclusive. Read `diagnostics.length` BEFORE the triggering action and pass
    * it here: an already-captured publish at or after that point resolves
    * immediately, so the wait no longer has to be armed before the action and
    * cannot be answered by a publish that predates it. Omitted ⇒ only publishes
    * arriving after the call are considered.
    */
   readonly fromIndex?: number;
   /** Reject after this long. Defaults to the harness's own publish timeout, which differs by tier. */
   readonly timeoutMs?: number;
}

/**
 * One captured server→client `workspace/applyEdit`, with the two fields an
 * edit-egress assertion actually reads lifted out of the `WorkspaceEdit`.
 *
 * Both are DERIVED, so a test asserts on them instead of re-walking a
 * `documentChanges`-or-`changes` union whose shape the framework's egress may
 * choose freely (a full-range replace and a minimal diff produce different
 * edit lists for the same push). {@link params} stays available for the cases
 * that need the version, the label or the file-operation kinds.
 */
export interface AppliedEdit {
   /** The request as it arrived, unmodified. */
   readonly params: ApplyWorkspaceEditParams;
   /**
    * Every URI the edit addresses, `documentChanges` first then `changes` keys.
    * A rename contributes both its old and its new URI. This is what
    * {@link LspServerConnection.nextAppliedEdit} matches against, and asserting
    * on it is how a test pins WHICH URI the egress chose — the question a
    * symlinked or renamed document makes non-trivial.
    */
   readonly uris: readonly string[];
   /**
    * Every text edit's `newText`, concatenated in edit order. A minimal diff
    * therefore yields only the changed fragments, NOT the resulting document —
    * so assert `toContain` on a fragment the push must carry rather than
    * equality against a whole file. Snippet edits contribute nothing, having no
    * `newText`.
    */
   readonly text: string;
}

/** Options for {@link LspServerConnection.nextAppliedEdit}. */
export interface NextAppliedEditOptions {
   /**
    * Index into {@link LspServerConnection.appliedEdits} to search from,
    * inclusive — the same contract as {@link NextDiagnosticsOptions.fromIndex},
    * and needed for the same reason: one write can fan out to several pushes.
    */
   readonly fromIndex?: number;
   /** Reject after this long. Defaults to the in-process publish timeout. */
   readonly timeoutMs?: number;
   /**
    * Additional predicate the edit must satisfy. The framework coalesces
    * pushes per URI and skips ones that diff to nothing, so a URI match alone
    * can resolve on a sync that carries none of the text under test; narrow
    * with e.g. `edit => edit.text.includes('…')`.
    */
   readonly match?: (edit: AppliedEdit) => boolean;
}

/** Every URI a {@link WorkspaceEdit} addresses, in `documentChanges` then `changes` order. */
function editedUris(edit: WorkspaceEdit): string[] {
   const uris: string[] = [];
   for (const change of edit.documentChanges ?? []) {
      if ('textDocument' in change) {
         uris.push(change.textDocument.uri);
      } else if ('oldUri' in change) {
         uris.push(change.oldUri, change.newUri);
      } else {
         uris.push(change.uri);
      }
   }
   uris.push(...Object.keys(edit.changes ?? {}));
   return uris;
}

/** Every text edit's `newText` in a {@link WorkspaceEdit}, concatenated in edit order. */
function insertedText(edit: WorkspaceEdit): string {
   const parts: string[] = [];
   for (const change of edit.documentChanges ?? []) {
      if ('edits' in change) {
         for (const textEdit of change.edits) {
            if ('newText' in textEdit) {
               parts.push(textEdit.newText);
            }
         }
      }
   }
   for (const textEdits of Object.values(edit.changes ?? {})) {
      for (const textEdit of textEdits) {
         parts.push(textEdit.newText);
      }
   }
   return parts.join('');
}

/**
 * The in-process LSP transport seam — a real `Connection` over the in-memory
 * {@link makeDuplexStreamPair}, plus the client side, the diagnostics capture,
 * and the typed request facades — with NO services attached. It is the lower
 * half of `makeLspHarness`, factored out so a caller can OWN the services
 * tree: build the tree around {@link serverConnection} (`createXxxServices({
 * connection })`) and attach the LSP head (`startLanguageServer(shared)`),
 * exactly as a real server entrypoint does. That inversion — the connection is
 * an input to the one tree, every head attaches to `shared` — is what lets
 * multiple protocol heads share a single tree.
 *
 * `serverConnection` is the **seam handed to the caller** (it builds services
 * onto it); `client` is the raw client seam + escape hatch for unwrapped
 * requests; `diagnostics` is the append-only capture of every
 * `publishDiagnostics` notification in arrival order; the lifecycle/sync/feature
 * members are thin facades over `client` reusing `vscode-languageserver-protocol`
 * types. Satisfies the uniform {@link Harness} contract.
 */
export interface LspServerConnection extends Harness {
   /**
    * Seam: the server-side `Connection`, NOT yet attached to a server. The caller
    * composes the services tree onto it (`createXxxServices({ connection })`) and
    * calls `startLanguageServer(services.shared)`, which wires the LSP handlers
    * and calls `connection.listen()`.
    */
   readonly serverConnection: Connection;
   /** Seam: the raw client connection over the in-memory wire; escape hatch for unwrapped requests. */
   readonly client: ProtocolConnection;
   /**
    * Capture: every `publishDiagnostics` notification, in arrival order;
    * append-only, never cleared. Stays live for the connection's whole lifetime,
    * including while {@link nextDiagnostics} waits are armed.
    *
    * The right tool for a fan-out: record `diagnostics.length` before acting,
    * then read the tail. Note the workspace init does NOT validate, so this is
    * empty after `initialize` — a baseline has to be provoked by an edit or an
    * explicit validating read.
    */
   readonly diagnostics: ReadonlyArray<PublishDiagnosticsParams>;
   /**
    * Capture: every server→client `workspace/applyEdit`, in arrival order;
    * append-only, never cleared. The sibling of {@link diagnostics} for the
    * EGRESS direction — `applyEditToLanguageClient` is a framework path that
    * every adopter whose non-LSP client edits an open file goes through, and
    * without this capture the request is unobservable and unanswered.
    *
    * Read as a fan-out, exactly like `diagnostics`: record `appliedEdits.length`
    * before acting, then read the tail. One write can produce several pushes
    * (one per language-client URI a document is open under) and their order is
    * not the caller's to control.
    *
    * **The wire is answered `{ applied: true }` by default**, which is what a
    * real language client does; {@link setApplyEditHandler} changes that, and
    * without a handler registered at all the server's request would fail as an
    * unhandled method.
    */
   readonly appliedEdits: ReadonlyArray<AppliedEdit>;

   /**
    * Drive the real LSP `initialize` → `initialized` handshake and return the
    * `InitializeResult`. Defaults to no workspace folders (no async
    * discovery/build, nothing racy to await); pass `workspaceFolders` for the
    * fully faithful path. Required before any other request.
    */
   initialize(params?: Partial<InitializeParams>): Promise<InitializeResult>;
   /**
    * Drive the graceful `shutdown` request and await its response. The `exit`
    * notification is intentionally NOT sent in-process: there is no server
    * process to terminate, and `dispose()` owns teardown.
    */
   shutdown(): Promise<void>;

   /**
    * Send `textDocument/didOpen` for `uri` with full `text`. `languageId` is
    * required — an empty/unregistered id yields a document the server never
    * associates with a language (silent no-diagnostics). `version` defaults to 1.
    */
   openDocument(uri: string, text: string, languageId: string, version?: number): void;
   /** Send `textDocument/didChange` for `uri` as a single full-text replacement at `version`. */
   changeDocument(uri: string, text: string, version: number): void;

   /**
    * Request completion at `position`, normalized to a `CompletionList`
    * (`CompletionItem[]`/`null` collapse to one). `item.textEdit` keeps its
    * `InsertReplaceEdit | TextEdit` union.
    */
   completion(uri: string, position: Position): Promise<CompletionList>;
   /** Request hover at `position`. */
   hover(uri: string, position: Position): Promise<Hover | null>;
   /** Request full-document semantic tokens for `uri`. */
   semanticTokens(uri: string): Promise<SemanticTokens | null>;

   /**
    * Resolve with the diagnostics of the next `publishDiagnostics` matching
    * `uri`. Reject on timeout so a missing publish fails fast instead of hanging.
    * Register the returned promise BEFORE the triggering `openDocument`/
    * `changeDocument`.
    *
    * Composes freely with {@link diagnostics} and with other waiters — all of
    * them are served from one subscription, so arming a wait does not switch the
    * capture off.
    *
    * **Pass `{ fromIndex }` when a single action fans out to SEVERAL
    * documents**, as a cross-document rebuild does: without it this method
    * answers "the next publish for one URI", which is the wrong question when
    * the order of a cascade's publishes is not under the test's control, and it
    * also has to be armed before the action. Record `diagnostics.length` first
    * and hand it over; {@link diagnostics} remains available for a test that
    * wants the whole tail rather than one URI's entry in it.
    */
   nextDiagnostics(uri: string, timeoutMsOrOptions?: number | NextDiagnosticsOptions): Promise<Diagnostic[]>;

   /**
    * Resolve with the next captured `workspace/applyEdit` that addresses `uri`
    * (and satisfies {@link NextAppliedEditOptions.match}, when given). Reject on
    * timeout so a missing push fails fast instead of hanging.
    *
    * The egress mirror of {@link nextDiagnostics}, with the same
    * `fromIndex` discipline and the same composition guarantee: every waiter is
    * served from one request handler, so arming a wait does not switch the
    * {@link appliedEdits} capture off.
    *
    * **An egress push is asynchronous well past the call that triggers it** —
    * the framework coalesces per URI and drives the sync from a build-phase
    * settle, so a `ModelService.update` resolves long before the push is sent.
    * Record `appliedEdits.length`, drive the edit, then await this; reading the
    * capture on the line after the write proves nothing.
    */
   nextAppliedEdit(uri: string, timeoutMsOrOptions?: number | NextAppliedEditOptions): Promise<AppliedEdit>;

   /**
    * Decide what the client answers `workspace/applyEdit` with, so a test can
    * drive the framework's rejection path — `applied: false` invalidates the
    * text shadow and makes the retry a full-range replace, which is otherwise
    * unreachable over a real wire. The capture is unaffected: the edit is
    * recorded before the handler runs.
    *
    * Throwing from the handler surfaces to the server as an RPC failure, which
    * is the other branch (`applyEditToLanguageClient` invalidates and rethrows).
    */
   setApplyEditHandler(handler: (params: ApplyWorkspaceEditParams) => ApplyWorkspaceEditResult): void;

   /**
    * Release every resource: the diagnostics and applyEdit subscriptions, the
    * client + server connections, the underlying stream pair. Idempotent. Does
    * NOT send `shutdown`/`exit` — that is the explicit {@link shutdown} method.
    */
   dispose(): void;
}

/**
 * Build the in-process LSP transport seam (server `Connection` + client + wire +
 * diagnostics capture + typed facades) WITHOUT attaching a server. The caller
 * composes a services tree onto {@link LspServerConnection.serverConnection} and
 * calls `startLanguageServer`, then drives requests through the facades.
 *
 * `makeLspHarness` is the all-in-one convenience built on this primitive
 * (it owns the `createServices` callback + `startLanguageServer` + `buildWorkspace`);
 * use this primitive directly when the CALLER must own the tree — e.g. to attach
 * additional protocol heads (data-server, GLSP) onto the same `shared` services.
 */
export function makeLspServerConnection(): LspServerConnection {
   const pair = makeDuplexStreamPair();

   // No-op watchDog: in-process, no LSP lifecycle event (parent-pid liveness, the
   // `exit` notification, …) may exit the host test runner — `dispose()` owns
   // teardown. See the import note on why the node `createConnection` is unusable.
   const watchDog: WatchDog = {
      shutdownReceived: false,
      initialize: () => undefined,
      exit: () => undefined
   };
   // Server side reads what the client wrote (clientToServer) and writes what the
   // client reads (serverToClient), over a ProtocolConnection on the in-memory pair.
   const serverConnection: Connection = createConnection(
      logger =>
         createProtocolConnection(new StreamMessageReader(pair.clientToServer), new StreamMessageWriter(pair.serverToClient), logger),
      watchDog,
      ProposedFeatures.all
   );

   // Client side mirrors the directions: reads serverToClient, writes clientToServer.
   const client = createProtocolConnection(new StreamMessageReader(pair.serverToClient), new StreamMessageWriter(pair.clientToServer));
   client.listen();

   const diagnostics: PublishDiagnosticsParams[] = [];
   /**
    * Waiters armed by {@link LspServerConnection.nextDiagnostics}, fanned out to
    * from the ONE handler below.
    *
    * **There must be exactly one `onNotification` per method.** `vscode-jsonrpc`
    * keeps a single handler per notification type, so a second registration
    * silently DISPLACES the first — and disposing that second one then leaves no
    * handler at all. Giving the capture and the per-URI waiters separate
    * subscriptions therefore makes arming a wait switch the always-on capture
    * off, and `diagnostics` reads empty in any suite that also awaits a publish
    * — which is every suite that drives an edit.
    */
   const diagnosticsWaiters: Array<(params: PublishDiagnosticsParams) => boolean> = [];
   const diagnosticsSubscription = client.onNotification(PublishDiagnosticsNotification.type, params => {
      diagnostics.push(params);
      // Iterate a copy: a resolving waiter removes itself from the live array.
      for (const waiter of [...diagnosticsWaiters]) {
         if (waiter(params)) {
            const at = diagnosticsWaiters.indexOf(waiter);
            if (at >= 0) {
               diagnosticsWaiters.splice(at, 1);
            }
         }
      }
   });

   const appliedEdits: AppliedEdit[] = [];
   /**
    * Waiters armed by {@link LspServerConnection.nextAppliedEdit}, fanned out to
    * from the ONE handler below — `vscode-jsonrpc` keeps a single handler per
    * REQUEST type just as it does per notification type, so a second
    * `onRequest` would displace this one and leave the server's `applyEdit`
    * unanswered.
    */
   const appliedEditWaiters: Array<(edit: AppliedEdit) => boolean> = [];
   let applyEditHandler: (params: ApplyWorkspaceEditParams) => ApplyWorkspaceEditResult = () => ({ applied: true });
   const appliedEditSubscription = client.onRequest(ApplyWorkspaceEditRequest.type, (params: ApplyWorkspaceEditParams) => {
      const edit: AppliedEdit = { params, uris: editedUris(params.edit), text: insertedText(params.edit) };
      // Record BEFORE the handler runs, so a handler that rejects the edit or
      // throws still leaves the push observable — the send is what the egress
      // assertion is about.
      appliedEdits.push(edit);
      for (const waiter of [...appliedEditWaiters]) {
         if (waiter(edit)) {
            const at = appliedEditWaiters.indexOf(waiter);
            if (at >= 0) {
               appliedEditWaiters.splice(at, 1);
            }
         }
      }
      return applyEditHandler(params);
   });

   let disposed = false;

   return {
      serverConnection,
      client,
      diagnostics,
      appliedEdits,

      async initialize(params?: Partial<InitializeParams>): Promise<InitializeResult> {
         const initializeParams: InitializeParams = {
            processId: process.pid,
            rootUri: null,
            workspaceFolders: null,
            capabilities: {},
            ...params
         };
         const result = await client.sendRequest(InitializeRequest.type, initializeParams);
         // Await the notification send so its write fully drains before
         // `initialize()` resolves. `sendNotification` is fire-and-forget at the
         // protocol level but returns a Promise that settles when the bytes hit
         // the stream; without the await, a test that disposes shortly after
         // `initialize()` (with no intervening awaited request) would destroy the
         // streams mid-write — a write-after-destroy rejection.
         await client.sendNotification(InitializedNotification.type, {});
         return result;
      },

      async shutdown(): Promise<void> {
         // No `exit` NOTIFICATION: in-process its only effect would be the no-op
         // watchDog, and being fire-and-forget it would still be draining when
         // `dispose()` destroys the streams — racing teardown into a
         // write-after-destroy. The subprocess smoke covers the real
         // `exit`/process-exit path.
         await client.sendRequest(ShutdownRequest.type, undefined);
      },

      openDocument(uri: string, text: string, languageId: string, version?: number): void {
         client.sendNotification(DidOpenTextDocumentNotification.type, {
            textDocument: {
               uri,
               languageId,
               version: version ?? INITIAL_DOCUMENT_VERSION,
               text
            }
         });
      },

      changeDocument(uri: string, text: string, version: number): void {
         client.sendNotification(DidChangeTextDocumentNotification.type, {
            textDocument: { uri, version },
            contentChanges: [{ text }]
         });
      },

      async completion(uri: string, position: Position): Promise<CompletionList> {
         const response = await client.sendRequest(CompletionRequest.type, {
            textDocument: { uri },
            position
         });
         if (response === null) {
            return { isIncomplete: false, items: [] };
         }
         if (Array.isArray(response)) {
            return { isIncomplete: false, items: response };
         }
         return response;
      },

      hover(uri: string, position: Position): Promise<Hover | null> {
         return client.sendRequest(HoverRequest.type, { textDocument: { uri }, position });
      },

      semanticTokens(uri: string): Promise<SemanticTokens | null> {
         return client.sendRequest(SemanticTokensRequest.type, { textDocument: { uri } });
      },

      nextDiagnostics(uri: string, timeoutMsOrOptions?: number | NextDiagnosticsOptions): Promise<Diagnostic[]> {
         const options: NextDiagnosticsOptions =
            typeof timeoutMsOrOptions === 'number' ? { timeoutMs: timeoutMsOrOptions } : (timeoutMsOrOptions ?? {});
         const timeoutMs = options.timeoutMs ?? DEFAULT_DIAGNOSTICS_TIMEOUT_MS;
         const { fromIndex } = options;
         if (fromIndex !== undefined) {
            // Replay from the capture first: the publish this call is asking
            // about may already have arrived, and a waiter can only ever see
            // publishes that come later.
            const captured = diagnostics.slice(Math.max(0, fromIndex)).find(params => params.uri === uri);
            if (captured) {
               return Promise.resolve(captured.diagnostics);
            }
         }
         // A waiter on the ONE subscription above, never a second
         // `onNotification` — see `diagnosticsWaiters` for why that matters.
         // Without `fromIndex`, already-captured publishes are NOT replayed.
         return new Promise<Diagnostic[]>((resolve, reject) => {
            const waiter = (params: PublishDiagnosticsParams): boolean => {
               if (params.uri !== uri) {
                  return false;
               }
               clearTimeout(timer);
               resolve(params.diagnostics);
               return true;
            };
            const timer = setTimeout(() => {
               const at = diagnosticsWaiters.indexOf(waiter);
               if (at >= 0) {
                  diagnosticsWaiters.splice(at, 1);
               }
               reject(new Error(`Timed out waiting for diagnostics for ${uri}`));
            }, timeoutMs);
            diagnosticsWaiters.push(waiter);
         });
      },

      nextAppliedEdit(uri: string, timeoutMsOrOptions?: number | NextAppliedEditOptions): Promise<AppliedEdit> {
         const options: NextAppliedEditOptions =
            typeof timeoutMsOrOptions === 'number' ? { timeoutMs: timeoutMsOrOptions } : (timeoutMsOrOptions ?? {});
         const timeoutMs = options.timeoutMs ?? DEFAULT_DIAGNOSTICS_TIMEOUT_MS;
         const { fromIndex, match } = options;
         const matches = (edit: AppliedEdit): boolean => edit.uris.includes(uri) && (match?.(edit) ?? true);
         if (fromIndex !== undefined) {
            // Replay from the capture first, for the same reason
            // `nextDiagnostics` does: the push may already have arrived, and a
            // waiter only ever sees later ones.
            const captured = appliedEdits.slice(Math.max(0, fromIndex)).find(matches);
            if (captured) {
               return Promise.resolve(captured);
            }
         }
         return new Promise<AppliedEdit>((resolve, reject) => {
            const waiter = (edit: AppliedEdit): boolean => {
               if (!matches(edit)) {
                  return false;
               }
               clearTimeout(timer);
               resolve(edit);
               return true;
            };
            const timer = setTimeout(() => {
               const at = appliedEditWaiters.indexOf(waiter);
               if (at >= 0) {
                  appliedEditWaiters.splice(at, 1);
               }
               reject(new Error(`Timed out waiting for a workspace/applyEdit addressing ${uri}`));
            }, timeoutMs);
            appliedEditWaiters.push(waiter);
         });
      },

      setApplyEditHandler(handler: (params: ApplyWorkspaceEditParams) => ApplyWorkspaceEditResult): void {
         applyEditHandler = handler;
      },

      dispose(): void {
         if (disposed) {
            return;
         }
         disposed = true;
         appliedEditSubscription.dispose();
         diagnosticsSubscription.dispose();
         client.dispose();
         serverConnection.dispose();
         pair.dispose();
      }
   };
}
