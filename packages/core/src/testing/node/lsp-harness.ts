/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import type { LangiumSharedServices } from '@hydranium/langium/lsp';
import type { Connection } from 'vscode-languageserver/node';
import { IntegrityService } from '../../langium/integrity/index.js';
import { startLanguageServer } from '../../lsp/index.js';
import { buildWorkspaceProgrammatically, type WorkspaceFolderInput } from '../../langium/workspace/initialize-workspace.js';
import type { ServerSharedServicesMinimal } from '../../langium/shared-services.js';
import { makeLspServerConnection, type LspServerConnection } from './lsp-server-connection.js';

/**
 * The composed shared-services tree the `MakeLspHarnessOptions.createServices`
 * callback must return. It is both a framework {@link ServerSharedServicesMinimal}
 * (so the harness can drive {@link buildWorkspaceProgrammatically}) and a Langium
 * {@link LangiumSharedServices} (so the harness can hand it to
 * {@link startLanguageServer}, which wires the LSP handlers onto the connection).
 * Every real adopter tree (`createXxxServices(...).shared`) satisfies both.
 */
export type LspHarnessSharedServices = ServerSharedServicesMinimal & LangiumSharedServices;

/**
 * Configuration for {@link makeLspHarness}, in two forms.
 *
 * SINGLE-HEAD (`createServices`) — the all-in-one convenience: the harness OWNS
 * the transport and tree creation. It builds the in-process connection and hands
 * it to the adopter factory, which composes the shared services around it, e.g.
 * `connection => createMyLangServices({ connection }).shared`. The callback owns the
 * filesystem choice (EmptyFileSystem for didOpen-only tests, NodeFileSystem for
 * fixture-backed workspace tests) and any adopter modules.
 *
 * MULTI-HEAD (`connection` + `services`) — the symmetric "take the tree" form,
 * matching the data-server and GLSP harnesses, which attach to a caller-built
 * tree. Because Langium binds the connection INTO the tree at
 * `createXxxServices({ connection })`, the caller makes the wire first
 * ({@link makeLspServerConnection}), builds the ONE shared tree around its
 * `serverConnection`, then hands BOTH the wire and `.shared` to the harness — so
 * the SAME tree feeds the LSP head here and the other heads elsewhere. The
 * harness still attaches the LSP head ({@link startLanguageServer}) and owns the
 * wire's teardown via {@link LspHarness.dispose}.
 */
export type MakeLspHarnessOptions = LspHarnessCreateServicesOptions | LspHarnessAttachOptions;

/** SINGLE-HEAD form — the harness builds the transport and the tree. */
export interface LspHarnessCreateServicesOptions {
   /**
    * Compose the shared services against the supplied server {@link Connection}
    * (the server side of the in-process stream pair). Invoked once,
    * synchronously, before {@link startLanguageServer} wires the LSP handlers.
    */
   createServices: (connection: Connection) => LspHarnessSharedServices;
}

/** MULTI-HEAD form — the caller owns the transport and the tree; the harness attaches. */
export interface LspHarnessAttachOptions {
   /**
    * The in-process LSP transport the caller built ({@link makeLspServerConnection})
    * and composed the tree around. The harness drives its facades and owns its
    * teardown.
    */
   connection: LspServerConnection;
   /**
    * The composed shared services (`createXxxServices({ connection }).shared`)
    * built around `connection.serverConnection`. The harness attaches the LSP head
    * to it via {@link startLanguageServer}.
    */
   services: LspHarnessSharedServices;
}

/**
 * Wiring bundle returned by {@link makeLspHarness} — the in-process replacement
 * for the subprocess stdio smoke. It is the {@link LspServerConnection} transport
 * seam (real `Connection` over the in-memory wire, the diagnostics and
 * applyEdit captures, typed
 * `completion`/`hover`/`semanticTokens`/`nextDiagnostics`/`nextAppliedEdit`
 * facades, lifecycle `initialize`/`shutdown`, document-sync
 * `openDocument`/`changeDocument`, idempotent `dispose`) PLUS the two members the
 * all-in-one harness owns that the bare transport does not:
 *
 * - `services` — the **subject**, the composed shared-services tree the harness
 *   stood the LSP server up on (the harness created it via `createServices` and
 *   attached the server via `startLanguageServer`);
 * - `buildWorkspace` — the deterministic project-state seed.
 *
 * The transport's own `serverConnection` is intentionally NOT surfaced here. In
 * the single-head form the harness owns the connection, so a caller never needs
 * it; in the multi-head attach form the caller already holds the
 * {@link LspServerConnection} it passed in (and built the tree around its
 * `serverConnection`), so it never needs the harness to re-surface it.
 */
export type LspHarness = Omit<LspServerConnection, 'serverConnection'> & {
   /** Subject: the composed shared services running the in-process LSP server. */
   readonly services: ServerSharedServicesMinimal;
   /**
    * Deterministic project-state seed: awaits
    * {@link buildWorkspaceProgrammatically} (discovery + build every document to
    * `Validated`, awaited to settle).
    *
    * STANDALONE — it performs its own workspace init, so do NOT also call
    * {@link LspServerConnection.initialize} on the same harness. Per LSP,
    * `initialize` is once-only ("may only be sent once"); a second workspace init
    * cancels the first build. Building also publishes diagnostics over the
    * connection asynchronously, so a `dispose()` racing those is a known
    * limitation of this state-only path.
    *
    * **A test that needs BOTH project state AND live wire requests should call
    * `initialize({ workspaceFolders })` instead of this** — that settles the
    * workspace before resolving, so it is a single init with nothing racy left
    * to await. Combining the two is the failure mode worth naming, because it is
    * silent: the second init cancels the first and diagnostics are then never
    * published for ANY document, so every wire assertion times out pointing at
    * the transport rather than at the cause.
    */
   buildWorkspace(folders: WorkspaceFolderInput | ReadonlyArray<WorkspaceFolderInput>): Promise<void>;
};

/**
 * Await the workspace init that an `initialize({ workspaceFolders })` kicked
 * off, so the caller can use the workspace on return.
 *
 * This is the gate the transport's own `initialize` cannot provide: it holds
 * only the connection, while settling needs the services tree. Without it
 * **`initialize({ workspaceFolders })` returns with ZERO documents
 * registered**, because the `initialized` notification is fire-and-forget and
 * discovery has not run yet.
 *
 * **The landmark is {@link IntegrityService.SettledState}, NOT
 * `DocumentState.Validated`.** The init build links and indexes but does not
 * validate — which is precisely why {@link buildWorkspaceProgrammatically}
 * exists and appends its own `{ validation: true }` pass. Waiting on `Validated`
 * hangs forever against a workspace nobody asked to validate. Linking, not
 * validation, is what "the workspace is usable" means.
 *
 * One await, deliberately. Queueing a no-op `WorkspaceLock.read` first does NOT
 * drain the init write — measured, and the read resolves immediately with no
 * documents registered, because the write is not yet enqueued when
 * `initialize()` returns. `waitUntil` does all the work, registering a
 * build-phase listener that a later build satisfies. An empty workspace folder
 * resolves rather than hanging.
 */
async function settleInitializedWorkspace(services: LspHarnessSharedServices): Promise<void> {
   await services.workspace.DocumentBuilder.waitUntil(IntegrityService.SettledState);
}

/**
 * Wire a real Langium LSP server through its real `Connection` and the LSP
 * wire **in-process** — no subprocess, no built binary. The in-process
 * replacement for the subprocess stdio smoke: same real connection +
 * lifecycle, built on the {@link makeLspServerConnection} transport primitive
 * and on {@link buildWorkspaceProgrammatically} for the deterministic workspace
 * seed.
 *
 * Two forms (see {@link MakeLspHarnessOptions}). SINGLE-HEAD (`createServices`):
 * the all-in-one convenience — the harness builds the transport, calls
 * `createServices` with its server connection, and attaches the LSP head.
 * MULTI-HEAD (`connection` + `services`): the symmetric "take the tree" form —
 * the caller built the wire ({@link makeLspServerConnection}) and the ONE shared
 * tree around it, and the harness attaches the LSP head to that `services` while
 * the data-server / GLSP heads attach to the same tree.
 *
 * This does NOT test provider *logic* — `langium/test` (`expectCompletion`,
 * `expectHover`, `validationHelper`, …, re-exported from
 * `@hydranium/core/testing`) already covers that by calling providers directly.
 * The harness owns the wire + lifecycle layer the provider-direct helpers skip:
 * `initialize`/`initialized`, the `didOpen`/`didChange` → `DocumentBuilder` →
 * `publishDiagnostics` round-trip over the wire, JSON-RPC serialization, and
 * `shutdown`/`exit`.
 */
export function makeLspHarness(options: MakeLspHarnessOptions): LspHarness {
   // Attach form: the caller owns the transport + tree. Convenience form: the
   // harness builds the transport and the adopter factory composes the tree.
   const transport = 'connection' in options ? options.connection : makeLspServerConnection();
   const services = 'connection' in options ? options.services : options.createServices(transport.serverConnection);
   // Wires the LSP handlers onto the transport's server connection and calls
   // `connection.listen()`.
   startLanguageServer(services);

   return {
      services,
      client: transport.client,
      diagnostics: transport.diagnostics,
      /**
       * The transport handshake, plus the workspace settle the transport cannot
       * do on its own — see {@link settleInitializedWorkspace}. Only when
       * `workspaceFolders` are actually supplied: the no-folders default has no
       * discovery to wait for.
       *
       * With this, `initialize({ workspaceFolders })` is the single call a test
       * needing BOTH project state and live wire requests should make — the path
       * {@link LspHarness.buildWorkspace} points at. Do NOT combine the two:
       * they are separate workspace inits, the second cancels the first, and the
       * observable result is that diagnostics are never published at all — for
       * any document, so every assertion times out accusing the transport.
       *
       * **What the settle is and is not needed for, measured rather than
       * assumed.** It matters for a test that INSPECTS STATE after initialize:
       * without it there are zero documents registered on return. It is NOT
       * needed by a test that awaits a wire round-trip first — such a suite
       * passes with the settle removed, because awaiting `nextDiagnostics`
       * incidentally gives discovery time to finish. So this closes a footgun
       * rather than fixing a failing test; do not expect removing it to turn
       * anything red.
       */
      initialize: async params => {
         const result = await transport.initialize(params);
         if (params?.workspaceFolders && params.workspaceFolders.length > 0) {
            await settleInitializedWorkspace(services);
         }
         return result;
      },
      shutdown: transport.shutdown,
      openDocument: transport.openDocument,
      changeDocument: transport.changeDocument,
      completion: transport.completion,
      hover: transport.hover,
      semanticTokens: transport.semanticTokens,
      nextDiagnostics: transport.nextDiagnostics,
      appliedEdits: transport.appliedEdits,
      nextAppliedEdit: transport.nextAppliedEdit,
      setApplyEditHandler: transport.setApplyEditHandler,
      buildWorkspace: folders => buildWorkspaceProgrammatically(services, folders),
      dispose: transport.dispose
   };
}
